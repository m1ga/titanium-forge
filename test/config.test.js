'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { projectName } = require('../lib/config');

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
