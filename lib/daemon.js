'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const tar = require('tar-fs');
const { WebSocketServer } = require('ws');
const { buildManifest, diffManifests } = require('./manifest');

const MAX_LOG_BYTES = 10 * 1024 * 1024; // per build, oldest chunks dropped first
const MAX_FINISHED_BUILDS = 20; // older finished builds (and their logs) are forgotten
const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;

function readJsonBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Manifest entries come in three kinds (see lib/manifest.js buildManifest).
function entryKind(entry) {
  return entry.dir ? 'dir' : entry.link ? 'link' : 'file';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function startDaemon(opts = {}) {
  const port = opts.port ?? 7331; // 0 = ephemeral (server.address().port)
  const root = path.resolve(opts.root || path.join(os.homedir(), '.tiforge', 'projects'));
  const token = opts.token || null;
  const buildCmd = opts.buildCmd || ['ti'];
  const buildTimeoutMs = (opts.buildTimeoutMinutes || 30) * 60 * 1000;
  const log = opts.log || ((...a) => console.log('[tiforge]', ...a));
  const exit = opts.exit || ((code) => process.exit(code)); // tests inject a stub
  const cacheDir = path.join(root, '.manifest-cache');

  fs.mkdirSync(root, { recursive: true });

  const builds = new Map();
  const manifestCache = new Map(); // projectDir -> last computed manifest
  let buildSeq = 0;
  let queue = Promise.resolve(); // builds run one at a time
  let queueDepth = 0;

  function authorized(req) {
    return !token || req.headers['x-tiforge-token'] === token;
  }

  // Projects are mirrored into <root>/<projectName>. A client may override the
  // root per request with ?dir=<absolute path> (forge.hosts.<name>.dir), which
  // is why the project name is validated: it is the only untrusted path
  // segment appended to it.
  function projectDirFor(projectName, baseDir) {
    if (!PROJECT_NAME_RE.test(projectName)) return null;
    return path.join(baseDir ? path.resolve(baseDir) : root, projectName);
  }

  // The manifest cache (size+mtime -> hash per mirror entry) is also kept on
  // disk, so a daemon restart does not re-hash every mirror on the first
  // sync. It is an optimisation only: every failure here means re-hashing.
  function cacheFile(projectDir) {
    return path.join(cacheDir, crypto.hash('sha1', projectDir, 'hex') + '.json');
  }

  function loadManifestCache(projectDir) {
    let cached = manifestCache.get(projectDir);
    if (!cached) {
      try {
        cached = JSON.parse(fs.readFileSync(cacheFile(projectDir), 'utf8'));
      } catch {
        cached = {};
      }
      manifestCache.set(projectDir, cached);
    }
    return cached;
  }

  function saveManifestCache(projectDir) {
    const file = cacheFile(projectDir);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(manifestCache.get(projectDir) || {}));
      fs.renameSync(file + '.tmp', file);
    } catch {}
  }

  function dropManifestCacheFile(projectDir) {
    try {
      fs.rmSync(cacheFile(projectDir), { force: true });
    } catch {}
  }

  function removeFile(projectDir, rel) {
    const abs = path.join(projectDir, rel);
    try {
      fs.unlinkSync(abs);
    } catch (e) {
      // manifest entries can be empty directories (EISDIR on Linux, EPERM on macOS)
      if (e.code !== 'EISDIR' && e.code !== 'EPERM') return;
      try {
        fs.rmdirSync(abs);
      } catch {
        return;
      }
    }
    // prune now-empty parent directories
    let dir = path.dirname(abs);
    while (dir.startsWith(projectDir + path.sep)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  function broadcast(build, msg) {
    const data = JSON.stringify(msg);
    for (const ws of build.subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  function append(build, chunk) {
    build.chunks.push(chunk);
    build.logBytes += chunk.length;
    while (build.logBytes > MAX_LOG_BYTES && build.chunks.length > 1) {
      build.logBytes -= build.chunks.shift().length;
    }
    broadcast(build, { type: 'log', data: chunk });
  }

  function finish(build, code) {
    if (build.status === 'done' || build.status === 'error') return;
    build.status = code === 0 ? 'done' : 'error';
    build.exitCode = code;
    log(`build ${build.id} finished with exit code ${code}`);
    broadcast(build, { type: 'exit', code });
    for (const ws of build.subscribers) ws.close();
    build.subscribers.clear();
    pruneFinished();
  }

  // Every build keeps up to MAX_LOG_BYTES of log for late subscribers; a
  // daemon that runs for weeks would otherwise hold every log it ever saw.
  function pruneFinished() {
    const finished = [...builds.values()].filter((b) => b.status === 'done' || b.status === 'error');
    for (const b of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_BUILDS))) {
      builds.delete(b.id);
    }
  }

  // Kills the whole process tree (ti spawns xcodebuild etc.), which is why
  // builds run detached in their own process group on POSIX.
  function killBuild(build, signal) {
    if (!build.child) return;
    try {
      if (process.platform !== 'win32') process.kill(-build.child.pid, signal);
      else build.child.kill(signal);
    } catch {}
  }

  function cancelMatching(match, reason) {
    const cancelled = [];
    for (const b of builds.values()) {
      if (match && !match(b)) continue;
      if (b.status === 'queued') {
        append(b, `tiforge: build cancelled — ${reason}\n`);
        finish(b, -1);
        cancelled.push(b.id);
      } else if (b.status === 'running') {
        append(b, `tiforge: build killed — ${reason}\n`);
        killBuild(b, 'SIGTERM');
        setTimeout(() => killBuild(b, 'SIGKILL'), 5000).unref();
        cancelled.push(b.id);
      }
    }
    return cancelled;
  }

  function runBuild(build) {
    if (build.status !== 'queued') return Promise.resolve(); // cancelled while waiting
    return new Promise((resolve) => {
      build.status = 'running';
      broadcast(build, { type: 'status', status: 'running' });
      // a headless daemon must never sit on an interactive prompt: stdin is
      // closed, --no-prompt is enforced, and a timeout kills runaway builds
      const extra = [];
      if (!build.args.includes('--no-prompt')) extra.push('--no-prompt');
      if (!build.args.includes('--no-progress-bars')) extra.push('--no-progress-bars');
      const argv = [...buildCmd.slice(1), 'build', ...build.args, ...extra];
      log(`build ${build.id}: ${buildCmd[0]} ${argv.join(' ')} (cwd ${build.projectDir})`);
      let child;
      try {
        child = spawn(buildCmd[0], argv, {
          cwd: build.projectDir,
          shell: process.platform === 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (e) {
        append(build, `tiforge: failed to start build: ${e.message}\n`);
        finish(build, -1);
        return resolve();
      }
      build.child = child;
      const timer = setTimeout(() => {
        append(build, `tiforge: build timed out after ${buildTimeoutMs / 60000} minutes — killing it\n`);
        killBuild(build, 'SIGTERM');
        setTimeout(() => killBuild(build, 'SIGKILL'), 10000).unref();
      }, buildTimeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        append(build, `tiforge: failed to start build: ${e.message}\n`);
        finish(build, -1);
        resolve();
      });
      child.stdout.on('data', (d) => append(build, d.toString()));
      child.stderr.on('data', (d) => append(build, d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(build, code == null ? -1 : code);
        resolve();
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) return sendJson(res, 401, { error: 'bad or missing x-tiforge-token' });
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const baseDir = url.searchParams.get('dir') || null;

    try {
      if (baseDir && !path.isAbsolute(baseDir)) {
        return sendJson(res, 400, { error: `dir must be an absolute path: ${baseDir}` });
      }

      if (req.method === 'GET' && p === '/ping') {
        return sendJson(res, 200, {
          name: os.hostname(),
          platform: process.platform,
          version: require('../package.json').version,
        });
      }

      let m;
      if (req.method === 'POST' && (m = p.match(/^\/projects\/([^/]+)\/manifest$/))) {
        const projectName = decodeURIComponent(m[1]);
        const projectDir = projectDirFor(projectName, baseDir);
        if (!projectDir) return sendJson(res, 400, { error: 'invalid project name' });
        const body = await readJsonBody(req);
        fs.mkdirSync(projectDir, { recursive: true });
        // generated dirs the client asked us to drop (e.g. Resources/ in an
        // alloy project, possibly synced by an older tiforge version)
        for (const rel of body.purge || []) {
          if (typeof rel !== 'string') continue;
          // resolve, then insist on a path strictly inside the project dir —
          // "", ".", "..", or an absolute path would otherwise hit the
          // mirror itself (or worse)
          const abs = path.resolve(projectDir, rel);
          if (!abs.startsWith(projectDir + path.sep)) continue;
          if (fs.existsSync(abs)) {
            log(`purging ${projectName}/${rel}`);
            fs.rmSync(abs, { recursive: true, force: true });
          }
        }
        const serverManifest = buildManifest(projectDir, {
          exclude: body.exclude || [],
          cache: loadManifestCache(projectDir),
        });
        const clientFiles = body.files || {};
        const { needed, deleted } = diffManifests(clientFiles, serverManifest);
        for (const rel of deleted) removeFile(projectDir, rel);
        // A path whose kind changed (file <-> symlink <-> empty dir) has to go
        // before the upload lands: tar-fs writes a file *through* an existing
        // symlink (corrupting the link target and re-uploading forever) and
        // fails with EISDIR when a file replaces a directory.
        for (const rel of needed) {
          const s = serverManifest[rel];
          const c = clientFiles[rel];
          if (s && c && entryKind(s) !== entryKind(c)) removeFile(projectDir, rel);
        }
        manifestCache.set(projectDir, serverManifest);
        saveManifestCache(projectDir);
        log(
          `manifest ${projectName}: ${needed.length} needed, ${deleted.length} deleted` +
            (baseDir ? ` (${projectDir})` : '')
        );
        return sendJson(res, 200, { needed, deleted });
      }

      if (req.method === 'POST' && (m = p.match(/^\/projects\/([^/]+)\/files$/))) {
        const projectName = decodeURIComponent(m[1]);
        const projectDir = projectDirFor(projectName, baseDir);
        if (!projectDir) return sendJson(res, 400, { error: 'invalid project name' });
        fs.mkdirSync(projectDir, { recursive: true });
        // validateSymlinks is off because it rejects links resolving through
        // other links — the normal structure of macOS/iOS .framework bundles
        // (Foo -> Versions/Current/Foo with Current -> A). We keep the part
        // that matters: links whose target escapes the project dir are
        // skipped (textual resolution, so in-tree link chains stay allowed).
        const landed = new Set(); // tar entry names, i.e. manifest keys
        const extract = tar.extract(projectDir, {
          validateSymlinks: false,
          map: (header) => {
            landed.add(header.name.replace(/\/+$/, ''));
            return header;
          },
          ignore: (fileName, header) => {
            if (!header || header.type !== 'symlink') return false;
            const dst = path.resolve(
              path.dirname(path.join(projectDir, header.name)),
              header.linkname
            );
            if (dst === projectDir || dst.startsWith(projectDir + path.sep)) return false;
            log(`WARNING ${projectName}: skipping symlink escaping the project dir: ${header.name} -> ${header.linkname}`);
            return true;
          },
        });
        // Only the entries that land get their cached hash dropped — a
        // truncated one included, its header was seen. Dropping the whole
        // cache instead made every sync that uploaded anything re-hash the
        // entire mirror. The on-disk copy goes first so that a crash
        // mid-upload cannot leave a stale cache for the next start.
        dropManifestCacheFile(projectDir);
        // pipeline (not .pipe) so a gunzip error — a corrupt or truncated
        // upload — answers the request instead of surfacing as an unhandled
        // stream error that takes the daemon down
        pipeline(req, zlib.createGunzip(), extract, (e) => {
          const cached = manifestCache.get(projectDir);
          if (cached) {
            for (const rel of landed) delete cached[rel];
            saveManifestCache(projectDir);
          }
          if (res.headersSent) return;
          if (e) sendJson(res, 400, { error: `extract failed: ${e.message}` });
          else sendJson(res, 200, { ok: true });
        });
        return;
      }

      if (req.method === 'POST' && (m = p.match(/^\/projects\/([^/]+)\/build$/))) {
        const projectName = decodeURIComponent(m[1]);
        const projectDir = projectDirFor(projectName, baseDir);
        if (!projectDir || !fs.existsSync(projectDir)) {
          return sendJson(res, 400, { error: 'unknown project — sync it first' });
        }
        const body = await readJsonBody(req);
        const id = `b${++buildSeq}-${crypto.randomBytes(3).toString('hex')}`;
        // a new build supersedes older builds of the same project — simulator
        // builds never exit on their own (ti keeps tailing the app log), so
        // without this they hold the queue until the build timeout
        const superseded = cancelMatching(
          (b) => b.project === projectName,
          `superseded by build ${id}`
        );
        if (superseded.length) {
          log(`build(s) superseded by ${id}: ${superseded.join(', ')}`);
        }
        const build = {
          id,
          project: projectName,
          projectDir,
          args: Array.isArray(body.args) ? body.args.map(String) : [],
          status: 'queued',
          exitCode: null,
          chunks: [],
          logBytes: 0,
          subscribers: new Set(),
        };
        builds.set(id, build);
        const ahead = queueDepth++;
        queue = queue
          .then(() => runBuild(build))
          .catch(() => {})
          .then(() => {
            queueDepth--;
          });
        if (ahead > 0) log(`build ${id} queued behind ${ahead} other build(s)`);
        return sendJson(res, 200, { buildId: id, ahead });
      }

      if (req.method === 'POST' && (m = p.match(/^\/builds\/([^/]+)\/cancel$/))) {
        const id = decodeURIComponent(m[1]);
        if (!builds.has(id)) return sendJson(res, 404, { error: 'unknown build' });
        const cancelled = cancelMatching((b) => b.id === id, 'cancel requested remotely');
        if (cancelled.length) log(`cancelled build ${id}`);
        return sendJson(res, 200, { cancelled });
      }

      if (req.method === 'POST' && p === '/builds/cancel') {
        const cancelled = cancelMatching(null, 'cancel requested remotely');
        if (cancelled.length) log(`cancelled ${cancelled.length} build(s): ${cancelled.join(', ')}`);
        return sendJson(res, 200, { cancelled });
      }

      if (req.method === 'GET' && (m = p.match(/^\/builds\/([^/]+)$/))) {
        const build = builds.get(decodeURIComponent(m[1]));
        if (!build) return sendJson(res, 404, { error: 'unknown build' });
        return sendJson(res, 200, {
          id: build.id,
          project: build.project,
          status: build.status,
          exitCode: build.exitCode,
        });
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  // Live log streaming: ws://host:port/builds/<id>/log
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const m = req.url.match(/^\/builds\/([^/]+)\/log$/);
    const build = m && builds.get(decodeURIComponent(m[1]));
    if (!build || !authorized(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'status', status: build.status }));
      for (const chunk of build.chunks) ws.send(JSON.stringify({ type: 'log', data: chunk }));
      if (build.status === 'done' || build.status === 'error') {
        ws.send(JSON.stringify({ type: 'exit', code: build.exitCode }));
        ws.close();
        return;
      }
      build.subscribers.add(ws);
      ws.on('close', () => build.subscribers.delete(ws));
    });
  });

  server.on('error', (e) => {
    log(
      e.code === 'EADDRINUSE'
        ? `port ${port} is already in use — is another tiforged running? (use --port to pick another)`
        : `server error: ${e.message}`
    );
    exit(1);
  });

  // Builds run detached (see killBuild), so a signal that stops the daemon
  // never reaches them: without this, Ctrl+C on the daemon left ti and
  // xcodebuild running on the Mac. Running builds are killed, queued ones
  // cancelled, then the bonjour record is withdrawn (a lingering record makes
  // the next start, or macOS itself, think the name is taken and rename).
  let shuttingDown = false;
  let unadvertise = (cb) => cb();
  async function shutdown(reason = 'shutting down') {
    if (shuttingDown) return;
    shuttingDown = true;
    const cancelled = cancelMatching(null, 'daemon shutting down');
    log(cancelled.length ? `${reason} — stopping ${cancelled.length} build(s)` : reason);
    // killed builds get SIGKILL after 5 s; wait for them to exit, but not forever
    await Promise.race([queue, new Promise((r) => setTimeout(r, 8000).unref())]);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500).unref(); // in case unpublish stalls
      unadvertise(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    exit(0);
  }
  server.shutdown = shutdown;
  if (opts.signals !== false) {
    process.on('SIGINT', () => shutdown('SIGINT received, shutting down'));
    process.on('SIGTERM', () => shutdown('SIGTERM received, shutting down'));
  }

  server.listen(port, () => {
    const actualPort = server.address().port;
    log(`daemon listening on port ${actualPort}`);
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
      }
    }
    log(
      ips.length
        ? `reachable at: ${ips.map((ip) => `http://${ip}:${actualPort}`).join('  ')}`
        : 'no external IPv4 address found — clients on other machines cannot reach this daemon'
    );
    log(`project root: ${root}`);
    log(`build command: ${buildCmd.join(' ')} build ...`);
    if (!token) log('WARNING: no --token set — anyone on the network can push files and run builds');
  });

  // Announce via mDNS so clients can discover this machine with `tiforge discover`.
  if (opts.advertise !== false) {
    try {
      const { Bonjour } = require('bonjour-service');
      const bonjour = new Bonjour();
      // instance name is irrelevant — clients identify daemons by URL; mDNS
      // auto-uniquifies ("tiforge (2)") if several daemons share a network.
      // Claim our own host name instead of the machine's: announcing the OS
      // hostname from a second responder makes macOS's mDNSResponder think
      // another device owns its name and rename itself (migabook-2, -3, ...).
      const host = `tiforge-${os.hostname().split('.')[0].toLowerCase()}.local`;
      bonjour.publish({ name: 'tiforge', type: 'tiforge', port, host });
      log('advertising via bonjour as _tiforge._tcp');
      unadvertise = (cb) => {
        try {
          bonjour.unpublishAll(() => {
            bonjour.destroy();
            cb();
          });
        } catch {
          cb();
        }
      };
    } catch (e) {
      log(`bonjour advertising unavailable: ${e.message}`);
    }
  }

  return server;
}

module.exports = { startDaemon };
