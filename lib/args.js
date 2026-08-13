'use strict';

const { parseArgs } = require('util');

// One flat option table shared by every subcommand — tiforge has few flags and
// each subcommand simply ignores the ones that don't apply. strict mode means
// a typoed flag errors out instead of being silently accepted.
const OPTIONS = {
  port: { type: 'string' },
  token: { type: 'string' },
  root: { type: 'string' },
  advertise: { type: 'boolean', default: true },
  'build-cmd': { type: 'string' },
  'build-timeout': { type: 'string' },
  url: { type: 'string' },
  name: { type: 'string' },
  dir: { type: 'string' },
  force: { type: 'boolean', default: false },
  timeout: { type: 'string' },
};

// Returns { _: positionals, flags, rest } where rest is everything after "--"
// (forwarded to "ti build" on the remote machine). "--" is split off before
// parseArgs runs so remote args are never mistaken for positionals.
function parseArgv(argv) {
  const dd = argv.indexOf('--');
  const rest = dd === -1 ? [] : argv.slice(dd + 1);
  const { values, positionals } = parseArgs({
    args: dd === -1 ? argv : argv.slice(0, dd),
    options: OPTIONS,
    allowPositionals: true,
    allowNegative: true, // --no-advertise
    strict: true,
  });
  return { _: positionals, flags: values, rest };
}

module.exports = { parseArgv };
