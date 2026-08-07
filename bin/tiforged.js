#!/usr/bin/env node
'use strict';

// Shortcut for "tiforge daemon" — the only thing the build machine ever runs.
// Every daemon flag still applies: tiforged --token SECRET --port 7331 ...
//
// Injecting the subcommand and handing over to the real entry point keeps this
// in one process, so signals (the SIGINT/SIGTERM that withdraws the bonjour
// registration) and the exit code are the daemon's own.
process.argv.splice(2, 0, 'daemon');
require('./tiforge.js');
