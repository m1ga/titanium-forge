'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectName, resolveHosts } = require('../lib/config');

test('projectName uses the project directory basename', () => {
  assert.strictEqual(projectName('/home/dev/MyApp'), 'MyApp');
});

test('projectName folds characters the daemon rejects', () => {
  assert.strictEqual(projectName('/home/dev/My App!'), 'My-App');
  assert.strictEqual(projectName('/home/dev/Ünicode Näme'), 'nicode-N-me');
});

test('projectName strips leading/trailing dots and dashes', () => {
  assert.strictEqual(projectName('/home/dev/.hidden-'), 'hidden');
});

test('projectName falls back when nothing survives', () => {
  assert.strictEqual(projectName('/home/dev/---'), 'project');
});

test('an explicit name goes through the same sanitising', () => {
  assert.strictEqual(projectName('/home/dev/whatever', 'My App'), 'My-App');
});

function tiConfig(t, forge) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiforge-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ forge }));
  return file;
}

test('resolveHosts reads hosts, the global token fallback and excludes', (t) => {
  const file = tiConfig(t, {
    token: 'global',
    exclude: 'tmp, docs',
    hosts: {
      mac: { url: 'http://mac:7331', token: 'own', buildArgs: '-p ios -T simulator' },
      mini: { url: 'http://mini:7331', dir: '/Volumes/SSD' },
      broken: { token: 'no-url' },
    },
  });
  const cfg = resolveHosts('/home/dev/MyApp', {}, file);
  assert.strictEqual(cfg.name, 'MyApp');
  assert.deepStrictEqual(cfg.exclude, ['tmp', 'docs']);
  assert.deepStrictEqual(
    cfg.hosts.map((h) => [h.name, h.token, h.dir, h.buildArgs]),
    [
      ['mac', 'own', null, ['-p', 'ios', '-T', 'simulator']],
      ['mini', 'global', '/Volumes/SSD', null],
    ]
  );
});

test('resolveHosts applies --url, --dir and --name the same way for both front ends', (t) => {
  const file = tiConfig(t, { token: 'global', hosts: { mac: { url: 'http://mac:7331' } } });
  const cfg = resolveHosts(
    '/home/dev/MyApp',
    { url: 'http://1.2.3.4:7331', dir: '/tmp/mirror', name: 'My App' },
    file
  );
  assert.strictEqual(cfg.name, 'My-App');
  assert.deepStrictEqual(cfg.hosts, [
    { name: 'cli', url: 'http://1.2.3.4:7331', token: 'global', buildArgs: null, dir: '/tmp/mirror' },
  ]);
  assert.strictEqual(
    resolveHosts('/x', { url: 'http://h:1', token: 'own' }, file).hosts[0].token,
    'own'
  );
});

test('resolveHosts returns no hosts when ti config has none', (t) => {
  const file = tiConfig(t, {});
  assert.deepStrictEqual(resolveHosts('/x', {}, file).hosts, []);
});
