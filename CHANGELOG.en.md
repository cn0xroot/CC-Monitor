# Changelog

English | [简体中文](./CHANGELOG.md)

This file records what shipped in each version of CC-Monitor. Loosely follows
[Keep a Changelog](https://keepachangelog.com/) without strictly enforcing its categories.

## [Unreleased]

## [1.3.0] - 2026-09-12

### Added
- **Claude Code Network Traffic tab** (before "History" in the nav): a connection detail
  table (destination IP/port, reverse-resolved hostname, upload/download byte counts,
  connection count, location) plus summary cards and a WebGL2 world map (equirectangular
  projection + a bundled low-res coastline outline, following the approach from
  [BeeEye](https://github.com/cn0xroot/BeeEye)'s `WorldMap.jsx` — no map-tile service
  dependency). The system-layer probe gained `tcp_sendmsg`/`tcp_cleanup_rbuf` kernel probes
  to aggregate real upload/download byte counts per `(ip, port)` (the existing probe only
  knew "connected to this IP:port," not how much data moved), written to a new
  `network_traffic` table.
- **IP geolocation** (`webui/lib/geoip.js`): local database lookups, no per-IP third-party
  API calls. Supports two sources: official MaxMind GeoLite2 (requires signing up) or
  [DB-IP Lite](https://github.com/sapics/ip-location-db) (CC BY 4.0, no signup, ready-to-use
  `.mmdb` download) — both field layouts (nested/flat) are recognized. Without a database
  configured, it honestly reports "not configured" instead of faking data.
- **Three new Home stat cards**: tool calls (counts `hook_pre` only — more intuitive than
  the raw event total), MCP calls (identified via the `mcp__<server>__<tool>` naming
  convention, drills down per-server), and AI trajectory (domains/IPs visited, backed by the
  Network tab's data) — all clickable for drilldown.
- **Claude Code identity check** (Home page card + drilldown): cross-platform (`ps`)
  detection of which OS user every running `claude` process belongs to, flagged prominently
  when it differs from the Web UI's own user — each side resolves `~/.cc-monitor/` from its
  own process's `$HOME`, so a mismatch silently makes one side's confirmation
  prompts/audit events invisible to the other; this makes that otherwise-invisible situation
  visible.
- **AI Approvals now supports Claude Code's clarifying questions**: a new `action: "notify"`
  rule type (distinct from `confirm`) — tools like `AskUserQuestion`, where Claude Code is
  asking the user something with no allow/deny semantics, never block or trigger a tty
  prompt; they just surface a "something's waiting for you" notice on the web page (full
  question + options, styled distinctly in blue). The answer can only be given in the
  terminal that triggered it, and the notice disappears automatically once the matching
  `PostToolUse` event arrives.

### Fixed
- A race condition in `geoip.js`: when `getStatus()`/`lookup()` were called concurrently in
  the same request via `Promise.all`, the second call could see "already loading" and return
  before `reader` was actually assigned (still `null`), reporting `available: false` even
  though the database had loaded successfully. Fixed by having all callers await the same
  in-flight loading promise.
- `probe.py`'s bpftrace-not-found error previously suggested installing via `brew`, but this
  probe depends on Linux's eBPF subsystem, which has no macOS equivalent — the message was
  misleading and now says so explicitly.
- Quota reset times on Home / Status were previously rounded to the nearest hour ("in 5
  hours"), losing minutes that can matter — now precise to the minute.
- Event timestamps (terminal session creation time, Claude Tap timestamps, the absolute
  reset time) are now consistently 24-hour format, instead of possibly rendering 12-hour
  depending on the browser/OS locale.

### Changed
- Both READMEs' "Home" feature description was badly out of date — several already-shipped
  features (audit control, identity check, Anthropic account info, install-op stats) had
  never been written up; backfilled now, along with matching entries in the "Implemented"
  roadmap checklist.

## [1.2.2] - 2026-09-12

### Fixed
- The real root cause of "model ID not detected" for Web UI terminal sessions: a newly
  spawned `claude` process inherited the host Node process's own `CLAUDE_CODE_SESSION_ID`/
  `CLAUDE_CODE_CHILD_SESSION` environment variables (this shows up whenever `node server.js`
  itself was started from inside another Claude Code session), causing Claude Code to treat
  it as a nested child session and never write its own transcript file. Strip those env vars
  before spawning. (An earlier fix for a cwd/symlink mismatch was a real, separate
  improvement and is kept, but wasn't the main cause of this bug.)
- Web UI terminal sessions occasionally "just disappearing": the server had zero global
  crash protection, so any single uncaught exception or WS message error took down the
  entire process — and every live session with it. Added `uncaughtException`/
  `unhandledRejection` handlers (log, don't exit); also wrapped a missing try/catch in
  `sessions.js`'s `write()`.
- Refreshing the browser lost the selected terminal session / Claude Tap session: this state
  was a plain in-memory variable that reset on reload. Now persisted to `localStorage` and
  restored automatically. Fixed a related hidden bug in Claude Tap's option-rebuild logic
  (`options.length === 0` is never true because the HTML ships with a placeholder option, so
  the "is this the first build" check never fired).
- AI Approvals missed Claude Code's own native asks like WebSearch: added a `web_search`
  rule, and switched the hook's approved-confirm response from a plain exit code to the
  `hookSpecificOutput.permissionDecision:"allow"` JSON format — without this, choosing
  "allow" on the web page still left Claude Code's own native popup asking a second time.
  Anything not covered by our rule table still falls through to Claude Code's own native
  prompt untouched, rather than being silently waved through.
- Confirmation prompts from a real terminal (not the Web UI) were invisible on the web page:
  root cause was the Web UI process and your terminal's `claude` process running as
  different OS users, each reading/writing a separate `~/.cc-monitor/` database. Added a
  "Claude Code identity check" (Home page card + drilldown) that flags a user mismatch;
  `start.sh` now warns on a root launch, and `server.js` logs its effective user on startup.

### Added
- Two new AI Approvals options: "allow, don't ask again for 10/30 minutes," sharing the same
  session-scoped memory as "always allow" plus an expiry.
- Browser desktop notifications (Notification API) for AI Approvals — new requests raise a
  system notification even when the tab isn't focused; click it to jump back in. Each
  request notifies only once.
- The "Terminal Sessions (live)" drilldown on Home now also shows Session ID / blocked-or-
  bypassed / time range, matching the "all sessions" drilldown.

### Changed
- Renamed "Pending Approvals" to "AI Approvals" ("AI 审批台" in Chinese) across the UI and
  docs.

## [1.2.1] - 2026-09-12

### Fixed
- `webui/package.json`'s `main` field was still `"server.js"`, so electron-builder packaged
  the raw Express server script as the Electron main process, entirely bypassing
  `electron-main.js`'s window-opening and port-9998 logic (in practice: the packaged AppImage
  opened no window and tried to grab the web version's default port 9999 instead). Manual
  testing via `electron electron-main.js` worked fine because it named the entry file
  explicitly, masking the bug — an actual package build surfaced it. Fixed by setting
  `"main": "electron-main.js"`.

### Changed
- Added `webui/dist/` (electron-builder's output directory) to `.gitignore`, so the tens-to-
  hundreds-of-MB packaged binaries never get committed by accident.

## [1.2.0] - 2026-09-12

### Added
- **Pending approvals center**: new "Approvals" nav tab that mirrors Claude Code's default
  "allow this action?" confirmation prompt into the Web UI. The same `confirm`-type action can
  be answered either at the terminal that triggered it (y/N) or from the web page ("allow once
  / deny once / always allow") — whichever answers first wins (a `pending_approvals` SQLite row
  guarded by `WHERE status='pending'` keeps this race-safe, so both channels can never both take
  effect). "Always allow" is scoped to the session, not a global rule change: that rule won't be
  asked again in this session, but any other session running the exact same command still gets
  prompted. The confirm timeout was extended from 20s to 90s to give the web channel time to
  respond.
- **Terminal session status dots**: each terminal session now shows working / blocked / idle
  (closed sessions show dead), similar in spirit to
  [herdr](https://github.com/herdrdev/herdr)'s "status per pane instead of hunting for the
  stuck one" — not a new detection mechanism, just reusing existing data: a pending approval on
  that session (highest priority — blocked), recent real terminal output, or a recent matching
  audit event, to tell "actively working" apart from "sitting at the prompt."
- **Anthropic account info on Home**: now also shows the `limits[]` breakdown (session /
  weekly_all / weekly_scoped, each with percent, severity, resets_at — weekly_scoped also names
  which model it's scoped to) and `spend` (whether pay-as-you-go usage credits are enabled past
  plan limits, and how much has been used).
- **Install-operation stats**: below the file-op stats card on Home, four new counters — pip /
  system package manager / npm / other — with click-through detail of the exact install
  commands. Reuses the same `matched_rule` groupings the policy engine already computes, so
  there's only one source of truth for what counts as an install.
- **Remote access security toggle**: new "allow other devices to access this service" switch on
  Home. The default bind stays `127.0.0.1` and is never changed by this toggle — actually
  listening on all interfaces still requires an admin to explicitly set
  `CC_MONITOR_WEBUI_HOST=0.0.0.0` and restart the process. The toggle governs a separate gate:
  even if the process is explicitly bound to `0.0.0.0`, the HTTP middleware and WebSocket
  upgrade handler both check this flag first and reject non-local origins by default — an
  additional, default-off application-layer gate for the "I really do want to listen on all
  interfaces" case.
- **Claude Tap merged all-sessions view**: shows recent activity from every session with a
  transcript, merged and sorted by timestamp, instead of switching between sessions one at a
  time.
- **One-click install/start scripts**: added `install.sh` (checks Python/Node, runs
  `install.py`, installs webui dependencies, checks for bpftrace) and `start.sh` (installs
  dependencies and starts the Web UI).
- **Desktop (Electron) scaffolding**: added `webui/electron-main.js`, which directly `require`s
  the existing `server.js` (Express + ws + node-pty + better-sqlite3) to run inside Electron's
  main process with zero server-side code changes; the desktop build uses port 9998, distinct
  from the web version's 9999, so both can run side by side. So far only validated that the
  embedded server starts correctly on Linux — macOS and Linux ARM64 packaging is planned but no
  downloadable desktop build exists yet.

### Changed
- **README now defaults to English**: the former Chinese `README.md` moved to
  `README.zh-CN.md`, and the former `README.en.md` content became the new `README.md`
  (English); the language-switch links in both were updated to match.

### Fixed
- `webui/lib/usage.js` required `https-proxy-agent`, which is a pure-ESM package
  (`"type":"module"`, no CJS `require` export condition) — it happened to work with `require()`
  under this environment's Node 22, but crashed with `ERR_REQUIRE_ESM` under Electron's bundled
  older Node. Found while actually testing the desktop scaffolding; switched to an async dynamic
  `import()` that works under both.

## [1.1.2] - 2026-09-12

### Fixed
- Fixed a class of "click does nothing" CSS specificity bugs: `.error-banner`,
  `#terminal-statusline`, `#terminal-grid-pane`, and `.archive-load-more` all declared an
  unconditional `display` with no `[hidden]` gate, which outranks the browser's default
  `[hidden]{display:none}` rule — so setting `.hidden = true` in JS had no visual effect.
  The error banner's "Got it" button couldn't actually dismiss it, and the terminal's
  grid/single-view toggle never really switched anything. Added the matching
  `[hidden]{display:none}` rules to restore the intended behavior.

## [1.1.1] - 2026-09-12

### Fixed
- When Claude Tap has no thinking text to show, the message changed from "(内容已省略)"
  ("content omitted"), which read as if something were being withheld, to an explicit
  explanation: Claude Code itself never stored that thinking text in the local transcript
  (only a verification signature) — checked across every project's transcript on this
  machine, all 14,556 thinking blocks are empty without exception. This isn't content
  CC-Monitor can read but chooses not to show; there's no data to recover.

## [1.1] - 2026-09-12

Work done after the `v1.0` tag:

### Added
- **Audit toggle** on the Home tab: Start / Pause / Stop (merged into one toggle button plus
  a separate Stop button). The three states behave differently: `running` is normal
  (evaluate/block/log as configured); `paused` observes only — rules still run and risk/matched
  rule still get logged, but nothing is ever actually blocked or prompted for confirmation;
  `stopped` doesn't intervene at all — no evaluation, no logging. A persistent status pill in the
  top bar always shows the current state so it's never silently forgotten.
- **Data management** on Home: archive current data (a full snapshot of `events.db` via SQLite's
  own `backup()` API, saved under `~/.cc-monitor/archives/`) and clear current data (`DELETE` +
  reset the autoincrement counter).
- New **Historical Data** tab: lists every archived snapshot; each one can be opened to browse the
  events it recorded (reusing the same rendering as the Audit Log), and deleted individually.
- **Folder browser** in the "New Session" dialog: a server-side directory listing endpoint plus a
  small UI — browses paths on the machine running the Web UI (not the browser's own machine,
  which a native `<input webkitdirectory>` would incorrectly pick from).
- The Web terminal now auto-confirms Claude Code's "trust this folder?" prompt that appears the
  first time it opens an unfamiliar directory — otherwise the very next ordinary Enter keypress
  would silently exit Claude Code back to a bare shell while the terminal still looked perfectly
  functional.
- The "Web UI terminal sessions (active)" card on Home is now a clickable drilldown, showing each
  session's cwd/status/uptime/client count, with a best-effort match (by cwd) against audit
  records to also show model and event count; clicking a row jumps straight to that session in the
  Terminal tab.
- Both the Audit Log and Claude Tap gained an "auto-scroll to latest" toggle (iOS-style switch) —
  turning it off keeps logging/polling unaffected, it just stops yanking the scrollbar while
  someone is reading back through history.
- Claude Tap gained a "show thinking detail" toggle — `thinking` blocks are collapsed to a few
  lines by default, expandable to the full text. If the transcript itself never stored the actual
  thinking text for a given turn (Claude Code sometimes only persists a verification signature, no
  plaintext), the toggle can't conjure content that was never there — that's a data limitation, not
  a toggle bug.
- In Claude Tap's "user" turns, tool results that are structured objects/arrays are now rendered as
  indented JSON in their own block instead of being crammed onto one line.
- Claude Tap now shows the newest message at the top, oldest at the bottom (auto-scroll now scrolls
  to the top when enabled). Opening a session no longer starts reading from line 1 of the
  transcript — it jumps to the most recent content instead, which matters a lot for sessions that
  have been running for days with tens of thousands of transcript lines.
- 5 new themes: Midnight, Ocean, Forest, Sunset, Rose — ported from
  [AI_Web_Search](https://github.com/cn0xroot/AI_Web_Search)'s color scheme.
- `Makefile`: `make install` / `make uninstall` to install the CLI tool onto the system path
  (`/usr/local/lib/cc-monitor` plus command symlinks) instead of having to remember where the
  checkout lives.

### Fixed
- Delete-operation detection: replaced whole-string SQL `LIKE '%rm %'` matching (which flagged
  ordinary text ending in "rm " — e.g. "confirm ") with per-subcommand parsing that only matches
  when a subcommand actually *starts with* `rm`/`rmdir`/`unlink`/`shred`/`git rm`/`find -delete`,
  cutting false positives significantly.
- A long-standing bug where **the Audit Log page covered every other tab**: root cause was
  `#view-logs` using an ID selector for `display:flex` with no `.active` gate, which outranks the
  `.view{display:none}` class rule — so that section stayed visible year-round regardless of which
  tab was selected, pushing Terminal Sessions / Claude Tap / Status / Historical Data off-screen
  (they render after it in the DOM). Reproduced and verified fixed with a real headless browser.
- Claude Tap's session dropdown getting rebuilt (and closed / options wiped out from under the
  user) by the periodic poll while the user had it focused/open.
- The Claude Tap toolbar (session switcher) getting scrolled out of reach once there was enough
  conversation content on screen.
- Static assets now carry a version query string tied to the server process's start time
  (`?v=<timestamp>`) so browser/intermediate-proxy caching can't leave a stale page in place after
  the server is restarted.
- Selecting a Claude Tap session where the hooks recorded a transcript path but the file doesn't
  actually exist (common for one-off tool calls / background tasks) used to just show "0 · path"
  forever, looking stuck; it now clearly says the file is missing.

## [1.0] - 2026-09-12

First release. Two-layer monitoring architecture plus a full Web UI.

### Core monitoring
- **Application layer**: `PreToolUse`/`PostToolUse` hooks, decided by an ordered regex rule table
  (`default_rules.json`, 30+ rules) covering dangerous deletes, system-level package installs
  (apt/yum/pip without a virtualenv, etc.), privilege escalation, reverse shells, persistence
  backdoors (crontab/systemd), SSH key tampering, and more.
- **System layer**: `CC-Monitor-probe` (Linux, `bpftrace`), independent of the hooks, tracing at
  the kernel level every `execve`/`connect` made by the entire process subtree spawned by
  `claude`. `CC-Monitor verify` cross-checks this against what the hooks recorded and flags
  anything the probe saw that the hooks never logged (bypass detection).
- Network visibility: eBPF captures the destination IP:port of every `connect()` directly — no TLS
  termination, no CA certificate to install.
- Human-readable live log: `CC-Monitor tail`, auto-colored in a real terminal, Bash commands
  syntax-highlighted.

### Web UI
- **Home**: overview stats, each card clickable for drilldown detail.
- **Audit Log**: full-width live log, filterable by session, color-coded risk/operation/status
  badges.
- **Terminal Sessions**: `node-pty` spawns real PTYs for chatting right in the browser; WebGL-
  accelerated rendering with automatic Canvas fallback; grid view (herdr-style) shows every
  session on screen at once.
- **Claude Tap**: reads Claude Code's own local transcript JSONL (via `transcript_path`) to
  reconstruct the full conversation sent to/received from the model — text, thinking, tool calls,
  tool results, token usage — no packet capture involved.
- **Status**: account-level usage (reading the same OAuth credential as
  [ccstatusline](https://github.com/sirmalloc/ccstatusline)) plus per-session model, token usage,
  throughput, git branch, and blocked-operation counts.
- Language toggle (中文/EN) plus 5 themes (Brand/Dark/Light/Dracula/Nord).
- Font stack pairing a Chinese calligraphic (KaiTi) face with a clean system UI font for English.

### Installation
- `install.py`: merges into the hooks array, de-duplicated by exact `command` string, never
  overwrites existing hooks configuration.
