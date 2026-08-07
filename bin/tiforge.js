#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const USAGE = `tiforge — distributed Titanium SDK builds

Usage:
  tiforge daemon [--port 7331] [--token SECRET] [--root DIR]
               [--build-cmd "ti"] [--build-timeout 30] [--no-advertise]
      Run the build daemon (on the remote build machine, e.g. your Mac).
      "tiforged" is a shortcut for this subcommand, with the same flags.

  tiforge sync [projectDir] [--url http://host:7331] [--token SECRET] [--name ID] [--dir PATH]
      Sync a project to the configured hosts (or a single --url).

  tiforge build [projectDir] [--force] [--url ...] [--token ...] [--name ID] [--dir PATH]
                [-- <ti build args>]
      Sync, then build on the configured hosts. Args after "--" are passed
      to "ti build" on the remote machine (default: the host's buildArgs
      from ti config, falling back to "-p ios --build-only --no-prompt").

  tiforge clear [projectDir] [--url ...] [--token ...]
      Stop all builds and empty the queue on the configured daemons.

  tiforge discover [--timeout 3000]
      List tiForge daemons on the local network (mDNS/bonjour).

  tiforge init [--timeout 3000]
      Discover daemons on the network via mDNS and store them in the
      Titanium CLI config (ti config) under "forge.hosts".

  tiforge install
      Register the "ti forge" command with the Titanium CLI.

Config lives in "ti config" (~/.titanium/config.json) under the "forge" node:
  ti config forge.hosts.mac.url http://192.168.1.3:7331
  ti config forge.hosts.mac.token SECRET
  ti config forge.hosts.mac.buildArgs "-p ios --build-only --no-prompt"
  ti config forge.hosts.mac.dir /Volumes/SSD/builds
  ti config forge.exclude "dist,tmp"

"dir" is an absolute path on the daemon machine to mirror projects into,
replacing the daemon's own project root (~/.tiforge/projects). The project
name is still appended: /Volumes/SSD/builds/<project folder>. --dir overrides
it for one run.
`;

const { DEFAULT_BUILD_ARGS } = require('../lib/init');

function parseArgv(argv) {
  const out = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--no-')) {
      out.flags[a.slice(5)] = false;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function die(msg) {
  console.error('tiforge: ' + msg);
  process.exit(1);
}

function resolveHosts(projectDir, flags) {
  const { loadConfig, projectName } = require('../lib/config');
  const cfg = loadConfig(projectDir);
  let hosts = cfg.hosts;
  if (flags.url) {
    hosts = [{ name: 'cli', url: flags.url, token: flags.token || null, dir: null }];
  }
  if (typeof flags.dir === 'string') {
    hosts = hosts.map((h) => ({ ...h, dir: flags.dir }));
  }
  if (!hosts.length) {
    die('no hosts configured — run "tiforge init" to discover them into ti config, or pass --url');
  }
  // --name goes through the same sanitising as the derived name, so it cannot
  // produce a name the daemon rejects
  return { cfg, hosts, name: flags.name ? projectName(projectDir, flags.name) : cfg.name };
}

async function cmdSync(args) {
  const projectDir = path.resolve(args._[1] || '.');
  const { cfg, hosts, name } = resolveHosts(projectDir, args.flags);
  const { syncProject, renderProgress } = require('../lib/client');
  for (const host of hosts) {
    const label = host.name || host.url;
    await syncProject({
      url: host.url,
      token: host.token,
      name,
      projectDir,
      dir: host.dir,
      exclude: cfg.exclude,
      log: (msg) => console.log(`[${label}] ${msg}`),
      onProgress: renderProgress(`[${label}] `),
    });
  }
}

async function cmdBuild(args) {
  const projectDir = path.resolve(args._[1] || '.');
  const { cfg, hosts, name } = resolveHosts(projectDir, args.flags);
  const { runRemote, renderProgress, cancelBuilds } = require('../lib/client');
  let failed = false;
  for (const host of hosts) {
    const label = host.name || host.url;
    const buildArgs = args.rest.length ? args.rest : host.buildArgs || DEFAULT_BUILD_ARGS;
    try {
      if (args.flags.force) {
        await cancelBuilds({
          url: host.url,
          token: host.token,
          log: (msg) => console.log(`[${label}] ${msg}`),
        });
      }
      const { exitCode } = await runRemote({
        host,
        name,
        projectDir,
        exclude: cfg.exclude,
        buildArgs,
        log: (msg) => console.log(`[${label}] ${msg}`),
        onLine: (line) => console.log(`[${label}] ${line}`),
        onProgress: renderProgress(`[${label}] `),
      });
      console.log(`[${label}] build finished with exit code ${exitCode}`);
      if (exitCode !== 0) failed = true;
    } catch (e) {
      console.error(`[${label}] ${e.message}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

async function cmdClear(args) {
  const projectDir = path.resolve(args._[1] || '.');
  const { hosts } = resolveHosts(projectDir, args.flags);
  const { cancelBuilds } = require('../lib/client');
  for (const host of hosts) {
    const label = host.name || host.url;
    await cancelBuilds({
      url: host.url,
      token: host.token,
      log: (msg) => console.log(`[${label}] ${msg}`),
    });
  }
}

function cmdDaemon(args) {
  const { startDaemon } = require('../lib/daemon');
  startDaemon({
    port: args.flags.port ? Number(args.flags.port) : undefined,
    token: args.flags.token || process.env.TIFORGE_TOKEN || null,
    root: args.flags.root,
    advertise: args.flags.advertise !== false,
    buildCmd: args.flags['build-cmd'] ? String(args.flags['build-cmd']).split(/\s+/) : undefined,
    buildTimeoutMinutes: args.flags['build-timeout'] ? Number(args.flags['build-timeout']) : undefined,
  });
}

async function cmdDiscover(args) {
  const timeout = args.flags.timeout ? Number(args.flags.timeout) : 3000;
  const { discoverDaemons } = require('../lib/init');
  console.log('searching for tiForge daemons...');
  const daemons = await discoverDaemons(timeout);
  if (!daemons.length) {
    console.log('  none found — is the daemon running? Is mDNS/UDP 5353 allowed through the firewall?');
  } else {
    for (const d of daemons) console.log(`  ${d.name}  ${d.url}`);
  }
  process.exit(0);
}

async function cmdInit(args) {
  const timeout = args.flags.timeout ? Number(args.flags.timeout) : 3000;
  const { initHosts } = require('../lib/init');
  await initHosts({ timeout });
  process.exit(0);
}

function cmdInstall() {
  const commandsDir = path.join(__dirname, '..', 'commands');
  const r = spawnSync('ti', ['config', 'paths.commands', '--append', commandsDir], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.error || r.status !== 0) {
    console.log('could not run the ti CLI — register manually with:');
    console.log(`  ti config paths.commands --append ${commandsDir}`);
  } else {
    console.log('registered — use: ti forge [--init|--sync|--force|--clear|--discover]');
  }
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'daemon':
      return cmdDaemon(args);
    case 'sync':
      return cmdSync(args);
    case 'build':
      return cmdBuild(args);
    case 'clear':
      return cmdClear(args);
    case 'discover':
      return cmdDiscover(args);
    case 'init':
      return cmdInit(args);
    case 'install':
    case 'install-hook': // legacy alias
      return cmdInstall();
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e.message));
