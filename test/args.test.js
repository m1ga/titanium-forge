'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseArgv } = require('../lib/args');

test('separates positionals, flags, and remote args after --', () => {
  const a = parseArgv(['build', 'MyApp', '--force', '--url', 'http://x:1', '--', '-p', 'android']);
  assert.deepStrictEqual(a._, ['build', 'MyApp']);
  assert.strictEqual(a.flags.force, true);
  assert.strictEqual(a.flags.url, 'http://x:1');
  assert.deepStrictEqual(a.rest, ['-p', 'android']);
});

test('a boolean flag does not swallow the following positional', () => {
  const a = parseArgv(['build', '--force', 'MyApp']);
  assert.strictEqual(a.flags.force, true);
  assert.deepStrictEqual(a._, ['build', 'MyApp']);
});

test('advertise defaults to true and --no-advertise negates it', () => {
  assert.strictEqual(parseArgv(['daemon']).flags.advertise, true);
  assert.strictEqual(parseArgv(['daemon', '--no-advertise']).flags.advertise, false);
});

test('value flags keep their string values', () => {
  const a = parseArgv(['daemon', '--port', '7331', '--build-timeout', '10']);
  assert.strictEqual(a.flags.port, '7331');
  assert.strictEqual(a.flags['build-timeout'], '10');
});

test('unknown flags throw instead of being silently accepted', () => {
  assert.throws(() => parseArgv(['build', '--bogus']));
});
