'use strict';

// Custom Titanium CLI command: "ti forge"
// Register with: ti config paths.commands --append <this repo>/commands
//
//   ti forge                sync + remote build on all configured hosts
//   ti forge --force        like ti forge, but kills/cancels remote builds first
//   ti forge --clear        stop all builds and empty the queue, nothing else
//   ti forge --sync         sync only, no remote build
//   ti forge --init         discover daemons into ti config (forge.hosts)
//   ti forge --discover     list tiForge daemons on the network
//   ti forge --name ID      override the mirror directory name on the daemon

const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

exports.cliVersion = '>=3.2';
exports.desc = 'sync the project to tiForge daemons and run remote builds';
exports.extendedDesc =
  'tiForge syncs the project to remote build machines running "tiforge daemon" ' +
  'and runs Titanium builds there, streaming the log back. Hosts are stored ' +
  'in ti config under "forge.hosts" (populate them with "ti forge --init").';

exports.config = function (logger, config, cli) {
  return {
    skipBanner: true,
    flags: {
      init: {
        default: false,
        desc: 'discover tiForge daemons and store them in ti config (forge.hosts)',
      },
      sync: {
        default: false,
        desc: 'only sync files, do not trigger remote builds',
      },
      discover: {
        default: false,
        desc: 'list tiForge daemons on the local network',
      },
      force: {
        default: false,
        desc: 'kill the running remote build and cancel queued ones first',
      },
      clear: {
        default: false,
        desc: 'stop all builds and empty the queue on the daemons, then exit',
      },
    },
    options: {
      'project-dir': {
        abbr: 'd',
        default: '.',
        desc: 'the directory containing the project',
      },
      name: {
        desc: 'name of the mirror directory on the daemon (default: the project folder name)',
      },
      timeout: {
        default: 3000,
        desc: 'mDNS discovery timeout in milliseconds',
      },
    },
  };
};

exports.run = function (logger, config, cli, finished) {
  const done = typeof finished === 'function' ? finished : function () {};
  const projectDir = path.resolve(cli.argv['project-dir'] || '.');
  const timeout = Number(cli.argv.timeout) || 3000;
  const log = (msg) => logger.info('tiForge: ' + msg);

  (async () => {
    if (cli.argv.discover) {
      const { discoverDaemons } = require(path.join(LIB, 'init'));
      log('searching for tiForge daemons...');
      const daemons = await discoverDaemons(timeout);
      if (!daemons.length) {
        log('none found — is the daemon running? Is mDNS/UDP 5353 allowed through the firewall?');
      } else {
        for (const d of daemons) log(`  ${d.name}  ${d.url}`);
      }
      return;
    }

    if (cli.argv.init) {
      const { initHosts } = require(path.join(LIB, 'init'));
      await initHosts({ timeout, log });
      return;
    }

    const { loadConfig, projectName } = require(path.join(LIB, 'config'));
    const { syncProject, runRemote, renderProgress, cancelBuilds } = require(path.join(LIB, 'client'));
    const { DEFAULT_BUILD_ARGS } = require(path.join(LIB, 'init'));
    const cfg = loadConfig(projectDir);
    // --name goes through the same sanitising as the derived name (as in
    // bin/tiforge.js), so it cannot produce a name the daemon rejects
    if (cli.argv.name) cfg.name = projectName(projectDir, cli.argv.name);
    if (!cfg.hosts.length) {
      throw new Error('no hosts configured — run "ti forge --init" first (stores hosts in ti config)');
    }

    let failed = false;
    for (const host of cfg.hosts) {
      const label = host.name || host.url;
      const prefix = '\x1b[36m[tiForge:' + label + ']\x1b[0m ';
      const write = (line) => process.stdout.write(prefix + line + '\n');
      try {
        if (cli.argv.clear) {
          await cancelBuilds({ url: host.url, token: host.token, log: write });
          continue;
        }
        if (cli.argv.force) {
          await cancelBuilds({ url: host.url, token: host.token, log: write });
        }
        if (cli.argv.sync) {
          await syncProject({
            url: host.url,
            token: host.token,
            name: cfg.name,
            projectDir,
            dir: host.dir,
            exclude: cfg.exclude,
            log: write,
            onProgress: renderProgress(prefix),
          });
        } else {
          const { exitCode } = await runRemote({
            host,
            name: cfg.name,
            projectDir,
            exclude: cfg.exclude,
            buildArgs: host.buildArgs || DEFAULT_BUILD_ARGS,
            log: write,
            onLine: write,
            onProgress: renderProgress(prefix),
          });
          if (exitCode === 0) {
            log(label + ' build succeeded');
          } else {
            logger.error('tiForge: ' + label + ' build failed (exit code ' + exitCode + ')');
            failed = true;
          }
        }
      } catch (e) {
        logger.error('tiForge: ' + label + ': ' + e.message);
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;
  })().then(
    () => done(),
    (e) => {
      logger.error('tiForge: ' + e.message);
      done(e);
    }
  );
};
