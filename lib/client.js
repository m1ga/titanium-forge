'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const tar = require('tar-fs');
const { WebSocket } = require('ws');
const { buildManifest } = require('./manifest');

// Control requests get a hard deadline so a dead daemon IP fails fast instead
// of hanging on TCP timeouts. The manifest call gets a longer one — the first
// sync of a big project makes the daemon hash every file it has. Uploads get
// none: a large project over slow wifi is legitimately slow.
const REQUEST_TIMEOUT_MS = 30_000;
const MANIFEST_TIMEOUT_MS = 5 * 60_000;

function authHeaders(token) {
  return token ? { 'x-tiforge-token': token } : {};
}

// /projects/<name>/<sub> on the daemon. `dir` (forge.hosts.<name>.dir) is an
// absolute path on the daemon machine that replaces its own project root; the
// daemon still appends the project name to it.
function projectUrl(base, name, sub, dir) {
  const u = new URL(`/projects/${encodeURIComponent(name)}/${sub}`, base);
  if (dir) u.searchParams.set('dir', dir);
  return u;
}

async function doFetch(method, url, init, timeoutMs) {
  try {
    const res = await fetch(url, {
      method,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      ...init,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).error || text;
      } catch {}
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`invalid JSON response: ${e.message}`);
    }
  } catch (e) {
    if (e.name === 'TimeoutError') {
      throw new Error(`request timed out after ${timeoutMs / 1000}s: ${method} ${url.pathname}`);
    }
    // undici wraps network errors in TypeError("fetch failed") — surface the
    // useful part (ECONNREFUSED, EHOSTUNREACH, ...) instead
    const cause = e.cause;
    if (cause) throw new Error(cause.message || cause.errors?.[0]?.message || e.message);
    throw e;
  }
}

function httpJson(method, url, { token, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return doFetch(
    method,
    url,
    {
      headers: {
        ...authHeaders(token),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    timeoutMs
  );
}

function httpStream(method, url, { token } = {}, stream) {
  return doFetch(
    method,
    url,
    {
      headers: { ...authHeaders(token), 'content-type': 'application/gzip' },
      body: Readable.toWeb(stream),
      duplex: 'half',
    },
    0
  );
}

// The hash cache is a property of the local project dir only (it just avoids
// re-hashing unchanged files), so it is keyed by project path, not by host.
function cachePath(projectDir) {
  const key = crypto.hash('sha1', path.resolve(projectDir), 'hex');
  return path.join(os.homedir(), '.tiforge', 'cache', key + '.json');
}

function loadCache(projectDir) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(projectDir), 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(projectDir, manifest) {
  const file = cachePath(projectDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest));
  } catch {
    // cache is an optimization only — never fail a sync over it
  }
}

async function ping({ url, token }) {
  return httpJson('GET', new URL('/ping', url), { token });
}

// Kills the running build and cancels all queued ones on the daemon.
async function cancelBuilds({ url, token, log = () => {} }) {
  const r = await httpJson('POST', new URL('/builds/cancel', url), { token, body: {} });
  const cancelled = r.cancelled || [];
  log(
    cancelled.length
      ? `cancelled ${cancelled.length} remote build(s): ${cancelled.join(', ')}`
      : 'no remote builds to cancel'
  );
  return r;
}

// Cancels one build on the daemon: kills it if running, drops it if queued.
async function cancelBuild({ url, token, buildId }) {
  const u = new URL(`/builds/${encodeURIComponent(buildId)}/cancel`, url);
  return httpJson('POST', u, { token, body: {} });
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' kB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Returns an onProgress callback for syncProject that renders a live
// progress line. On a TTY the line updates in place; otherwise it prints
// a plain line every 25%.
function renderProgress(prefix, out = process.stdout) {
  let lastTime = 0;
  let lastPct = -25;
  return (p) => {
    const done = p.sentFiles >= p.totalFiles;
    const pct = p.totalBytes ? Math.min(100, Math.round((p.sentBytes / p.totalBytes) * 100)) : 100;
    const text = `uploading ${p.sentFiles}/${p.totalFiles} file(s)  ${fmtBytes(
      Math.min(p.sentBytes, p.totalBytes)
    )}/${fmtBytes(p.totalBytes)}  ${pct}%`;
    if (out.isTTY) {
      const now = Date.now();
      if (!done && now - lastTime < 100) return;
      lastTime = now;
      out.write('\r\x1b[K' + prefix + text + (done ? '\n' : ''));
    } else {
      if (!done && pct - lastPct < 25) return;
      if (done && lastPct >= 100) return;
      lastPct = done ? 100 : pct;
      out.write(prefix + text + '\n');
    }
  };
}

// Manifest-diff sync: send our manifest, the daemon answers with what it is
// missing, we upload only those files as one gzipped tar stream.
async function syncProject({
  url,
  token,
  name,
  projectDir,
  dir = null,
  exclude = [],
  log = () => {},
  onProgress = null,
}) {
  // In an Alloy project, Resources/ is generated from app/ by the alloy
  // compiler during the remote build — syncing our (possibly stale,
  // other-platform) copy would poison the remote build. build/ is likewise
  // never synced (default excludes). purge tells the daemon to drop any
  // Resources/ it received from older tiforge versions.
  const isAlloy =
    fs.existsSync(path.join(projectDir, 'app', 'controllers')) ||
    fs.existsSync(path.join(projectDir, 'app', 'config.json'));
  if (isAlloy) {
    exclude = [...exclude, '/Resources'];
    log('alloy project — Resources/ is generated remotely and not synced');
  }

  if (dir) log(`remote dir: ${dir.replace(/[/\\]+$/, '')}/${name}`);

  const manifest = buildManifest(projectDir, { exclude, cache: loadCache(projectDir) });
  saveCache(projectDir, manifest);

  const total = Object.keys(manifest).length;
  const diff = await httpJson('POST', projectUrl(url, name, 'manifest', dir), {
    token,
    body: { files: manifest, exclude, purge: isAlloy ? ['Resources'] : [] },
    timeoutMs: MANIFEST_TIMEOUT_MS,
  });

  const needed = diff.needed || [];
  const deleted = diff.deleted || [];
  if (needed.length) {
    const totalBytes = needed.reduce((s, rel) => s + ((manifest[rel] && manifest[rel].size) || 0), 0);
    log(`uploading ${needed.length}/${total} file(s), ${fmtBytes(totalBytes)}...`);
    let sentBytes = 0;
    let sentFiles = 0;
    const report = (file) =>
      onProgress &&
      onProgress({ sentBytes, totalBytes, sentFiles, totalFiles: needed.length, file });
    const pack = tar.pack(projectDir, {
      entries: needed,
      // count bytes as files are read into the tar stream
      mapStream: (stream, header) => {
        stream.on('data', (d) => {
          sentBytes += d.length;
          report(header.name);
        });
        stream.on('end', () => {
          sentFiles++;
          report(header.name);
        });
        return stream;
      },
    });
    await httpStream(
      'POST',
      projectUrl(url, name, 'files', dir),
      { token },
      pack.pipe(zlib.createGzip())
    );
    sentBytes = totalBytes;
    sentFiles = needed.length;
    report();
  }
  log(`in sync (${needed.length} uploaded, ${deleted.length} deleted, ${total} total)`);
  return { needed: needed.length, deleted: deleted.length, total };
}

// Triggers a remote build and streams its log until it exits.
// onLine receives one log line at a time. Resolves with { buildId, exitCode }.
// Aborting `signal` cancels the build on the daemon (the front ends wire it
// to Ctrl+C); the stream then ends with the daemon's exit frame as usual.
function remoteBuild({
  url,
  token,
  name,
  dir = null,
  args = [],
  signal = null,
  onLine = () => {},
  log = () => {},
}) {
  if (signal && signal.aborted) {
    return Promise.reject(new Error('cancelled before the remote build was started'));
  }
  return httpJson('POST', projectUrl(url, name, 'build', dir), {
    token,
    body: { args },
  }).then(
    ({ buildId, ahead }) =>
      new Promise((resolve, reject) => {
        log(
          ahead > 0
            ? `remote build ${buildId} queued — ${ahead} build(s) ahead of it`
            : `remote build ${buildId} starting (${args.join(' ')})`
        );
        const wsUrl = new URL(`/builds/${buildId}/log`, url);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(wsUrl, { headers: authHeaders(token) });
        let buf = '';
        let settled = false;

        const onAbort = () => {
          log(`cancelling remote build ${buildId}...`);
          cancelBuild({ url, token, buildId }).catch((e) => {
            if (settled) return;
            settled = true;
            ws.close();
            reject(new Error(`could not cancel remote build ${buildId}: ${e.message}`));
          });
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        ws.on('close', () => signal && signal.removeEventListener('abort', onAbort));

        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }
          if (msg.type === 'log') {
            buf += msg.data;
            let i;
            while ((i = buf.indexOf('\n')) !== -1) {
              onLine(buf.slice(0, i).replace(/\r$/, ''));
              buf = buf.slice(i + 1);
            }
          } else if (msg.type === 'status') {
            if (msg.status === 'running') log('remote build running...');
          } else if (msg.type === 'exit') {
            if (buf) onLine(buf);
            settled = true;
            ws.close();
            resolve({ buildId, exitCode: msg.code });
          }
        });
        ws.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        ws.on('close', () => {
          if (!settled) {
            settled = true;
            reject(new Error('log stream closed before the build finished'));
          }
        });
      })
  );
}

// Full flow against one host: sync, then build.
async function runRemote({
  host,
  name,
  projectDir,
  exclude,
  buildArgs,
  signal,
  log,
  onLine,
  onProgress,
}) {
  const opts = { url: host.url, token: host.token, name, dir: host.dir || null };
  await syncProject({ ...opts, projectDir, exclude, log, onProgress });
  return remoteBuild({ ...opts, args: buildArgs, signal, onLine, log });
}

module.exports = {
  ping,
  cancelBuild,
  cancelBuilds,
  syncProject,
  remoteBuild,
  runRemote,
  renderProgress,
  fmtBytes,
};
