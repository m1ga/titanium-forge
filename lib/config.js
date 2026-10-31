'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Settings live in the Titanium CLI's own config store (managed by
// "ti config") under the "forge" node:
//
//   ti config forge.hosts.mac.url http://192.168.1.3:7331
//   ti config forge.hosts.mac.token SECRET
//   ti config forge.hosts.mac.buildArgs "-p ios --build-only --no-prompt"
//   ti config forge.hosts.mac.dir /Volumes/SSD/builds
//   ti config forge.token SECRET              # fallback for hosts without one
//   ti config forge.exclude "tmp,docs"
const TI_CONFIG = path.join(os.homedir(), '.titanium', 'config.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`failed to read ${file}: ${e.message}`);
  }
}

function readTiConfig(file = TI_CONFIG) {
  return readJson(file) || {};
}

function writeTiConfig(cfg) {
  fs.mkdirSync(path.dirname(TI_CONFIG), { recursive: true });
  fs.writeFileSync(TI_CONFIG, JSON.stringify(cfg, null, '\t') + '\n');
}

function splitList(v, re) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(re).filter(Boolean);
  return [];
}

// The name of the project's own directory, so the mirror on the daemon is
// recognisable as the app you are working on (MyApp, not com.example.myapp).
// The daemon only accepts [A-Za-z0-9._-] as a path segment, so anything else
// (spaces, umlauts, slashes in a symlinked name) is folded to "-".
function projectName(projectDir, explicit) {
  const raw = explicit || path.basename(path.resolve(projectDir));
  return (
    raw
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'project'
  );
}

// `file` exists for tests; everything else reads the Titanium CLI's config.
function loadConfig(projectDir, file = TI_CONFIG) {
  const t = readTiConfig(file).forge || {};
  const hosts = Object.entries(t.hosts || {})
    .map(([name, h]) => ({
      name,
      url: h.url,
      token: h.token || t.token || null,
      // ti config values are strings, so buildArgs is space-separated
      buildArgs: h.buildArgs ? splitList(h.buildArgs, /\s+/) : null,
      // absolute path on the daemon machine to mirror projects into, replacing
      // the daemon's own project root (~/.tiforge/projects). The project name
      // is still appended, so one base dir serves several projects.
      dir: h.dir || null,
    }))
    .filter((h) => h.url);
  return {
    name: projectName(projectDir),
    hosts,
    token: t.token || null,
    exclude: splitList(t.exclude, /[,\s]+/),
  };
}

// The config for one run, after the command-line overrides that both front
// ends (bin/tiforge.js and commands/forge.js) accept: --url replaces the
// configured hosts with one ad-hoc host, --dir replaces the mirror dir of
// every host, --name the project name. --name goes through the same
// sanitising as the derived name, so it cannot produce a name the daemon
// rejects. Hosts can be empty; the caller decides how to complain.
function resolveHosts(projectDir, { url, token, dir, name } = {}, file = TI_CONFIG) {
  const cfg = loadConfig(projectDir, file);
  if (url) {
    cfg.hosts = [{ name: 'cli', url, token: token || cfg.token, buildArgs: null, dir: null }];
  }
  if (typeof dir === 'string' && dir) cfg.hosts = cfg.hosts.map((h) => ({ ...h, dir }));
  if (name) cfg.name = projectName(projectDir, name);
  return cfg;
}

module.exports = { loadConfig, resolveHosts, projectName, readTiConfig, writeTiConfig, TI_CONFIG };
