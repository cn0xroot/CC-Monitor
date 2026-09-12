# Changelog

English | [简体中文](./CHANGELOG.md)

This file records what shipped in each version of CC-Monitor. Loosely follows
[Keep a Changelog](https://keepachangelog.com/) without strictly enforcing its categories.

## [Unreleased]

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
