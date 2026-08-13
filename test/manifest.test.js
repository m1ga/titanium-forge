'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isExcluded, diffManifests, buildManifest } = require('../lib/manifest');

test('isExcluded matches a segment name anywhere in the tree', () => {
  assert.strictEqual(isExcluded('a/node_modules/x.js', ['node_modules']), true);
  assert.strictEqual(isExcluded('node_modules', ['node_modules']), true);
  assert.strictEqual(isExcluded('a/node_module/x.js', ['node_modules']), false);
});

test('isExcluded matches root-relative paths', () => {
  assert.strictEqual(isExcluded('app/assets/raw/big.bin', ['app/assets/raw']), true);
  assert.strictEqual(isExcluded('other/app/assets/raw/x', ['app/assets/raw']), false);
});

test('a leading slash anchors the exclude to the project root', () => {
  assert.strictEqual(isExcluded('Resources/app.js', ['/Resources']), true);
  assert.strictEqual(isExcluded('modules/foo/Resources/x.js', ['/Resources']), false);
  assert.strictEqual(isExcluded('modules/foo/Resources/x.js', ['Resources']), true);
});

test('diffManifests reports missing/changed as needed and extraneous as deleted', () => {
  const client = { a: { hash: '1' }, b: { hash: '2' } };
  const server = { b: { hash: 'other' }, c: { hash: '3' } };
  const { needed, deleted } = diffManifests(client, server);
  assert.deepStrictEqual(needed.sort(), ['a', 'b']);
  assert.deepStrictEqual(deleted, ['c']);
});

test('buildManifest records files, empty dirs, and symlinks; honors excludes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiforge-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'file.txt'), 'hello');
  fs.mkdirSync(path.join(root, 'sub', 'empty'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'ignored');
  fs.symlinkSync('file.txt', path.join(root, 'link'));

  const m = buildManifest(root);
  assert.deepStrictEqual(Object.keys(m).sort(), ['file.txt', 'link', 'sub/empty']);
  assert.strictEqual(m['file.txt'].size, 5);
  assert.match(m['file.txt'].hash, /^[0-9a-f]{40}$/);
  assert.strictEqual(m['sub/empty'].dir, true);
  assert.strictEqual(m.link.link, 'file.txt');
});

test('buildManifest reuses cached hashes when size and mtime are unchanged', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiforge-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'file.txt'), 'hello');
  const first = buildManifest(root);
  const seeded = { 'file.txt': { ...first['file.txt'], hash: 'FAKE-CACHED-HASH' } };
  const second = buildManifest(root, { cache: seeded });
  assert.strictEqual(second['file.txt'].hash, 'FAKE-CACHED-HASH');

  // changing the content invalidates the cached hash
  fs.writeFileSync(path.join(root, 'file.txt'), 'hello!');
  const third = buildManifest(root, { cache: seeded });
  assert.notStrictEqual(third['file.txt'].hash, 'FAKE-CACHED-HASH');
});
