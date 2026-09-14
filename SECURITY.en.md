# Security & Privacy Notes

English | [简体中文](./SECURITY.md)

This document covers three things separately: the legal disclaimer, what actually installing
this tool does to your system in practice (as Q&A, plain language rather than boilerplate), and
where your data actually ends up. The content is based on an actual inspection of the current
code (the dependency list, whether any telemetry code exists, whether any hardcoded external
reporting endpoints exist) — it isn't a copy-pasted generic disclaimer template.

## 1. Disclaimer

CC-Monitor is an individually-maintained open-source project, provided "as is" under the
[MIT License](./LICENSE), without any warranty of any kind, express or implied — including but
not limited to fitness for a particular purpose, error-free operation, or that the rule set will
catch every dangerous operation.

Specifically:

- **The policy engine does approximate matching, not formal verification.** Every rule is, at
  its core, a regex matched against command text, file paths, or written content — as repeatedly
  emphasized as "not exact" in the "Policy Engine" section of
  [DESIGN.md](./DESIGN.en.md#43-policy-engine).
  There will always be phrasings that slip past a rule, and always be legitimate operations that
  get misjudged. **Don't treat it as your only line of defense**, especially when working with
  code/repos you genuinely don't trust — the usual additional protections (container isolation,
  read-only mounts, a dedicated sandboxed account) are still necessary.
- **The system-layer probe currently only audits — it doesn't enforce isolation.**
  `CC-Monitor-probe` can see and record signs that the application-layer hooks were bypassed, but
  seeing it doesn't automatically stop it — a real mandatory-isolation approach (Landlock/sandboxing)
  is still on the [Phase roadmap in DESIGN.md §5](./DESIGN.en.md#5-phased-roadmap), marked "not
  implemented."
- **The author is not liable for any direct or indirect loss arising from use or misuse of this
  tool** (including but not limited to: work interruption from a rule false-positive, a security
  incident from a rule false-negative, an anomaly caused by the system-layer probe's permissions,
  or issues introduced by your own modifications to the rules/code). Use at your own risk — it's
  worth running it in a non-production environment first and understanding what the default rules
  in `cc_monitor/default_rules.json` actually block before relying on it.

## 2. Risk Q&A: what does installing this actually do to my system?

### Q: Will installing this conflict with anything else?

Three things worth knowing — none of them "breaks on install," but worth having in mind:

- **Stacking with other Claude Code hooks tools**: Claude Code's `PreToolUse`/`PostToolUse` hook
  mechanism itself allows multiple hooks registered under the same event, executed in order. If
  your `~/.claude/settings.json` or a project's `.claude/settings.json` already has another
  hooks-based tool installed, CC-Monitor's hook queues up alongside it rather than overriding it
  — but each additional hook adds one more process-startup's worth of latency. A single hook
  invocation is normally millisecond-scale, but if another hook is itself slow or hangs, it slows
  down or blocks the whole tool-call chain (this is an inherent tradeoff of the hooks mechanism
  itself, not something specific to CC-Monitor).
- **Mismatched run identity**: the Web UI reads `~/.cc-monitor/events.db` under whichever system
  user started it. If you normally run the `claude` command as a regular user but start the Web
  UI with `sudo`/root, the two sides write to different database directories and the Web UI will
  appear to show no data — the UI already surfaces a warning about this; it isn't a bug, it's a
  run-identity mismatch.
- **Port conflicts**: the Web UI listens on a local port by default (see the README for startup
  details); if that port is already taken by something else, the service fails to start and needs
  a different port.

### Q: What third-party modules does this depend on? Could a supply-chain attack compromise it?

**The core path that actually decides allow/deny for a dangerous operation (the Python hook
scripts plus the policy engine, `cc_monitor/policy.py`) has zero third-party dependencies** —
only the Python standard library (`json`/`os`/`re`/`pathlib`/`sqlite3`/`subprocess`, etc.). This
is a deliberate design choice: this layer directly decides whether to let a Claude Code action
through, so the fewer dependencies it has, the smaller its supply-chain attack surface.

**The optional Web UI (Node.js) is not dependency-free.** `webui/package.json` lists 9 runtime
dependencies:

| Package | Purpose |
|---|---|
| `express` | HTTP server framework |
| `ws` | WebSocket (terminal sessions, live push) |
| `better-sqlite3` | reads the audit database |
| `node-pty` | pseudo-terminal for terminal sessions |
| `xterm` / `xterm-addon-fit` / `xterm-addon-webgl` | web terminal rendering |
| `maxmind` | local GeoIP database lookups (IP geolocation) — makes no network request |
| `https-proxy-agent` | used when making an HTTP request through a user-configured proxy |

Plus 3 dev dependencies (`electron`, `electron-builder`, `@electron/rebuild`) needed only to
package the Electron desktop build — the pure Web UI mode never touches them.

Each of these packages has its own transitive dependency tree (`node_modules` expands to far more
than 9 packages), and a compromise anywhere in that tree could in theory affect the Node process
running on your machine — **this is the same order of risk faced by virtually any project that
uses the npm ecosystem, not something specific to CC-Monitor**, but you should know it exists. If
you're particularly sensitive to Node-ecosystem supply-chain risk, **you can skip installing/running
the Web UI entirely** — the Python layer (hooks apply automatically, plus the zero-dependency CLI
commands `CC-Monitor tail`/`CC-Monitor rules`/`CC-Monitor stats`) still blocks and audits on its
own; you just lose the web visualization.

### Q: Could this make my system unstable?

Two separate layers:

- **Application-layer hooks**: a hook script runs synchronously before and after every Claude
  Code tool call (spawning a Python process, running the regex matches, writing to SQLite) — a
  single invocation is typically tens of milliseconds. If a hook script throws or hangs, it could
  in theory slow down or block that Claude Code tool call — this is a tradeoff shared by every
  hooks-based tool; the more of them you stack, the more this risk compounds.
- **System-layer probe** (`CC-Monitor-probe`; bpftrace/eBPF on Linux, the built-in `nettop` on
  macOS): **read-only observation — it never modifies kernel state.** It attaches tracepoints to
  observe `execve`/`connect` syscalls; it doesn't intercept or inject anything. On Linux it needs
  root (`CAP_BPF`/`CAP_PERFMON`) to load the eBPF program, and there's a theoretical possibility of
  compatibility issues with a given kernel version or other eBPF programs running concurrently —
  but **the probe is never auto-started by the install scripts**. `install.sh`/`install.py` never
  invoke `sudo` anywhere; the probe only runs if you manually run `sudo ./bin/CC-Monitor-probe`
  yourself. Installing this tool by itself never requests root and never touches kernel parameters.
  macOS's `nettop`-based network probe needs no root at all.

### Q: Is the Web UI open to the network by default? Can someone else connect to it?

No. The Web UI binds only to `127.0.0.1` (localhost-only) by default; an administrator has to
explicitly set `CC_MONITOR_WEBUI_HOST=0.0.0.0` for it to listen on all interfaces — that switch is
off by default, and the UI surfaces a prominent warning about it. One caveat to keep in mind: the
Web UI's terminal-session feature (which can spawn a real shell) currently has **no authentication
mechanism** — binding to localhost is itself the only access control. If you deliberately open it
to `0.0.0.0` for remote access, you're exposing an unauthenticated shell entry point to anyone who
can reach that machine — put a reverse proxy with real authentication in front of it; don't expose
it bare.

## 3. Privacy: where does my data actually go?

**Short version: everything stays on your own machine — there is no reporting/telemetry logic in
the code.** That's not a marketing line; it's directly verifiable. The basis for the claim:

- **Where audit data lands**: `~/.cc-monitor/events.db`, a local SQLite file. The Web UI reads and
  writes that same file — there's no "upload to the cloud first, then display" step in between.
- **No telemetry/analytics code anywhere in the codebase**: searched for the common
  instrumentation keywords `analytics`/`telemetry`/`sentry`/`mixpanel`/`amplitude`/`posthog`/
  `track(` across all of `webui/` and `cc_monitor/` — zero matches.
- **No unfamiliar hardcoded external addresses**: searched every `http(s)://` address appearing
  anywhere in the codebase — the only matches are GitHub (a one-time GeoIP database download
  during install, and links in the README) and Anthropic (Claude Code itself talking to its own
  servers, not something CC-Monitor initiates) — no address pointing at some unfamiliar
  third-party server, no code path that "phones home" with your data.
- **IP geolocation lookups are local table lookups, not network calls**: the "which city does
  this IP belong to" shown on the world map / network traffic page reads a GeoIP database file
  downloaded locally at install time ([DB-IP Lite data, distributed via the sapics/ip-location-db
  project](./README.md#acknowledgments)) — every lookup is a local file read; the IPs you've
  visited are never sent to a third-party service to be looked up.
- **Anthropic account info** (name/email/plan/quota) is read directly from Claude Code's own
  local config file, `~/.claude.json` — likewise zero network requests.

Exceptions worth weighing yourself:

- If you turn on the "persistent archive" feature, the audit data still only moves to a different
  local file location — no network transfer is involved.
- If you set up your own reverse forwarding to sync logs to another machine, that's a wire you
  ran yourself — it isn't built-in CC-Monitor behavior.
- The live data you see in the Web UI (quota, model usage stats, etc.) originates from the
  official Claude Code client's normal communication with Anthropic's servers — CC-Monitor only
  reads and displays data Claude Code has already written locally; it doesn't make any extra
  requests of its own.

---

If you want to verify a specific claim (exactly what a given rule matches, exactly what a given
dependency does), read the source — this document itself is a conclusion drawn from reading the
source, not marketing copy.
