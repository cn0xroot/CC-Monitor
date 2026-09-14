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

- **Home**:
  - **Audit control**: a three-state toggle — running / paused / stopped (merged into one
    button plus a separate stop button). `paused` still evaluates rules and logs normally,
    but never actually blocks or asks for confirmation; `stopped` doesn't intervene at all —
    no evaluation, no logging. A persistent status pill sits in the top bar.
  - **Claude Code identity check**: detects which OS user every running `claude` process
    belongs to (cross-platform, implemented via `ps`), and flags it prominently when that
    differs from the Web UI's own user — the Web UI and the hooks each resolve
    `~/.cc-monitor/` from their own process's `$HOME`, so a mismatch means the two sides
    silently write to completely different databases; this card makes that otherwise-
    invisible situation visible. Click through for each process's PID/user/working directory.
  - **Overview stats**: live terminal session count, total Claude Code sessions detected,
    total audit events (`hook_pre` + `hook_post` + system-layer events combined),
    blocked/suspected-bypass counts, **tool calls** (counts `hook_pre` only — a more direct
    "how many tool invocations actually happened" number than the raw event total), **MCP
    calls** (identified via the `mcp__<server>__<tool>` naming convention, click through for
    a per-server breakdown), and **AI trajectory** (domains/IPs Claude Code has visited,
    backed by the same data as the Network tab). The "total sessions" / "total events" /
    "blocked operations" / "tool calls" / "MCP calls" / "AI trajectory" cards are all
    clickable for drilldown detail.
  - **File operation stats**: read/write/edit/delete counts, each clickable for detail.
  - **Install operation stats**: grouped by which install-type rule matched — pip / system
    package manager (apt/yum/dnf/pacman/brew/port) / npm global install / other — click through for the
    exact install commands.
  - **GitHub operation stats**: git push / git clone / git commit / git pull-fetch / gh CLI
    (PR/Issue/API…) / other git operations, six cards, classified from the Bash command text
    itself (most git/gh commands don't violate any policy rule, so they never get a
    `matched_rule` and couldn't reuse the install-ops trick). Click through for the exact
    session, folder, timestamp, and command.
  - **Anthropic account info**: name, email, organization, org role, plan type, rate-limit
    tier, billing type, and account/subscription creation dates, read straight from Claude
    Code's own local global config file (`~/.claude.json`'s `oauthAccount` field) — no
    network call, same source [ccstatusline](https://github.com/sirmalloc/ccstatusline)'s
    "Claude Account Email" widget uses. Plus account-level usage/quota (same data source as
    the Status tab — the session quota shows "remaining %" with a conky-style stepped
    palette, weekly quotas show "used %" with a continuous red→yellow→green gradient, and
    per-model quotas like Fable are detected dynamically rather than hardcoded), the
    `limits[]` breakdown (a progress bar, plus a purple "how far through this window" bar
    next to the reset time) and `spend` (whether pay-as-you-go usage credits are enabled, and
    how much has been used).
  - **Data management**: archive the current event data (a full SQLite `backup()` snapshot)
    or clear it to start counting from zero; breakdowns by log type and risk level.
- **Log Audit**: a full-width, live-updating audit log view (filterable by session — the session dropdown shows "folder · model · short ID" instead of an opaque ID string), reusing the same human-readable event-translation logic as the CLI.
- **Terminal Sessions**: open a Claude Code terminal directly in the browser (a PTY spawned via `node-pty`) instead of switching to a local terminal app; rendered with `xterm.js` + the WebGL addon, GPU-accelerated when available and falling back to Canvas otherwise. The sidebar can switch to a **grid view** (herdr-style) showing every live session on one screen at once; clicking a pane routes keyboard input to it.
- **Claude Tap**: view the **full conversation content** sent to/received from the model for a given session (not just "which tool was called") — text, thinking, tool calls, tool results, token usage, each field color-coded. The data source is Claude Code's own local transcript JSONL file (the `transcript_path` field in the hook payload) — not packet capture or MITM. CLI equivalent: `CC-Monitor tap [--session ID] [-f]`.
- **AI Approvals**: mirrors Claude Code's "allow this action?" confirmation into the Web UI
  — similar in spirit to [Vibe Island](https://vibeisland.app/) popping an Allow/Deny card in
  the Mac notch, except cross-platform (a web page instead of a Mac-only UI). Two kinds of
  prompts land here:
  - operations our own rule table flags as `confirm` (decided by our rules at `PreToolUse`);
  - **Claude Code's own native "Do you want to proceed?" dialog** (the `PermissionRequest`
    hook event — calls that matched no rule but that Claude Code's permission system wants
    a human to approve). An answer from the web page or the terminal is returned via
    `decision.behavior`; if nobody answers (90s timeout) or you press Enter at the terminal,
    the request is handed back untouched to the native dialog — installing CC-Monitor never
    removes that safety net.
  - The same request can be answered either at the terminal that triggered it (y/N) or from
    this page — whichever answers first wins. Choosing "allow" on the web page makes Claude
    Code skip its own native popup entirely, via the hook's `permissionDecision: allow`
    output, instead of asking twice.
  - Options: allow once, deny once, allow and don't ask again for 10/30 minutes, or always
    allow (scoped to this session only).
  - **Desktop app (Electron)** does not use the browser path (in an Electron renderer
    `Notification.permission` is always "granted", yet macOS silently refuses notifications
    from an app that isn't properly signed): the main process polls the pending list itself
    and on a new request plays the system alert sound + bounces the Dock icon + sets a badge
    count, plus a system notification when the OS allows one (click → approvals tab).
    `npm run electron` runs the ad-hoc-signed Electron.app from node_modules, so on macOS the
    system notification always fails (`UNErrorDomain error 1`) — you get sound/Dock/badge only;
    a Developer-ID-signed build is needed for real notifications. The hook side additionally
    sends one `osascript` notification per request (attributed to "Script Editor"); macOS asks
    once whether to allow it — if declined, re-enable it under System Settings → Notifications
    → Script Editor.
  - Supports browser desktop notifications (the Notification API) — new requests raise a
    system notification even when this tab isn't open, click it to jump straight back in.
  - **History table**: every resolved request stays on record (the underlying table is never
    purged by "clear current data"), with time, session, tool, matched rule, matched value,
    outcome, and resolved-via. For `notify`-kind records (`AskUserQuestion` and friends), it
    also captures the user's actual answer from the terminal.
- **Status**:
  - The same Anthropic account info (name/email/organization/plan) as the Home page, plus
    account-level usage (the 5-hour session window / weekly quota / per-model weekly quota +
    reset times, queried from the same `api.anthropic.com/api/oauth/usage` endpoint and OAuth
    credentials as [ccstatusline](https://github.com/sirmalloc/ccstatusline)).
  - **Model Usage table**: token usage summed by model (Sonnet/Opus/…) across every
    monitored session.
  - Per-session model, token usage, throughput (tok/s, estimated from the transcript), and a
    `ccstatusline`-compatible `Σ Total / Cached` token summary (same accounting: total =
    input+output+cached, cached = cache-read+cache-creation).
  - **Context window usage %**: estimated against a standard 200K context window (Claude
    Code doesn't report the exact window size to our hooks, so this is an approximation).
  - **Context compaction count**: a real detection of `compact_boundary` events in the
    transcript, not an estimate.
  - cwd, git branch, uptime, and blocked-operation counts.
- **Network**: the actual network connections the Claude Code process tree has made —
  destination IP/port, hostname, upload/download byte counts, connection count, plus a world
  map plotting roughly where those destinations are. All of this comes from the system-layer
  probe (`cc_monitor/probe_linux.bt`, Linux + eBPF) — not packet capture or MITM.
  - **Domain capture**: a `uprobe:libc:getaddrinfo` records the hostname the moment the
    application resolves it, instead of reverse-DNS-ing the IP afterward — many cloud/CDN
    egress IPs never had a PTR record configured, so reverse DNS can't recover a domain that
    was never registered in reverse; this method isn't affected.
  - **Byte counts**: `tcp_sendmsg`/`tcp_cleanup_rbuf` kernel probes, since the probe
    previously only knew "connected to this IP:port," not how much data moved.
  - **IP geolocation**: a local database (no per-IP third-party API calls) — either MaxMind
    GeoLite2 or the no-signup-needed DB-IP Lite both work, see Requirements below; without
    one, the map and location column are simply empty and the page honestly says "no GeoIP
    database configured" instead of faking data.
  - **World map**: drawn entirely in WebGL2 (equirectangular projection + a bundled low-res
    coastline outline), following the approach from
    [BeeEye](https://github.com/cn0xroot/BeeEye)'s `WorldMap.jsx` — no map-tile service
    dependency.
  - **Connection detail**: "Connections" is clickable both per target row and on the two
    summary cards ("Total connections" / "Distinct IPs") — opens every connection's time,
    originating process, and PID.
  - With the probe not installed or not running, this page just shows empty data.
- **Appearance settings**: a ⚙ button in the top bar opens a settings dialog.
  - **Color theme**: a visual swatch grid — each of the 10 themes (Brand/Dark/Light/Dracula/
    Nord/Midnight/Ocean/Forest/Sunset/Rose, the last five ported from
    [AI_Web_Search](https://github.com/cn0xroot/AI_Web_Search)'s color scheme) shown as its
    own accent-color dot with an active highlight; the original top-bar theme dropdown still
    works too and stays in sync.
  - **Interface font** (system default / monospace / serif / rounded / Kaiti / Heiti
    (Source Han Sans) / Songti (Source Han Serif)) and **interface font size** (12–18px
    slider, applied at the root element with every `font-size` in the stylesheet in `rem`,
    so one change scales the whole app proportionally) — new settings, with a live
    preview, persisted to `localStorage`. The Chinese font options aren't bundled as font
    files (a full CJK glyph set is 17–21MB each, which would make the first font switch
    painfully slow) — they're plain font-name references that only render correctly where
    the visitor's system already has a matching font installed.
  - **Language toggle**: translation covers UI chrome (nav, buttons, titles, empty-state
    hints, risk/operation/status labels) but not the data itself (raw command text, tool
    output, transcript content). The risk/operation-type/status badges in the audit log use
    fixed, highly saturated colors that don't change with the theme; high-risk rows are shown
    in bold red.

Static assets are served with `Cache-Control: no-store` since this UI is still iterating fast — refresh the page after a code change and you'll see the latest version, no stale browser cache to worry about.

Binds to `127.0.0.1` only by default: this tool can spawn terminal processes directly and has
no authentication. The Home tab has an "Allow access from other devices" switch, but it only
sets a flag — the actual security boundary is the address the process was bound to at startup,
which a web page can't change at runtime. To really listen on all interfaces, an admin has to
explicitly set `CC_MONITOR_WEBUI_HOST=0.0.0.0` and restart the service; only then does the
switch actually do anything (it defaults to off even when bound to `0.0.0.0`, rejecting every
non-local request until turned on).

## Desktop app (Electron)

If you'd rather not open a browser and run `node server.js` by hand, `webui/` also has an
Electron wrapper — it directly `require`s the existing `server.js` (Express + ws + node-pty +
better-sqlite3) with zero server-side code changes, and runs as a standalone windowed app.

```bash
cd webui
npm install
npm run electron          # dev mode: runs directly, no packaging needed
```

Binds to `127.0.0.1:9998` (distinct from the web version's default 9999, so both can run at
the same time).

To build a distributable installer:

```bash
npm run dist:linux   # AppImage (x64 + arm64)
npm run dist:mac     # universal dmg (Intel + Apple Silicon)
```

Both scripts run `electron-rebuild` first to recompile `node-pty`/`better-sqlite3` against
Electron's bundled Node ABI — these packages ship prebuilt binaries that don't match
Electron's Node version out of the box, so this rebuild step is required, not an optional
optimization.

**Known status**: the Electron version pinned in `devDependencies` (`^44.0.0`) isn't
arbitrary — an earlier build on the default 33.x reproducibly segfaulted on startup on a
recent AMD CPU (Zen 5), and switching to 44.x fixed it; this looks like a Chromium/CPU
compatibility bug in that older Electron release, so don't roll the version back. So far only
the "packaged app starts and its embedded server listens correctly" path has been verified
end-to-end on Linux x64; the macOS and Linux ARM64 builds haven't been validated end-to-end
yet.

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
  - **macOS**: the same `CC-Monitor-probe` command switches to `cc_monitor/probe_darwin.py`, which
    samples the claude process tree's connections and byte counts every 2s with the built-in
    `nettop` — **no root needed**. Network only (traffic page / world map / AI trajectory): there
    is no `execve` observation (the bypass detection behind `CC-Monitor verify` stays Linux-only)
    and hostnames fall back to reverse DNS.
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
- **Account usage display**: reads the OAuth token Claude Code itself stores (Linux:
  `~/.claude/.credentials.json`; macOS: no file — it lives in the login Keychain as the
  generic-password item `Claude Code-credentials`, read via `security find-generic-password`),
  then calls Anthropic's own
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

### Requirements

- **Hooks (`cc_monitor/`)**: Python 3.8+, standard library only, no third-party packages. The
  system-layer probe additionally needs `bpftrace` on Linux (optional — the hooks work fine
  without it).
- **Web UI (`webui/`)**: Node.js **≥ 22** — not an arbitrary floor, it's what `better-sqlite3`
  itself declares in its `package.json` `engines` field (`express` only needs Node ≥ 18, but
  `better-sqlite3` requires 22; an older Node will likely fail during install or at startup).
  Check `node --version` before installing, e.g. via [nvm](https://github.com/nvm-sh/nvm).
- **GeoIP location on the Network tab (optional)**: uses the `maxmind` npm package to read a
  local database file, which isn't shipped in this repo. Without one, the Network tab still
  works — the location column and map just have no data, and the page says so honestly
  rather than affecting the connection/byte-count stats. Two ways to get a database:
  - **No account needed (recommended — this is what `./install.sh` does by default)**:
    [sapics/ip-location-db](https://github.com/sapics/ip-location-db)
    republishes DB-IP Lite data ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
    city-level accuracy) as ready-to-use `.mmdb` files, updated automatically. Step 4 of
    `install.sh` downloads it to `~/.cc-monitor/dbip-city.mmdb` (skipped if any `.mmdb` is
    already there; a failed download only warns; set `CC_MONITOR_GEOIP_URL` to use a mirror).
    Manual download works too:
    ```bash
    curl -L -o ~/.cc-monitor/dbip-city.mmdb \
      https://github.com/sapics/ip-location-db/releases/download/latest/dbip-city-ipv4.mmdb
    ```
  - **Official MaxMind GeoLite2**: usually more accurate, but requires signing up for a free
    account at [MaxMind](https://www.maxmind.com/en/geolite2/signup), generating a license
    key, and manually downloading `GeoLite2-City.mmdb` to
    `~/.cc-monitor/GeoLite2-City.mmdb`.

  The two databases use different field layouts (MaxMind nests fields, DB-IP Lite is flat) —
  `geoip.js` recognizes both, no extra configuration needed either way. `CC_MONITOR_GEOIP_DB`
  can point at a different path than the defaults above.

**Verified working environment** (not the only one that works — just the one this has
actually been tested and confirmed on): Ubuntu 24.04 LTS (kernel 7.0, x86_64), AMD Ryzen 9
9950X (Zen 5), Node.js v22.17.1, npm 10.9.2, Python 3.13.5. The desktop (Electron) build was
additionally verified to crash on startup on this CPU with the originally-pinned Electron
33.x, and to run correctly after upgrading to 44.x (see the Desktop app section below) — which
is why that version isn't pinned back down.

**In a hurry?** Run `./install.sh` to do it all in one step (hook registration + Web UI
dependencies + GeoIP database download — pass `--skip-geoip` or set `CC_MONITOR_SKIP_GEOIP=1`
to skip that last step), then `./start.sh` to launch the Web UI (it installs dependencies on
first run if needed). For more control, the manual steps are below.

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
# see bpftrace's own docs for other distros; macOS needs nothing extra (the probe uses the built-in nettop)
```

The installer merges into the `PreToolUse`/`PostToolUse`/`PermissionRequest` hook arrays and de-duplicates by exact
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
- [x] Network visibility: eBPF captures `connect()` destination IP:port; domain names come from
      a `uprobe:libc:getaddrinfo` that records the hostname the moment the application resolves
      it (reverse DNS as a fallback) — no MITM proxy needed
- [x] Network byte-count stats: `tcp_sendmsg`/`tcp_cleanup_rbuf` kernel probes, aggregated upload/download bytes per (ip, port)
- [x] Web UI Network tab: connection detail table + GeoIP location (local MaxMind/DB-IP Lite database) + WebGL2 world map, with connection counts clickable for per-connection time/process/PID detail
- [x] Claude Code identity check: cross-platform (`ps`) detection of which OS user every `claude` process runs as, flagged when it differs from the Web UI's own user
- [x] Four Home stat cards — tool calls, MCP calls, Skill calls, AI trajectory — all with click-through drilldowns showing Session ID/folder/timestamp
- [x] AI Approvals supports an `action: "notify"` rule type (Claude Code clarifying questions, e.g. `AskUserQuestion`) and keeps a long-term history table, capturing the user's actual terminal answer for `notify`-kind records
- [x] Anthropic account profile (name/email/organization/plan/rate-limit tier) read from the local `~/.claude.json`, zero network calls
- [x] Per-session `Σ Total / Cached` token summary on the Status page (same accounting as ccstatusline)
- [x] Model Usage table, Limits table, context window usage %, and Context compaction count (real detection, not an estimate) on the Status page
- [x] Home page GitHub Operations stats (push/clone/commit/pull-fetch/gh CLI/other git operations)
- [x] Appearance settings dialog: color-theme swatch grid, interface font, interface font size (new settings)
- [x] Session quota shows "remaining %" with a conky-style stepped palette; weekly quotas show "used %" with a continuous red→yellow→green gradient; per-model quotas like Fable are detected dynamically

### Not implemented / TODO

- [ ] **macOS support**: hooks / AI Approvals / usage (Keychain) / web terminal / the nettop
      network probe now work on macOS; the Endpoint Security Framework approach sketched in the
      design doc (`execve`-level bypass detection, requires a signed system extension +
      user-granted Full Disk Access) is still unimplemented
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
  accurate). Byte-count stats only cover IPv4 TCP connections (`skc_family == AF_INET`); IPv6
  and UDP traffic still show up on the CONNECT timeline but aren't counted toward
  upload/download totals.
- The world map / location data depends on you configuring a MaxMind GeoLite2 database
  yourself — with none configured, this data is simply empty, not a bug. Even configured,
  accuracy is whatever GeoLite2's free tier gives you (coarser than the paid GeoIP2 database,
  especially for mobile/CDN egress IPs that often resolve to a carrier's datacenter rather
  than the user's actual location) — an inherent limitation of IP geolocation, not something
  CC-Monitor can fix.
