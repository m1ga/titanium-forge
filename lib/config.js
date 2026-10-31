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

function readTiConfig() {
  return readJson(TI_CONFIG) || {};
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

function loadConfig(projectDir) {
  const t = readTiConfig().forge || {};
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
    exclude: splitList(t.exclude, /[,\s]+/),
  };
}

module.exports = { loadConfig, projectName, readTiConfig, writeTiConfig, TI_CONFIG };
