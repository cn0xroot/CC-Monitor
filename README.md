# CC-Monitor

English | [简体中文](./README.zh-CN.md)

Ever let an AI agent write code for you and had no idea what it actually did to your machine
along the way? Give this a try. It monitors what Claude Code does on your machine — file
reads/writes, shell command execution, network access — and blocks or asks for confirmation
on high-risk operations, so an AI coding agent can't quietly damage your system or leak data.
Everything is audit-logged. The technical design doc is available in
[English](./DESIGN.en.md) and [Chinese](./DESIGN.md).

## Web UI

`webui/` is a standalone Node.js service that provides a browser UI:

```bash
cd webui
npm install
node server.js          # listens on http://127.0.0.1:9999 by default, localhost-only
```

- **Home**: overview stats — live terminal session count, total Claude Code sessions detected, total audit events, blocked/suspected-bypass counts, file read/write/edit/delete counts, and breakdowns by log type and risk level. The "total sessions" / "total events" / "blocked high-risk operations" cards are clickable for drilldown detail (session list, per-event-type breakdown with owning session, and the full list of blocked operations, respectively).
- **Log Audit**: a full-width, live-updating audit log view (filterable by session — the session dropdown shows "folder · model · short ID" instead of an opaque ID string), reusing the same human-readable event-translation logic as the CLI.
- **Terminal Sessions**: open a Claude Code terminal directly in the browser (a PTY spawned via `node-pty`) instead of switching to a local terminal app; rendered with `xterm.js` + the WebGL addon, GPU-accelerated when available and falling back to Canvas otherwise. The sidebar can switch to a **grid view** (herdr-style) showing every live session on one screen at once; clicking a pane routes keyboard input to it.
- **Claude Tap**: view the **full conversation content** sent to/received from the model for a given session (not just "which tool was called") — text, thinking, tool calls, tool results, token usage, each field color-coded. The data source is Claude Code's own local transcript JSONL file (the `transcript_path` field in the hook payload) — not packet capture or MITM. CLI equivalent: `CC-Monitor tap [--session ID] [-f]`.
- **AI Approvals**: mirrors Claude Code's "allow this action?" confirmation into the
  Web UI — similar in spirit to [Vibe Island](https://vibeisland.app/) popping an
  Allow/Deny card in the Mac notch, except cross-platform (a web page instead of a
  Mac-only UI) and, for now, scoped to the operations our own rule table flags as
  `confirm` (anything else still goes through Claude Code's own native prompt — we never
  silently wave it through). The same request can be answered either at the terminal that
  triggered it (y/N) or from this page — whichever answers first wins. Choosing "allow" on
  the web page makes Claude Code skip its own native popup entirely, via the hook's
  `permissionDecision: allow` output, instead of asking twice. Options: allow once, deny
  once, allow and don't ask again for 10/30 minutes, or always allow (scoped to this
  session only — other sessions running the same command still get asked). Supports browser
  desktop notifications (the Notification API) — new requests raise a system notification
  even when this tab isn't open, click it to jump straight back in.
- **Status**: account-level usage (the 5-hour session window / weekly quota / per-model weekly quota + reset times, queried from the same `api.anthropic.com/api/oauth/usage` endpoint and OAuth credentials as [ccstatusline](https://github.com/sirmalloc/ccstatusline)) plus per-session model, token usage, throughput (tok/s, estimated from the transcript), cwd, git branch, uptime, and blocked-operation counts.
- **Language toggle + multiple themes**: a language button (中文/EN) and a theme dropdown (Brand/Dark/Light/Dracula/Nord/Midnight/Ocean/Forest/Sunset/Rose — the last five ported from [AI_Web_Search](https://github.com/cn0xroot/AI_Web_Search)'s color scheme) in the top bar, both persisted to `localStorage`. Translation covers UI chrome (nav, buttons, titles, empty-state hints, risk/operation/status labels) but not the data itself (raw command text, tool output, transcript content). The risk/operation-type/status badges in the audit log use fixed, highly saturated colors that don't change with the theme; high-risk rows are shown in bold red.

Static assets are served with `Cache-Control: no-store` since this UI is still iterating fast — refresh the page after a code change and you'll see the latest version, no stale browser cache to worry about.

Binds to `127.0.0.1` only by default: this tool can spawn terminal processes directly and has
no authentication. The Home tab has an "Allow access from other devices" switch, but it only
sets a flag — the actual security boundary is the address the process was bound to at startup,
which a web page can't change at runtime. To really listen on all interfaces, an admin has to
explicitly set `CC_MONITOR_WEBUI_HOST=0.0.0.0` and restart the service; only then does the
switch actually do anything (it defaults to off even when bound to `0.0.0.0`, rejecting every
non-local request until turned on).

## Screenshots

| Home overview | Session list drilldown |
|---|---|
| ![Home](./pic/home-en.png) | ![Session list](./pic/home-sessions-en.png) |

| Event type breakdown | Blocked high-risk operations |
|---|---|
| ![Event type breakdown](./pic/home-events-en.png) | ![Blocked operations](./pic/home-blocked-en.png) |

| Audit log (Chinese UI shown; language toggle available) |
|---|
| ![Audit log](./pic/audit-log-zh.png) |

## Overview

CC-Monitor has a two-layer architecture:

- **Application layer (Claude Code Hooks)**: registers `PreToolUse`/`PostToolUse` hooks to get
  semantic info on every tool call (tool name, command, file path), then allows/blocks/asks based
  on configurable rules. This is the primary layer — cheap and broad coverage.
- **System layer (eBPF probe, Linux only)**: `CC-Monitor-probe` uses `bpftrace` to independently trace,
  at the kernel level, every `execve`/`connect` made by the entire process subtree spawned by the
  `claude` process — completely independent of Claude Code's own cooperation. This is the second
  line of defense: it can still catch anomalies even if the hooks config itself gets tampered with
  or bypassed.

Capabilities:

| Capability | Description |
|---|---|
| Block high-risk operations | Operations matching a rule (`Bash`/`Write`/`Edit`/...) can be denied outright (e.g. `rm -rf /`, writing to `~/.ssh/`) |
| Interactive confirmation | Medium-risk operations prompt for confirmation in the terminal + a desktop notification; times out to "deny" if there's no tty |
| Audit log | Every event is persisted to SQLite, with the full `tool_input`/`tool_response` payload |
| Human-readable live log | `CC-Monitor tail` turns raw JSON into "event type + summary + result", auto-colored in a real terminal, with Bash commands syntax-highlighted (command name / flags / strings / variables / pipes) |
| Bypass detection | `CC-Monitor verify` cross-checks what the system probe observed against what the hooks recorded, and flags commands the probe saw but the hooks never logged |
| Network visibility | eBPF captures the destination IP:port of every `connect()` call directly — no TLS termination, no CA certificate to install |

## How It Works

The Overview above is *what* it does; this is *how*, and every mechanism maps directly onto the
source (full depth in [DESIGN.en.md](./DESIGN.en.md)):

- **Hook interception**: before and after every tool call, Claude Code writes a JSON payload to the
  configured hook command's stdin and waits synchronously for it to exit. `CC-Monitor-hook` exiting
  with code 2 means "deny" — whatever it printed to stderr gets surfaced back to Claude Code. It's a
  one-shot subprocess spawned per call, not a long-running daemon, so there's no "the monitor process
  died and now nothing is enforced" failure mode (and also no need to restart anything after editing
  rules — the next call picks them up immediately).
- **Rule engine**: `default_rules.json` is an ordered rule list; `policy.evaluate()` walks it in order
  and the first match wins, so more specific rules need to come before more general catch-alls. Each
  rule declares `tools` (which tools it applies to), `field` (which key to read out of `tool_input` —
  e.g. `command`/`file_path`/`url`), a regex `pattern`, and a `risk`/`action`. The rule file is copied
  from `default_rules.json` into `~/.cc-monitor/rules.json` on first use, and can be edited from there.
- **System-layer eBPF probe**: `probe_linux.bt` attaches to kernel tracepoints like `execve`/`connect`.
  It first recognizes Claude Code's own process via `comm=="claude"`, then listens for
  `sched_process_fork` events to propagate a "being monitored" flag down through every descendant
  process it spawns — tracking continues even if a child process renames itself. `CC-Monitor verify`
  matches commands the probe observed against what the hooks logged in the same time window (with
  quote-normalization to handle how zsh's snapshot wrapper escapes quotes), and flags anything the
  probe saw that the hooks never recorded.
- **Claude Tap**: the hook's JSON payload includes a `transcript_path` field pointing at Claude Code's
  own local conversation transcript JSONL file. Reading that file and parsing its `user`/`assistant`/
  `tool_use`/`tool_result` entries reconstructs the full conversation — no packet capture, no CA
  certificate, no MITM proxy involved.
- **Account usage display**: reads the OAuth token Claude Code itself stores in
  `~/.claude/.credentials.json`, then calls Anthropic's own
  `api.anthropic.com/api/oauth/usage` endpoint with that token (adding the
  `anthropic-beta: oauth-2025-04-20` header) — the exact same credential and endpoint
  [ccstatusline](https://github.com/sirmalloc/ccstatusline) uses, not a separately maintained usage
  tracker.
- **Web terminal**: `node-pty` spawns a real pseudo-terminal (PTY) — no different from opening a
  terminal window locally — then types `claude\r` into it automatically to launch Claude Code. The
  first time Claude Code opens a directory it hasn't seen before, it shows a "do you trust this
  folder?" prompt defaulting to "No, exit"; this is detected by watching for that exact banner text
  and answered automatically (down-arrow + enter, selecting "Yes, I trust this folder") — otherwise
  the very next stray Enter keypress would silently exit Claude Code back to a bare shell while the
  terminal still looked perfectly functional.
- **Data persistence/archiving**: "Archive current data" on the Home tab uses SQLite's own `backup()`
  API to take a full snapshot of the current `events.db` (not a plain file copy — `backup()` correctly
  handles data that hasn't been checkpointed out of the WAL journal yet), saved under
  `~/.cc-monitor/archives/`; "Clear current data" runs `DELETE` against the same database and resets
  the autoincrement counter.

## Installation

Dependency: Python 3 (standard library only, no third-party packages). The system-layer probe
additionally needs `bpftrace` on Linux.

**In a hurry?** Run `./install.sh` to do it all in one step (hook registration + Web UI
dependencies), then `./start.sh` to launch the Web UI (it installs dependencies on first run if
needed). For more control, the manual steps are below.

There are two ways to install it, with identical end results — pick whichever fits:

### Option 1: run it in place (touches nothing outside this directory)

```bash
# 1. Put the whole CC-Monitor directory wherever you want it (assumed here: ~/Tools/CC-Monitor)
cd ~/Tools/CC-Monitor

# 2. Install the hooks into your Claude Code config (also chmod +x's everything under bin/)
python3 install.py                              # global install: writes ~/.claude/settings.json
python3 install.py --project /path/to/project    # project-scoped install
python3 install.py --target /path/to/settings.json  # explicit settings.json path (for cross-user installs)

# 3. (optional) install bpftrace if you want the system-layer probe
sudo apt install bpftrace        # Debian/Ubuntu
# see bpftrace's own docs for other distros; the system-layer probe is not implemented on macOS yet
```

The installer merges into the `PreToolUse`/`PostToolUse` hook arrays and de-duplicates by exact
`command` string, so it **never overwrites** any hooks you already have configured; a corrupted
`settings.json` gets backed up to `.json.bak` before being rebuilt. **Restart Claude Code** —
only new sessions pick up the updated config.

### Option 2: `make install` onto the system path

If you'd rather have a global command and not have to remember where this checkout lives:

```bash
sudo make install                          # defaults to /usr/local/lib/cc-monitor + /usr/local/bin
sudo make install PREFIX=/opt/cc-monitor   # or pick your own prefix

# afterwards, the commands work from any directory; still do step 2 from Option 1 to
# register the hooks (using the path make install prints out):
CC-Monitor tail -v
python3 /usr/local/lib/cc-monitor/install.py
```

`make install` only copies the code onto the system and sets up the command-line symlinks — it
**does not** touch your `~/.claude/settings.json` on its own; registering the hooks is a separate,
explicit `install.py` run (the exact path is printed at the end of `make install`). `sudo make
uninstall` reverses it (again, code and symlinks only — any hooks already registered in
`settings.json` need to be removed by hand).

## Build

CC-Monitor is pure Python (standard library only: `sqlite3`, `json`, `argparse`, `re`, ...) —
**there is no build/compile step**:

- `bin/CC-Monitor`, `bin/CC-Monitor-hook`, and `bin/CC-Monitor-probe` are executable scripts with a
  `#!/usr/bin/env python3` shebang; `install.py` chmod's them automatically.
- The system-layer probe depends on `bpftrace`, which is a prebuilt binary from your system's
  package manager — nothing to compile. `cc_monitor/probe_linux.bt` is a bpftrace script, interpreted
  at runtime by `bpftrace` itself.
- `make install` in the `Makefile` isn't a build step either — it just copies files under `PREFIX`
  and creates command-line symlinks; see "Installation" above.
- It is **not** currently packaged as a single-file executable (e.g. via PyInstaller/Nuitka) —
  that's on the TODO list below.

## Usage

```bash
# Live-tail monitored events (Ctrl+C to quit)
./bin/CC-Monitor tail
./bin/CC-Monitor tail -v          # also print the raw JSON

# Show the currently active rules
./bin/CC-Monitor rules

# Show stats (counts by risk level / decision)
./bin/CC-Monitor stats

# System-layer probe (needs root; cross-checks whether hooks are being bypassed)
sudo ./bin/CC-Monitor-probe

# Show records the probe flagged as "possibly bypassing the hooks"
./bin/CC-Monitor verify
```

**Environment variables**:

| Variable | Effect |
|---|---|
| `CC_MONITOR_HOME` | Overrides the event DB / rules file directory (default `~/.cc-monitor/`) |
| `CC_MONITOR_COLOR` | `always`/`never` to force terminal color on/off (default: auto-detect a real tty) |
| `NO_COLOR` | Forces color off when set (standard convention) |

Events and rules live under `~/.cc-monitor/`: `events.db` (SQLite audit log) and `rules.json`
(editable rules — edits apply immediately, no restart needed).

**Rule format** (`rules.json` is an array of rules):

```json
{
  "id": "rule_name",
  "risk": "high | medium | low",
  "action": "block | confirm | log",
  "tools": ["Bash"],
  "field": "command | file_path | url",
  "pattern": "regular expression"
}
```

- `block`: deny outright; Claude Code receives the denial reason.
- `confirm`: prompts for confirmation in the terminal (waits for `y` on the tty) + a desktop
  notification; denies by default with no tty or on timeout.
- `log`: allow, but record it in the audit log.

Default rules live in [cc_monitor/default_rules.json](./cc_monitor/default_rules.json), covering: dangerous
deletes, disk-overwrite commands, `curl|bash`, recursive `chmod 777`, `sudo`, `git push --force`,
reading/writing SSH keys and credential files, writing to system directories, and more.

## Development Progress

For exactly what shipped in each version, see [CHANGELOG.en.md](./CHANGELOG.en.md)
([中文](./CHANGELOG.md)).

### Implemented

- [x] Application-layer hook interceptor (`PreToolUse`/`PostToolUse`), covering Bash/Write/Edit/Read/WebFetch and other tools
- [x] Policy engine: regex rule matching + three actions (block/confirm/log) + three risk tiers
- [x] SQLite audit log (`events.db`), retaining the full hook input/output for every event
- [x] CLI: `CC-Monitor tail` (live view) / `rules` (view rules) / `stats` (stats) / `verify` (bypass detection)
- [x] Human-readable event formatting: raw JSON turned into "event type + summary + result"
- [x] Terminal color output: independent coloring for risk level / decision / rule name, with `NO_COLOR`/`CC_MONITOR_COLOR` support
- [x] Bash command syntax highlighting (command name / flags / strings / variables / pipes & redirects, each colored separately)
- [x] Terminal confirmation (`/dev/tty` interaction) + desktop notification (`notify-send`/`osascript`)
- [x] Installer: safely merges hooks into `settings.json` (global / project / custom-path modes) without touching existing config
- [x] System-layer probe (`CC-Monitor-probe`, Linux only): eBPF tracing of the Claude Code process tree's `execve`/`connect`
- [x] Bypass detection: fuzzy-matches what the probe observed against hook records (process tree + time window + quote-stripped substring match), flagging `hook_bypass_suspected`
- [x] Network visibility: eBPF captures `connect()` destination IP:port + reverse DNS, no MITM proxy needed

### Not implemented / TODO

- [ ] **macOS support**: the Endpoint Security Framework approach sketched in the design doc
      (requires a signed system extension + user-granted Full Disk Access) is entirely
      unimplemented; CC-Monitor has only been validated on Linux so far
- [ ] **Mandatory sandboxing** (Phase 3): Landlock LSM / bubblewrap (Linux), `sandbox-exec` /
      containerization (macOS) — currently the tool can only block-and-alert, not actually cage
      Claude Code inside a hard sandbox
- [ ] **Making `CC-Monitor-probe` persistent**: currently started manually with `sudo`; no systemd
      unit / autostart yet — whether to run it as a persistent service is left as the user's own decision
- [ ] **Tamper-resistant audit log**: the log runs under the same user privileges as the monitored
      process, so it could in theory be deleted/altered by that same user; hardening (off-host
      forwarding, append-only permissions via `chattr +a`, etc.) is not done yet
- [ ] **Cross-machine log aggregation / a shared rule-set community** (Phase 3): currently a
      purely local, single-machine tool
- [ ] **A graphical confirmation dialog** for high-risk operations: currently only a text-based
      tty confirmation, no clickable GUI allow/deny dialog
- [ ] **Semantic rule matching**: currently pure regex; no lightweight-model-assisted intent
      detection (e.g. recognizing an equivalently dangerous operation phrased differently)
- [ ] **Packaging as a single-file executable**: currently runs directly against the system Python
      install; no PyInstaller/Nuitka-style packaging

## Known Limitations

- **The Web UI process and the terminal(s) you normally run `claude` in must be the same OS
  user**, or each writes to its own separate `~/.cc-monitor/` database and neither can see the
  other's data (confirmation prompts and audit events from your terminal simply never appear on
  the Web UI's AI Approvals / audit log pages) — `CONFIG_DIR` is derived from the current
  process's `$HOME`, not a shared global path. This bites you if you start the Web UI with
  `sudo`/as root while your normal `claude` usage runs under your own account; `start.sh` warns
  when it detects a root launch, and the Web UI itself logs its effective username on startup so
  you can double-check.
- `confirm` requires `/dev/tty`; with no interactive terminal (CI, headless environments) it
  denies by default.
- The probe's bypass detection is fuzzy matching, not precise semantic analysis; under heavy
  system load the probe's processing can lag a few seconds, so `CC-Monitor verify` may need a moment
  before showing the latest results.
- The network layer only sees IP:port, not the real hostname (best-effort reverse DNS, not always
  accurate).

## Contributors

- [cn0xroot](https://github.com/cn0xroot)
