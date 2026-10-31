'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { startDaemon } = require('../lib/daemon');
const { ping, syncProject, remoteBuild, cancelBuilds } = require('../lib/client');

const FAKE_TI = path.join(__dirname, 'fixtures', 'fake-ti.js');

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startTestDaemon(t, opts = {}) {
  const root = tmpdir(t, 'tiforge-root-');
  const server = startDaemon({
    port: 0,
    root,
    advertise: false,
    buildCmd: [process.execPath, FAKE_TI],
    log: () => {},
    ...opts,
  });
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, root };
}

function makeProject(t, files) {
  const dir = tmpdir(t, 'tiforge-proj-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// remoteBuild resolves when the build exits; this starts one and also reports
// when the daemon has accepted it (first log line), so tests can sequence
// submissions deterministically.
function startBuild(opts) {
  let accepted;
  const acceptedP = new Promise((r) => (accepted = r));
  const result = remoteBuild({ ...opts, log: () => accepted() });
  return { result, accepted: acceptedP };
}

test('sync + build round trip', async (t) => {
  const { url, root } = await startTestDaemon(t);
  const projectDir = makeProject(t, { 'app.txt': 'hello tiforge' });

  await ping({ url });

  const r1 = await syncProject({ url, name: 'demo', projectDir });
  assert.strictEqual(r1.needed, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'demo', 'app.txt'), 'utf8'),
    'hello tiforge'
  );

  // second sync is a no-op; a deleted file is removed from the mirror
  const r2 = await syncProject({ url, name: 'demo', projectDir });
  assert.strictEqual(r2.needed, 0);
  fs.rmSync(path.join(projectDir, 'app.txt'));
  const r3 = await syncProject({ url, name: 'demo', projectDir });
  assert.strictEqual(r3.deleted, 1);
  assert.strictEqual(fs.existsSync(path.join(root, 'demo', 'app.txt')), false);

  const lines = [];
  const { exitCode } = await remoteBuild({
    url,
    name: 'demo',
    args: ['-p', 'ios'],
    onLine: (l) => lines.push(l),
  });
  assert.strictEqual(exitCode, 0);
  assert.ok(lines.some((l) => l.includes('fake-ti ran: build -p ios')));
});

test('a failing build reports its exit code', async (t) => {
  const { url } = await startTestDaemon(t);
  const projectDir = makeProject(t, { 'app.txt': 'x' });
  await syncProject({ url, name: 'demo', projectDir });
  const { exitCode } = await remoteBuild({ url, name: 'demo', args: ['--exit', '3'] });
  assert.strictEqual(exitCode, 3);
});

test('a new build supersedes older builds of the same project only', async (t) => {
  const { url } = await startTestDaemon(t);
  const projA = makeProject(t, { 'a.txt': 'a' });
  const projB = makeProject(t, { 'b.txt': 'b' });
  await syncProject({ url, name: 'appA', projectDir: projA });
  await syncProject({ url, name: 'appB', projectDir: projB });

  // appA build that would run for a minute (like a simulator session)
  const a1 = startBuild({ url, name: 'appA', args: ['--sleep', '60000'] });
  await a1.accepted;
  // appB queues behind it; then a new appA build supersedes the first one
  const b1 = startBuild({ url, name: 'appB', args: [] });
  await b1.accepted;
  const a2 = startBuild({ url, name: 'appA', args: [] });

  const [ra1, rb1, ra2] = await Promise.all([a1.result, b1.result, a2.result]);
  assert.notStrictEqual(ra1.exitCode, 0, 'old appA build should be killed');
  assert.strictEqual(rb1.exitCode, 0, 'appB build should be untouched');
  assert.strictEqual(ra2.exitCode, 0, 'new appA build should run');
});

test('cancelBuilds kills the running build', async (t) => {
  const { url } = await startTestDaemon(t);
  const projectDir = makeProject(t, { 'a.txt': 'a' });
  await syncProject({ url, name: 'demo', projectDir });

  const b = startBuild({ url, name: 'demo', args: ['--sleep', '60000'] });
  await b.accepted;
  const { cancelled } = await cancelBuilds({ url });
  assert.strictEqual(cancelled.length, 1);
  const { exitCode } = await b.result;
  assert.notStrictEqual(exitCode, 0);
});

test('requests without the token are rejected', async (t) => {
  const { url } = await startTestDaemon(t, { token: 'sekret' });
  await assert.rejects(() => ping({ url }), /HTTP 401/);
  await assert.rejects(() => ping({ url, token: 'wrong' }), /HTTP 401/);
  await ping({ url, token: 'sekret' });
});

test('a path that changes kind between syncs is replaced in the mirror', async (t) => {
  const { url, root } = await startTestDaemon(t);
  const projectDir = makeProject(t, { 'target.txt': 'target' });
  fs.symlinkSync('target.txt', path.join(projectDir, 'foo'));
  fs.mkdirSync(path.join(projectDir, 'empty'));
  await syncProject({ url, name: 'demo', projectDir });
  assert.ok(fs.lstatSync(path.join(root, 'demo', 'foo')).isSymbolicLink());

  // symlink -> regular file (tar-fs would otherwise write through the link
  // into target.txt), empty dir -> regular file (EISDIR on extract)
  fs.unlinkSync(path.join(projectDir, 'foo'));
  fs.writeFileSync(path.join(projectDir, 'foo'), 'now a file');
  fs.rmdirSync(path.join(projectDir, 'empty'));
  fs.writeFileSync(path.join(projectDir, 'empty'), 'also a file');
  await syncProject({ url, name: 'demo', projectDir });

  const mirror = (rel) => path.join(root, 'demo', rel);
  assert.ok(fs.lstatSync(mirror('foo')).isFile());
  assert.strictEqual(fs.readFileSync(mirror('foo'), 'utf8'), 'now a file');
  assert.strictEqual(fs.readFileSync(mirror('target.txt'), 'utf8'), 'target');
  assert.ok(fs.lstatSync(mirror('empty')).isFile());
  const r = await syncProject({ url, name: 'demo', projectDir });
  assert.strictEqual(r.needed, 0, 'mirror should be in sync after the type change');
});

test('a corrupt upload is answered with 400 and does not crash the daemon', async (t) => {
  const { url } = await startTestDaemon(t);
  const res = await fetch(`${url}/projects/demo/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip' },
    body: Buffer.from('this is not gzip'),
    signal: AbortSignal.timeout(3000),
  });
  assert.strictEqual(res.status, 400);
  await ping({ url }); // still alive
});

test('purge never reaches outside or at the project dir itself', async (t) => {
  const { url, root } = await startTestDaemon(t);
  const projectDir = makeProject(t, { 'a.txt': 'a' });
  await syncProject({ url, name: 'demo', projectDir });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'keep me');

  const res = await fetch(`${url}/projects/demo/manifest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: {}, purge: ['', '.', '..', '../outside.txt', '/'] }),
  });
  assert.strictEqual(res.status, 200);
  assert.ok(fs.existsSync(path.join(root, 'demo')), 'project dir must survive');
  assert.ok(fs.existsSync(path.join(root, 'outside.txt')));
});
