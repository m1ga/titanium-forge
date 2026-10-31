'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderProgress } = require('../lib/client');

function plainOutput() {
  const lines = [];
  return { out: { isTTY: false, write: (s) => lines.push(s.trimEnd()) }, lines };
}

test('plain progress for one tiny file is a single complete line', () => {
  const { out, lines } = plainOutput();
  const progress = renderProgress('[x] ', out);
  // as emitted by syncProject: data (bytes complete), end (file counted), final report
  progress({ sentBytes: 3, totalBytes: 3, sentFiles: 0, totalFiles: 1, file: 'a.txt' });
  progress({ sentBytes: 3, totalBytes: 3, sentFiles: 1, totalFiles: 1, file: 'a.txt' });
  progress({ sentBytes: 3, totalBytes: 3, sentFiles: 1, totalFiles: 1 });
  assert.deepStrictEqual(lines, ['[x] uploading 1/1 file(s)  3 B/3 B  100%']);
});

test('plain progress prints every 25% and the final line once', () => {
  const { out, lines } = plainOutput();
  const progress = renderProgress('', out);
  const step = (sentBytes, sentFiles) =>
    progress({ sentBytes, totalBytes: 100, sentFiles, totalFiles: 4, file: 'f' });
  step(10, 0);
  step(25, 1);
  step(30, 1);
  step(50, 2);
  step(75, 3);
  step(100, 3); // bytes complete, last file not yet counted
  step(100, 4);
  step(100, 4);
  // the first report always prints, then every 25 points, then the done line
  assert.deepStrictEqual(
    lines.map((l) => l.split('  ').pop()),
    ['10%', '50%', '75%', '100%']
  );
  assert.ok(lines[3].startsWith('uploading 4/4 file(s)'));
});
