# tiForge

Distributed [Titanium SDK](https://titaniumsdk.com) builds: work on one machine,
build on others. Typical setup: you develop on Linux, a Mac on your network runs
the tiForge daemon, and `ti forge` syncs the project to the Mac and runs the iOS
build there — with the remote log streaming into your local terminal.

```
┌─ Linux (dev machine) ──────────┐        ┌─ Mac ──────────────────────┐
│ ti forge                       │        │ tiforged                   │
│   ├─ 1. manifest diff      ────┼──────► │   ├─ project mirror        │
│   ├─ 2. upload changes     ────┼──────► │   ├─ receives changed files│
│   └─ 3. trigger build      ────┼──────► │   ├─ spawns `ti build ...` │
│       ◄── live log (WS)    ────┼────────┼───└─ streams logs back     │
└────────────────────────────────┘        └────────────────────────────┘
```

Sync is a stateless manifest diff (a poor man's rsync): the client hashes the
project, the daemon answers with what it is missing or has too much of, and only
those files are uploaded as one gzipped tar. Content hashes — not timestamps —
are the source of truth, so clock drift doesn't matter and interrupted uploads
are picked up on the next run. `build/`, `node_modules/` and `.git/` are never
synced; in an Alloy project neither is the top-level `Resources/`, which the
alloy compiler regenerates during the remote build.

## Setup

Requires Node ≥ 18 on both machines.

### On the build machine (Mac)

```sh
git clone <this repo> && cd tiForge && npm install
node bin/tiforged.js --token SOME_SECRET
```

The daemon listens on port 7331, mirrors projects into `~/.tiforge/projects/`,
and announces itself on the LAN via mDNS. Options: `--port`, `--root`,
`--build-cmd` (default `ti`), `--build-timeout` (minutes, default 30),
`--no-advertise`. `tiforged` is a shortcut for `tiforge daemon` and takes the
same flags.

### On the dev machine (Linux)

```sh
git clone <this repo> && cd tiForge && npm install
node bin/tiforge.js install      # registers `ti forge` with the Titanium CLI
```

All settings live in the Titanium CLI's own config (`~/.titanium/config.json`)
under the `forge` node — no per-project config files. Run `ti forge --init` to
discover daemons via mDNS and store them automatically (re-running updates URLs
and keeps your tokens), then set the token. Or do it by hand:

```sh
ti config forge.hosts.mac.url http://192.168.1.3:7331
ti config forge.hosts.mac.token SOME_SECRET
ti config forge.hosts.mac.buildArgs "-p ios -T simulator --no-prompt"
ti config forge.hosts.mac.dir /Volumes/SSD/builds   # optional, see below
ti config forge.exclude "dist,tmp"        # optional, comma/space separated
```

Every host under `forge.hosts.*` takes part in syncs and builds. `buildArgs` is
a space-separated string (ti config values are strings).

## Usage

```sh
ti forge                  # sync + remote build on all configured hosts
ti forge --force          # same, but kill/cancel remote builds first
ti forge --clear          # stop all builds and empty the queue, nothing else
ti forge --sync           # only push changed files, no build
ti forge --init           # discover daemons into ti config
ti forge --discover       # list tiForge daemons on the network
```

Remote output appears prefixed with `[tiForge:mac]`, uploads show live progress.
The daemon always enforces `--no-prompt` so nothing hangs on the other machine.
Builds run one at a time per daemon; extra builds queue and the client shows the
queue position. `--force` clears the way: the running build is killed (including
its xcodebuild children) and queued ones are cancelled.

The same commands exist without the ti CLI (e.g. for CI): `tiforge sync`,
`tiforge build [-- <remote args>]`, `tiforge init`, `tiforge discover`. Make
`tiforge` available everywhere with `npm link` or by symlinking `bin/tiforge.js`
into a directory on your PATH; `npm link` installs `tiforged` alongside it.

### Where the daemon puts the files

The mirror is named after your project's own directory, so `~/dev/MyApp` builds
in `MyApp` — not under its bundle id. Characters a path segment cannot carry are
folded to `-`; `--name` overrides the name outright.

By default a project lands in `~/.tiforge/projects/MyApp`. Set `dir` on a host
to mirror somewhere else instead — an absolute path **on the daemon machine**,
per host, created if it does not exist. The project name is still appended, so
one `dir` serves several projects. Changing it starts an empty mirror at the new
location (the next sync uploads everything once) and leaves the old copy behind.
Outside the ti CLI, `tiforge sync`/`build` take `--dir PATH` for a single run.

## Security notes

- Always set a `--token`. The daemon runs build commands for anyone who presents
  it, with client-supplied arguments — treat it like an SSH key, and only run it
  on trusted networks. There is no TLS yet; put it behind a VPN if the network
  isn't trusted.
- The token is the whole security boundary. A client that has it also picks the
  mirror location (`dir`), so it can write anywhere that user can write.
- Project names are restricted to `[A-Za-z0-9._-]` and tar extraction is
  confined to the project directory.

## Protocol

| Route | Meaning |
| --- | --- |
| `GET /ping` | daemon name, platform, version |
| `POST /projects/:name/manifest` | body `{files, exclude}` → `{needed, deleted}` |
| `POST /projects/:name/files` | gzipped tar of the needed files |
| `POST /projects/:name/build` | body `{args}` → `{buildId}` (builds run serially) |
| `GET /builds/:id` | status + exit code |
| `WS /builds/:id/log` | `{type:'log',data}` frames, then `{type:'exit',code}` |

Auth on every route via the `x-tiforge-token` header. The three
`/projects/:name/*` routes accept `?dir=<absolute path>` to override the
daemon's project root for that request; the project name is appended to it.

## Not yet implemented

- Pull build artifacts (`.app`/`.ipa`) back to the dev machine
- Watch mode for LiveView-style continuous sync
