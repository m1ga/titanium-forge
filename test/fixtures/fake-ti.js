'use strict';

// Stand-in for the "ti" CLI in daemon tests. Invoked by the daemon as
//   node fake-ti.js build [args...] --no-prompt --no-progress-bars
// --sleep <ms> simulates a long build (e.g. a simulator session that never
// returns); --exit <code> simulates a failing build.
const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i === -1 ? dflt : Number(args[i + 1]);
};
console.log('fake-ti ran: ' + args.join(' '));
setTimeout(() => process.exit(num('--exit', 0)), num('--sleep', 0));
