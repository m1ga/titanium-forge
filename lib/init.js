'use strict';

const { setTimeout: delay } = require('timers/promises');

const DEFAULT_BUILD_ARGS = ['-p', 'ios', '--build-only', '--no-prompt'];

// Browse mDNS for _tiforge._tcp daemons for `timeout` ms.
// Returns [{ name, url }] with IPv4 addresses preferred.
async function discoverDaemons(timeout = 3000) {
  let bonjour;
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour();
  } catch {
    return [];
  }
  const found = new Map();
  bonjour.find({ type: 'tiforge' }, (svc) => {
    const addr =
      (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ||
      (svc.addresses || [])[0] ||
      svc.host;
    const url = `http://${addr}:${svc.port}`;
    // label only — daemons are identified by URL. The machine's mDNS
    // hostname makes a readable default config key for new entries.
    const label =
      String(svc.host || svc.name || 'tiforge')
        .replace(/\.local\.?$/i, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'tiforge';
    found.set(url, { name: label, url });
  });
  await delay(timeout);
  bonjour.destroy();
  return [...found.values()];
}

// Discover daemons and store them in the Titanium CLI config
// (~/.titanium/config.json) under forge.hosts.<name>. Re-running updates
// URLs but keeps tokens and buildArgs you already configured.
async function initHosts({ timeout = 3000, log = console.log } = {}) {
  const { readTiConfig, writeTiConfig, TI_CONFIG } = require('./config');

  log('searching for tiForge daemons on the network...');
  const daemons = await discoverDaemons(timeout);
  if (!daemons.length) {
    log('none found — start "tiforged" on the build machine, check that');
    log('mDNS/UDP 5353 is allowed through the firewall, or add a host manually:');
    log('  ti config forge.hosts.mac.url http://<mac-ip>:7331');
    log('  ti config forge.hosts.mac.token <SECRET>');
    return { found: 0 };
  }

  const cfg = readTiConfig();
  cfg.forge || (cfg.forge = {});
  cfg.forge.hosts || (cfg.forge.hosts = {});
  const hosts = cfg.forge.hosts;
  for (const d of daemons) {
    // a daemon already configured under another name (same url) is updated
    // in place — macOS hostnames drift (mac-2, mac-5, ...) between restarts
    let name = d.name;
    for (const [n, h] of Object.entries(hosts)) {
      if (h.url === d.url) {
        name = n;
        break;
      }
    }
    const existing = hosts[name] || {};
    log(`  found: ${name}  ${d.url}${existing.url ? ' (updated)' : ' (added)'}`);
    hosts[name] = {
      ...existing,
      url: d.url,
      token: existing.token || 'change-me',
      buildArgs: existing.buildArgs || DEFAULT_BUILD_ARGS.join(' '),
    };
  }
  writeTiConfig(cfg);
  log(`saved under "forge.hosts" in ${TI_CONFIG}`);
  log('set each host\'s token with: ti config forge.hosts.<name>.token <SECRET>');
  return { found: daemons.length };
}

module.exports = { DEFAULT_BUILD_ARGS, discoverDaemons, initHosts };
