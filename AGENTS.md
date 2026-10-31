# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

tiForge does distributed Titanium SDK builds: a **client** on the dev machine
(typically Linux) syncs a project to a **daemon** on a build machine (typically
a Mac) and triggers `ti build` there, streaming the log back over a WebSocket.

Read `README.md` first — it covers the sync model, the config model, and the
HTTP protocol. This file covers what the README doesn't: how to work in the
code.

## Layout

| Path | Role |
| --- | --- |
| `bin/tiforge.js` | CLI entry: argv parsing, subcommand dispatch, `USAGE` text |
| `bin/tiforged.js` | 11-line shim → `tiforge daemon` |
| `commands/forge.js` | Titanium CLI plugin providing `ti forge` (registered via `ti config paths.commands`) |
| `lib/client.js` | Dev-machine side: HTTP helpers, manifest sync, upload, build + log stream |
| `lib/daemon.js` | Build-machine side: HTTP server, tar extraction, build queue, WS log fan-out |
| `lib/manifest.js` | Shared: directory walk, exclude matching, hashing, manifest diff |
| `lib/config.js` | Reads/writes `~/.titanium/config.json` under the `forge` node |
| `lib/init.js` | mDNS discovery + writing discovered hosts into ti config |

`lib/manifest.js` runs on **both** sides — the client builds a manifest of the
project, the daemon builds one of its mirror, and `diffManifests` compares them.
Changing the walk, the exclude semantics, or the hash format changes both ends
at once; a mismatch shows up as a permanently re-uploading file, not an error.

`commands/forge.js` and `bin/tiforge.js` are two front ends over the same
`lib/client.js` functions. A behaviour change usually belongs in `lib/`, and
almost always needs the same treatment in both front ends.

## Conventions

- **Plain CommonJS, Node ≥ 18, no build step.** Every file starts with
  `'use strict';` and ends with `module.exports = { ... }`.
- **Three runtime dependencies** (`ws`, `tar-fs`, `bonjour-service`). Everything
  else is Node stdlib. Don't add dependencies without a clear reason — this is
  meant to be `git clone && npm install` on a machine someone else administers.
- **`require()` lazily inside subcommand functions** in `bin/tiforge.js` and
  `commands/forge.js`, so `tiforge --help` and `ti forge --discover` don't pay
  for `ws`/`tar-fs`. Top-level `require` is fine inside `lib/`.
- **2-space indent, semicolons, single quotes, ~100 col lines.** No linter or
  formatter is configured; match the surrounding file.
- **Comments explain *why*, not *what*.** The existing ones carry real
  knowledge — why `validateSymlinks` is off (`.framework` link chains), why
  empty dirs are in the manifest (xcframework `Headers/`), why builds are
  detached (killing the `xcodebuild` process tree). Preserve them when editing
  nearby code; write new ones in the same register.
- **No `console.log` in `lib/`.** Library functions take an injected
  `log`/`onLine`/`onProgress` callback defaulting to a no-op; the callers decide
  how output is rendered (plain prefix in `bin/`, ANSI cyan `[tiForge:host]` in
  `commands/`). `lib/daemon.js` is the one exception — it's a server process and
  its `log` option defaults to `console.log`.
- **Never fail a sync over an optimisation.** The hash cache in
  `lib/client.js` swallows all its errors on purpose; keep that property.

## Testing

`npm test` runs `node --test test/*.test.js` (no extra dependencies). It
covers argv parsing, project-name sanitising, the manifest walk/diff, and
the daemon end to end: an in-process daemon on an ephemeral port with
`test/fixtures/fake-ti.js` standing in for `ti`, driven through `lib/client.js`.
Add a test there when you touch sync, the queue, or a route — the daemon
tests are cheap (the whole suite runs in under a second).

Anything involving a real `ti build`, mDNS, or two machines is still manual
and needs two terminals:

```sh
# terminal 1 — daemon, with an isolated root so nothing real is touched
node bin/tiforged.js --token test --root /tmp/tiforge-test --no-advertise

# terminal 2 — sync some project against it
node bin/tiforge.js sync ~/dev/SomeApp --url http://127.0.0.1:7331 --token test
```

Both machines can be the same box for everything except an actual iOS build.
Useful checks when touching sync:

- Run `sync` twice — the second must report `0 uploaded`. Anything else means
  the client and daemon manifests disagree.
- Delete a file locally, sync, and confirm it disappears from the mirror.
- Touch a file without changing content (`touch`) — it should re-hash but not
  re-upload.
- `--build-cmd` lets you swap `ti` for a stub script when testing the queue,
  cancel, or log-streaming paths without a real build.

If you change anything, say plainly which of these you actually ran.

## Things that bite

- **`dir` is a path on the *daemon* machine**, supplied by the client per
  request (`?dir=`). The project name is the only untrusted path segment
  appended to it and is validated against `PROJECT_NAME_RE`. Don't loosen that
  regex, and don't add a route that joins client-supplied paths without it.
- **The token is the entire security boundary.** There's no TLS and no
  per-project authz; a client with the token can run arbitrary `ti build`
  arguments. Keep new routes behind `authorized(req)` — including WebSocket
  upgrades.
- **Alloy projects**: `Resources/` is generated remotely by the alloy compiler.
  The client excludes it and asks the daemon to `purge` it. Syncing a local
  copy poisons the remote build.
- **Symlinks are recorded, not followed** — iOS `.framework`/`.xcframework`
  bundles are made of them. Links whose target escapes the project dir are
  skipped on extraction.
- **`ti config` values are strings**, so `buildArgs` is space-separated and
  `exclude` is comma/space-separated; both go through `splitList`.
- **Builds run one at a time per daemon**, serialised on a promise chain with a
  `queueDepth` counter. Cancellation walks the whole `builds` map.
