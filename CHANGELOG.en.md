# Changelog

English | [简体中文](./CHANGELOG.md)

This file records what shipped in each version of CC-Monitor. Loosely follows
[Keep a Changelog](https://keepachangelog.com/) without strictly enforcing its categories.

## [1.5.0] - 2026-09-13

### Added
- **AI Approvals now covers Claude Code's native permission dialog**: a new
  `PermissionRequest` hook is registered (re-running `install.py` adds it; the existing two
  entries are left alone). Previously the approvals page only mirrored operations our rule
  table flags as `confirm`; Claude Code's own "Do you want to proceed?" prompts (calls that
  matched no rule) never showed up — at `PreToolUse` time there is no way to know whether a
  prompt is coming. These now appear as `kind='permission'` with the same buttons as confirm
  (allow / deny / 10 or 30 min / always — "always" is remembered per `session + tool name`).
  An answer from the web page or the terminal is returned through
  `hookSpecificOutput.decision.behavior`; if nobody answers (90s timeout) or Enter is
  pressed at the terminal, the hook exits silently and the native dialog appears as usual.
  Approval history gains a "Handed back to native dialog" status.
- **macOS system-layer probe (network part)**: new `cc_monitor/probe_darwin.py`;
  `bin/CC-Monitor-probe` switches to it automatically on macOS. It samples the claude process
  tree (claude + descendants, recomputed each sample) every 2s with the built-in
  `nettop -d -L 0`, recording each connection's remote IP:port and upload/download byte
  deltas into the same `network_traffic` table and `os_net` events the Linux probe uses, so
  the traffic page / world map / AI trajectory are no longer permanently empty on a Mac. No
  root required. No `execve` observation (the bypass detection behind `verify` stays
  Linux-only); hostnames fall back to reverse DNS. SIGTERM also tears down the nettop child.
  The network page hints now tell you to run `bin/CC-Monitor-probe`, and mention that with a
  local proxy every remote is 127.0.0.1 so the map has nothing to plot.
- **`install.sh` step 4 downloads the GeoIP database**: DB-IP Lite (CC BY 4.0, ~60MB) to
  `~/.cc-monitor/dbip-city.mmdb` (honours `CC_MONITOR_HOME`). Skipped if any `.mmdb` is
  already present; downloads to a `.part` file first and treats anything under 1MB as a
  failure (deleted), so a truncated file can never make geoip.js fail silently; a failed
  download warns without aborting. `--skip-geoip` / `CC_MONITOR_SKIP_GEOIP=1` skips it,
  `CC_MONITOR_GEOIP_URL` points at a mirror.

### Fixed
- **Desktop app (Electron) on macOS gave no alert at all for AI Approvals**: the page used
  the browser Notification API; in an Electron renderer `Notification.permission` is always
  "granted" and `new Notification()` doesn't throw, but the underlying
  UNUserNotificationCenter refuses apps that aren't properly signed (`npm run electron` runs
  the ad-hoc-signed Electron.app from node_modules) — the main-process side gets a `failed`
  event with `UNErrorDomain error 1` (NotificationsNotAllowed), the renderer side fails
  silently. The main process now polls `pending_approvals` every 2s itself: a new request →
  `shell.beep()` + Dock bounce + badge count (none of which need permission), plus a system
  notification when possible (click → approvals tab); a failed notification warns once and
  isn't retried. The page detects Electron via UA, disables the browser path and turns the
  button into an explanatory label so the two never double-notify.
- **Web terminal "new session" returned 500 (`posix_spawnp failed.`)**: node-pty spawns
  the pty through its bundled `prebuilds/<platform>/spawn-helper` binary, and npm dropped
  its executable bit when unpacking (seen on macOS + npm 11). New
  `webui/scripts/fix-node-pty-perms.js` runs as `postinstall` and again, idempotently, when
  `lib/sessions.js` loads (packaged builds have no postinstall step).
- **macOS always showed "Claude Code credentials not found" for usage/plan**: on macOS
  Claude Code does not write `~/.claude/.credentials.json`; the OAuth credential lives in
  the login Keychain (service `Claude Code-credentials`, same JSON payload). Every fresh Mac
  hit this. New `webui/lib/credentials.js` reads the file first and falls back to
  `security find-generic-password -s "Claude Code-credentials" -w`; shared by `usage.js`
  and `account.js`. Unrelated to whether ccstatusline is installed — we never invoke it, we
  only replicate its lookup (which uses the Keychain on macOS too).
- **macOS never showed CC-Monitor's `[y/N]` prompt in the terminal**: `notify.py` opened
  `/dev/tty` in text mode `"r+"`, which wraps a `BufferedRandom` that requires a seekable
  stream; `lseek` on a tty returns 0 on Linux but `ESPIPE` on macOS, so `open()` raised
  `io.UnsupportedOperation` (an `OSError` subclass), was silently swallowed, and the tty
  path was permanently disabled — only the web path worked. Now opens as a raw `FileIO`
  (`"r+b", buffering=0`).
- **Typing y/N while the terminal is in raw mode could hang the hook**: Claude Code's TUI
  keeps the terminal in raw mode, so Enter arrives as `\r` rather than `\n`; the old
  `readline()` waited forever for a newline and stalled the web-side polling too. Now reads
  whatever bytes are available and inspects the first character.

## [1.4.3] - 2026-09-13

### Added
- **Published a compiled Linux x64 binary**: the GitHub Release now ships a built
  `CC-Monitor-*.AppImage` alongside a `cc-monitor-start.sh` launcher wrapper.
  An AppImage is a single self-contained executable — double-clicking or running
  it directly bypasses any npm script, so the Node launcher added in v1.4.2 for
  `npm run electron` (which relies on that npm-script layer) never gets a chance
  to run for the packaged binary. This wrapper checks the caller's uid and only
  appends `--no-sandbox --disable-gpu-sandbox` when actually running as root,
  leaving the sandbox untouched for everyone else. Verified: running the raw
  AppImage directly as root still FATAL-exits — the wrapper (or passing those
  flags manually) is required.

### Fixed
- **Leftover root-sandbox fallback code in `electron-main.js` did nothing**:
  v1.4.2 kept a "just in case the launcher didn't apply it, add `--no-sandbox`
  here too" block. Testing showed this JS never gets a chance to run before
  Chromium's native FATAL check fires — that check happens at Electron's native
  startup stage, earlier than any JS in `electron-main.js`, even the very first
  line of the file; even a self-re-exec pattern placed at the top of the file
  was too late. Removed the dead code and replaced it with a comment explaining
  that this flag can only be supplied from outside, before the electron process
  is spawned — `npm run electron` goes through `scripts/electron-start.js`, and
  the packaged binary goes through the new `cc-monitor-start.sh` above.

## [1.4.2] - 2026-09-13

### Fixed
- **`npm run electron` failed to launch under root**: Chromium checks whether it's
  running as root without `--no-sandbox` at native startup and FATAL-exits if so —
  this check runs before any JS in `electron-main.js` executes, so setting the flag
  at runtime via `app.commandLine.appendSwitch()` does nothing; it has to be present
  in the actual process argv at the moment the electron binary is spawned. Fixing
  that surfaced a second layer: the GPU process has its own independent sandbox and
  fails the same way under root (`GPU process isn't usable. Goodbye.`), requiring
  `--disable-gpu-sandbox` as well. Added a small launcher script
  (`webui/scripts/electron-start.js`) that checks `process.getuid()` and only
  appends these two flags when actually running as root — non-root users keep the
  full sandbox untouched. Verified under the current root environment with
  `wmctrl`/`xdotool` that a real window titled "CC-Monitor" comes up.

## [1.4.1] - 2026-09-13

### Fixed
- **The interface font-size setting wasn't actually global**: 62 places in the stylesheet
  (buttons, card numbers, table text, …) had hardcoded pixel font-sizes, so changing only
  `body`'s own `font-size` never touched them — the slider looked like it barely did
  anything. Fixing it surfaced a second, related bug: after converting all 62 to `rem`
  units relative to the root, the first verification pass showed the CSS variable updating
  correctly while `<html>`'s actual font-size never moved — because the combined
  `html, body { ... font-size: 1rem }` rule applies to both elements, and `1rem` on the
  root element itself doesn't mean "relative to itself," it resolves against the browser's
  16px default; that rule came later in the cascade and silently overrode the dedicated
  `html` font-size rule. Verified in a fresh browser profile: at the 14px default, buttons
  render at 13px and card numbers at 28px; at 18px, buttons become 16.7px and card numbers
  36px — every piece of text scales together now.
- **The interface font setting had no effect on nav-bar/button text**: browsers'
  built-in default stylesheet never lets `<button>`/`<select>`/`<input>`/`<textarea>`
  inherit the surrounding `font-family` — they fall back to the OS's native UI control
  font instead (Arial, in practice), and that's standard behavior in every browser, not a
  broken inheritance chain. So switching fonts did nothing for the "Home"/"Status" nav
  buttons or things like the "New Session" button. Fixed with a single
  `button, input, select, textarea { font-family: inherit; }` rule — verified via
  screenshot that the nav text now actually picks up Kaiti's handwritten brush strokes.

### Added
- **Three new Chinese font options** in the interface font setting: Kaiti (calligraphy-
  style), Heiti (Source Han Sans), and Songti (Source Han Serif). No font files were
  bundled into the project — a full CJK glyph set runs 17–21MB each, and bundling would
  make the first font switch painfully slow to download — so these are plain font-name
  references instead; they render correctly wherever the visitor's system/browser already
  has a matching font installed (this Linux machine itself has AR PL UKai/UMing, Noto
  Sans/Serif CJK, and LXGW WenKai, so same-machine or same-LAN access picks them up
  directly; Windows's "Microsoft YaHei"/"SimSun" and macOS's "PingFang SC"/"STKaiti" are
  also in the respective stacks). A "Liu style" (柳体, Liu Gongquan calligraphy) option was
  not added — no such font is installed on this system, and the free fonts online claiming
  that style have unverified licensing, so bundling one wasn't safe to do without
  confirmation.

## [1.4.0] - 2026-09-13

### Added
- **Appearance settings dialog** (⚙ button in the top bar): the color theme picker is now
  a visual swatch grid (each of the 10 themes shown as its own accent-color dot, with an
  active highlight) instead of only a plain dropdown; added **interface font** (system
  default / monospace / serif / rounded) and **interface font size** (12–18px slider) —
  neither existed before. The dialog includes a live preview. Both new settings persist to
  `localStorage` and survive a reload; the original top-bar theme dropdown still works too
  and stays in sync, it's not a replacement.
- **Session quota (5-hour window) now shows "remaining %"** (was "used"), colored with a
  conky-style stepped palette — very red below 5%, very green above 85%, one fixed vivid
  color step per 10% in between. The other quota bars (weekly all-models/Sonnet/Opus/Fable)
  switched to a continuous red→yellow→green gradient computed from "health" (more used =
  more red), with the three gradient anchors read live from the current theme's
  `--red`/`--yellow`/`--green` tokens so it re-colors on a theme switch. Every quota card's
  label now carries an explicit "Used"/"Remaining" prefix.
- **Fable model quota**: the usage API has no dedicated top-level field for Fable (unlike
  Opus/Sonnet, which get `seven_day_opus`/`seven_day_sonnet`) — its quota only shows up as
  one `kind="weekly_scoped"` entry inside `limits[]`. This is now extracted dynamically by
  model name rather than hardcoding "Fable", so any future per-model quota Anthropic adds
  shows up automatically too.
- **Model Usage table on the Status page**: token usage (input/output/cache/total) summed
  per model (Sonnet/Opus/…) across every monitored session; a session that switched models
  mid-way counts separately per model.
- **Limits table on the Status page** (same data as the Home page's), with a longer, bolder
  progress bar; the "Resets" column gained a purple "how far through this window" progress
  bar.
- **Context window usage % and Context compaction count** on each session row on the Status
  page: the former is how much context the conversation is actually carrying right now,
  estimated against a standard 200K context window (Claude Code only reports the exact
  window size to its own statusLine input, which our hooks don't receive — this is an
  approximation, called out with a hover hint); the latter is a real detection of
  `type=system, subtype=compact_boundary` events in the transcript, with auto/manual counts
  split out and cumulative tokens reclaimed — not an estimate.
- **Network domain capture switched to `uprobe:libc:getaddrinfo`**: previously relied on
  reverse DNS (a PTR lookup) after the fact, which fails for most cloud/CDN egress IPs that
  never had a PTR record configured (confirmed on Anthropic's own API IP, among others); now
  the actual hostname the application asked to resolve is captured the moment it calls
  `getaddrinfo()`, keyed by pid, and looked up when the matching CONNECT event fires — the
  domain is known before the connection even happens, regardless of whether the egress IP
  has a PTR record (verified live against a Cloudflare-fronted IP for `example.com` using an
  executable renamed to "claude" to simulate the real process-tree ancestry check).
- **"Connections" is now clickable** on the Network tab, both per target-row and on the two
  summary cards ("Total connections" / "Distinct IPs") — opens a detail list of every
  connection's time, originating process, and PID.
- **New "GitHub Operations" stats on the Home page**: git push / git clone / git commit /
  git pull-fetch / gh CLI (PR/Issue/API…) / other git operations, six cards. Most git/gh
  commands don't violate any policy rule, so they never get a `matched_rule` and couldn't
  reuse the same trick as the install-ops stats — classification is done with a new
  per-sub-command matcher (split on `;`/`&`/`|`/newline and check each segment's start, so
  `echo "git push is dangerous"` doesn't get miscounted as a real `git push`), registered as
  a SQLite custom function `cc_github_op()` used directly in the query. Each card drills down
  to the exact session, folder, timestamp, and command (reusing the same detail rendering
  already used by file-ops/install-ops).

### Fixed
- The limits table's "Used %" and "Severity" columns visually overlapped — the enlarged
  progress bar used `width: 100%`, which doesn't participate in a table's automatic column
  sizing (a percentage-width flex child contributes no intrinsic width, so the column was
  sized far too narrow while the bar still tried to fill 100% of it), causing it to spill
  into the next column. Switched to a fixed `220px` so neither column crowds the other.
- The Log Audit / Claude Tap content-list containers had a leftover `max-width: 900px`
  (despite the class being named ".wide") that left a huge dead gutter on wide screens with
  the scrollbar stranded mid-page — removed, now fills the available width.
- Trimmed two overly long hint captions next to "Claude Code identity check" and "Anthropic
  account info" on the Home page.

## [1.3.2] - 2026-09-12

### Added
- **Anthropic account info now shows name/email/organization/plan**: not a new network
  call — it's read from Claude Code's own local global config file `~/.claude.json` (the
  `oauthAccount` field), confirmed by decompiling [ccstatusline](https://github.com/sirmalloc/ccstatusline)'s
  "Claude Account Email" widget for the exact path and field names. New fields: name,
  email, organization name, organization role, plan type (e.g. `claude_max`), organization
  rate-limit tier, billing type, account creation date, subscription start date. Placed
  below "Detected claude processes" on the Home page, and before "Account quota" on the
  Status page.
- **Approval history on the AI Approvals page**: the `pending_approvals` table was never
  actually deleted from anywhere (the Home page's "clear current data" button only clears
  the `events` table), so history was already being kept long-term — this just surfaces it:
  time, session, tool, matched rule, matched value, outcome, resolved via. For `notify`-kind
  records (e.g. `AskUserQuestion`), a new `resolved_value` field captures the user's actual
  answer from the corresponding `PostToolUse` event's `tool_response.answers` — the history
  now shows not just what was asked but what was actually answered (existing records predate
  this and won't have it; new ones will).
- The **limits percentage** now renders as a rounded, glowing pill-shaped progress bar,
  colored from the current theme's accent/yellow/red tokens (not a fixed palette).
- **Per-session token stats on the Status page**: added `Σ Total: X.XM · Cached: X.XM`,
  matching [ccstatusline](https://github.com/sirmalloc/ccstatusline)'s TokensTotal/
  TokensCached widgets exactly (Total = input+output+cached, Cached =
  cache_read+cache_creation) — the previous implementation only counted cache_read, missing
  cache_creation.
- Session ID cells in event-detail tables (Tool/MCP/Skill call drilldowns, approval history)
  now show the folder name in front of the ID (e.g. "webui · 6ca9e412…") instead of a bare
  truncated UUID.

### Fixed
- CC-Monitor's own `disk_overwrite` rule regex, `\b(dd|mkfs|fdisk|parted)\b`, false-positived
  on hyphenated CSS class names like `dd-table` (`\b` treats a hyphen as a word boundary,
  same as whitespace) — discovered when this very feature got blocked by our own rule while
  grepping the stylesheet. Fixed with `(?<![\w-])...(?![\w-])` so it only matches an isolated
  command name.
- The desktop-notification button and approval-history table on the AI Approvals page didn't
  re-translate on a language switch (their text is set imperatively, outside the `data-i18n`
  auto-refresh path) — wired into the language-switch refresh now.
- The session-filter dropdown on the Log Audit / Claude Tap toolbars used `margin-left: auto`
  to push itself right, but it sat before the autoscroll toggle in DOM order, so the toggle
  ended up to its right instead — added `order` so it renders truly last.
- The Home page's "Account created" / "Subscription started" dates were sliced out of
  `toLocaleString()` output, leaving a stray trailing comma ("3/28/2026,") — switched to
  `toLocaleDateString()`.

### Changed
- Colored card backgrounds for the file-ops/install-ops/Anthropic-account stat groups (added,
  then re-themed to a fixed neon palette, then it turned out the theme selector already
  covered this) were removed entirely after a few rounds of feedback — these cards are back
  to the same plain background as every other stat card.

## [1.3.1] - 2026-09-12

### Added
- **Tool Calls / MCP Calls / Skill Calls / AI Trajectory drilldowns** now include an
  event-level list with Session ID, working directory, and timestamp (not just the
  grouped-by-type/server/skill summary counts). AI Trajectory's connection events come from
  the kernel-level probe and have no session concept, so those two columns show an
  explanatory note instead, replaced with the originating process/command name (e.g. `pip3`,
  `apt`, `curl`) as an alternative form of attribution.
- Home page nav reordered to: Home / Status / Network / Terminal / AI Approvals / Log Audit
  / Claude Tap / Archives.
- File-ops / install-ops / Anthropic-account stat cards got a themed colored background
  (later removed entirely — see "Changed" under Unreleased above).

### Fixed
- The connection-destination world map's equirectangular projection wasn't corrected for the
  canvas's actual aspect ratio, so it stretched whenever the canvas wasn't exactly 2:1. Fixed
  by scaling in clip space to match the canvas aspect, letterboxing/pillarboxing instead of
  stretching to fill.

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
