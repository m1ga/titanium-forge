'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// tinet.json is a legacy per-project config file (from tiNet, this project's
// former name); still excluded because old copies may contain host tokens.
const DEFAULT_EXCLUDES = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'build',
  '.DS_Store',
  'tinet.json',
];

// An exclude entry matches either a path segment name anywhere in the tree
// ("node_modules") or a path relative to the project root ("app/assets/raw").
// A leading slash anchors it to the project root only ("/Resources" excludes
// the top-level Resources dir but not one nested inside a module).
function isExcluded(relPath, excludes) {
  const segments = relPath.split('/');
  return excludes.some((ex) => {
    ex = String(ex);
    const anchored = ex.startsWith('/');
    ex = ex.replace(/^\/+|\/+$/g, '');
    if (!ex) return false;
    if (relPath === ex || relPath.startsWith(ex + '/')) return true;
    return !anchored && segments.includes(ex);
  });
}

// Regular files, symlinks, and empty directories.
// - Symlinks are recorded as links (not followed), which is essential for
//   iOS/macOS .framework and .xcframework bundles whose internal structure
//   is built out of symlinks (Versions/Current -> A, ...).
// - Empty directories are recorded too: xcframeworks reference paths like an
//   empty Headers/ dir from their Info.plist and Xcode fails if they don't
//   exist. Non-empty dirs are implied by their contents.
function listEntries(rootDir, excludes) {
  const out = [];
  (function walk(rel) {
    const abs = rel ? path.join(rootDir, rel) : rootDir;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    let kept = 0;
    for (const entry of entries) {
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      if (isExcluded(childRel, excludes)) continue;
      kept++;
      if (entry.isSymbolicLink()) out.push({ rel: childRel, type: 'link' });
      else if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push({ rel: childRel, type: 'file' });
      else kept--;
    }
    if (kept === 0 && rel) out.push({ rel, type: 'dir' });
  })('');
  return out.toSorted((a, b) => (a.rel < b.rel ? -1 : 1));
}

function hashFile(absPath) {
  return crypto.hash('sha1', fs.readFileSync(absPath), 'hex');
}

// Returns { relPath: { size, mtimeMs, hash, link? } }. `cache` is a previous
// manifest of the same directory: entries whose size+mtime are unchanged
// reuse the cached hash instead of re-reading the file. Symlinks carry their
// target in `link` and are hashed by target, so retargeting a link syncs.
function buildManifest(rootDir, opts = {}) {
  const excludes = DEFAULT_EXCLUDES.concat(opts.exclude || []);
  const cache = opts.cache || {};
  const files = {};
  for (const { rel, type } of listEntries(rootDir, excludes)) {
    const abs = path.join(rootDir, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (type === 'link') {
      let target;
      try {
        target = fs.readlinkSync(abs);
      } catch {
        continue;
      }
      const hash = crypto.hash('sha1', 'link:' + target, 'hex');
      files[rel] = { size: 0, mtimeMs: st.mtimeMs, hash, link: target };
    } else if (type === 'dir') {
      files[rel] = { size: 0, mtimeMs: st.mtimeMs, hash: 'dir', dir: true };
    } else {
      const cached = cache[rel];
      const hash =
        cached && !cached.link && !cached.dir && cached.size === st.size && cached.mtimeMs === st.mtimeMs
          ? cached.hash
          : hashFile(abs);
      files[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
    }
  }
  return files;
}

// needed  = files the server is missing or has a different hash for
// deleted = files the server has that the client no longer has
function diffManifests(clientFiles, serverFiles) {
  const needed = [];
  const deleted = [];
  for (const [rel, meta] of Object.entries(clientFiles)) {
    const s = serverFiles[rel];
    if (!s || s.hash !== meta.hash) needed.push(rel);
  }
  for (const rel of Object.keys(serverFiles)) {
    if (!clientFiles[rel]) deleted.push(rel);
  }
  return { needed, deleted };
}

module.exports = { DEFAULT_EXCLUDES, buildManifest, diffManifests, isExcluded, listEntries };
