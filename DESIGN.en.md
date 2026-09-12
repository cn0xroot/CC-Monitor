# AI Operation Monitoring Tool — Technical Design

[简体中文](./DESIGN.md) | English

## 1. Background and Goals

Monitoring target: every operation Claude Code performs on this machine that could affect system
or data security — file reads/writes, command execution, network access, and anything else a
Claude Code tool can trigger.

Goals:
- **Visibility**: record what Claude Code did (who, when, on what, what action, what result).
- **Control**: high-risk operations can be blocked/alerted/require human confirmation, not just
  audited after the fact.
- **Hard to bypass**: the monitoring capability must not be easy to disable by Claude Code itself
  (whether through normal behavior or after being hijacked by prompt injection).
- **Cross-platform**: works on both Linux and macOS, sharing as much core logic as possible.

## 2. Monitoring Scope

Claude Code's operations fall into four categories:

| Category | Specific operations | Corresponding Claude Code tools |
|---|---|---|
| File I/O | Read files, write/overwrite files, edit (diff), batch replace | Read / Write / Edit / NotebookEdit |
| Command execution | Shell commands, background processes, scripts | Bash |
| Network access | Fetch web pages, call external APIs/MCP services | WebFetch / WebSearch / MCP tools |
| Meta operations | Spawn subagents, cross-session messages, permission mode switches | Agent / SendMessage / permission mode changes |

Two outcomes need to be guarded against above all: **damaging the system** (deleting files,
changing config, running dangerous commands) and **leaking data** (reading credentials/secrets
and exfiltrating them over the network).

## 3. Overall Approach: Two-Layer Monitoring Architecture

Relying solely on Claude Code reporting on itself (hooks) has a fundamental problem: if the
Claude Code process is bypassed, the hooks config is tampered with, or an attacker disables
monitoring through some other path (e.g. tricking the user into editing the config directly),
monitoring becomes worthless. The design therefore uses two lines of defense — **application
layer + system layer**:

- **Application layer (primary, semantically rich)**: uses Claude Code's built-in Hooks mechanism
  (`PreToolUse` / `PostToolUse`, etc.) to intercept before and after every tool call, getting
  structured information (tool name, arguments, cwd, session_id). The advantage is clear semantics
  ("Bash ran `rm -rf /tmp/x`") at low cost (a handful of cross-platform shell/Python scripts). The
  downside is that this layer runs inside the monitored subject's own framework, and can in theory
  be bypassed by tampering with its configuration.

- **System layer (backstop, anti-bypass)**: audits/sandboxes the Claude Code process tree at the
  OS level, independent of whether Claude Code cooperates. Even if the application layer is
  bypassed, the system layer still sees the real `execve`/`open`/`connect` syscalls, serving as
  the last line of defense.

Both layers report independently to the same local agent and cross-check each other (e.g. if the
system layer observes a file write but the application layer has no corresponding event, that
mismatch is itself a high-risk signal that monitoring has been bypassed).

```mermaid
flowchart TB
    subgraph App["Application layer (semantic layer)"]
        CC["Claude Code process"] -- PreToolUse/PostToolUse --> Hook["Hook script"]
    end
    subgraph OS["System layer (backstop)"]
        CC -- real syscalls --> Kernel["Kernel: execve/open/connect"]
        Kernel --> Probe["OS probe\n(eBPF / auditd / ESF)"]
    end
    Hook --> Agent["Local monitoring agent (persistent)"]
    Probe --> Agent
    Agent --> Policy["Policy engine\n(rule matching / risk grading)"]
    Policy -->|allow/log| Log["Audit log\n(local storage + optional upload)"]
    Policy -->|high risk| Block["Block / confirm dialog / alert"]
    Block -. exit code 2 .-> CC
```

## 4. Core Component Design

### 4.1 Hook Interceptor (application-layer entry point)
- Registers `PreToolUse` and `PostToolUse` hooks in `~/.claude/settings.json` (global) or a
  project's `.claude/settings.json`, with a matcher covering `Bash|Write|Edit|Read|WebFetch|...`.
- The stdin JSON the hook receives includes `session_id`, `cwd`, `tool_name`, `tool_input` (e.g.
  the raw command text / file path).
- Implemented as Python or a compiled Go binary (cross-platform, no dependencies), forwarding
  events to the local agent (Unix domain socket — low latency, permissions controllable).
- If a `PreToolUse` hook judges an operation to be high-risk, it denies it with a specific exit
  code; Claude Code aborts that tool call and reports the denial reason back to the model.

### 4.2 System-Layer Probe (OS layer — Linux portion implemented in Phase 2)

| Capability | Linux approach | macOS approach |
|---|---|---|
| Process/network event auditing | **Implemented**: a `bpftrace` script (`cc_monitor/probe_linux.bt`) tracks `execve`/`connect` across the entire descendant process tree spawned by the `claude` process, without depending on auditd | Endpoint Security Framework (`eslogger` allows quick validation without writing a custom System Extension; a production build needs a signed ES client + user-granted Full Disk Access) — not yet implemented |
| Mandatory sandbox (blocking, not just auditing) | Landlock LSM (kernel ≥5.13, restricts reads/writes by path) or wrapping the process with bubblewrap/firejail, restricting writable directories and mounting a read-only root — not yet implemented | `sandbox-exec` (with a custom profile) or running inside a container/lightweight VM (OrbStack/Docker Desktop) — not yet implemented |
| Network monitoring | **Implemented**: captures the destination IP:port of `connect()` syscalls directly via eBPF (+ best-effort reverse DNS), no TLS termination, no CA certificate needed | The same idea (connection-level visibility instead of MITM) is not yet implemented on macOS |

**How the process tree is identified**: after a child process forks but before it actually execs
a new program, its `comm` hasn't changed yet — it still inherits the parent's ("claude"). The
moment that child execve's into something else is evidence it descends from Claude Code;
`sched_process_fork` propagates this "lineage" to every subsequent descendant. In practice this
cleanly separates Claude Code's own activity from the noise of other desktop processes (conky,
gnome-shell, etc.).

**Cross-verification**: `CC-Monitor-probe` fuzzy-matches the top-level shell invocations it observes
(things like `bash -c "..."`) against recent `hook_pre` Bash records (time window + substring
match after stripping quotes, since Claude Code's Bash tool often wraps the original command in a
`eval '<command>'` shell-snapshot script before executing it). Anything that doesn't match gets
flagged as `hook_bypass_suspected` — the typical scenario being "the approved command itself was
short, but at runtime it went on to exec something that was never reviewed at all." Inspect these
with `CC-Monitor verify`.

Requires root to run (bpftrace needs `CAP_BPF`/`CAP_PERFMON` or plain root); currently started
manually, not yet packaged as an autostart persistent service (whether to install it as a systemd
service is an operational decision — during the MVP phase it's run manually).

Recommendation for the MVP phase: have the system layer do **auditing only** at first (no
mandatory blocking — low cost, no kernel extension/signing needed); file and command **blocking**
is handled primarily by the application-layer hooks; the network layer is managed uniformly via a
local proxy (this approach is identical on Linux/macOS and offers the best cost/benefit ratio).
The system layer's mandatory sandbox (Landlock/sandbox-exec/containerization) is an optional
"high-security mode" reserved for Phase 2.

### 4.3 Policy Engine
Example rules (configurable, stored as YAML/JSON):

- **High risk (deny + alert by default)**: `rm -rf`, `dd`, `chmod -R 777 /`, `curl|bash`, `sudo`,
  writing to `~/.ssh/*`, `.env`, `~/.aws/credentials`, accessing a non-whitelisted domain combined
  with reading a sensitive file (a read + exfiltrate combination triggers higher risk).
- **Medium risk (log + confirmation dialog)**: writes outside the project directory, modifying
  system config files (`/etc/*`), bulk file deletion.
- **Low risk (log only)**: routine reads/writes inside the project directory, git operations.

Matching approach: commands are matched with rules + keywords/regex, optionally combined with a
lightweight local model for semantic judgment (e.g. having it explain "what is this command
block's intent, does it match a known destructive pattern"); file paths use glob allow/deny lists.

### 4.4 Audit Log (tamper resistance)
- Stored locally as SQLite or append-only JSONL; the agent process's permissions are isolated from
  the Claude Code process (a different user, or at minimum directory permissions that only allow
  the agent to write while Claude cannot).
- On Linux, the log file can be marked `chattr +a` (append-only) for extra tamper resistance; logs
  are also forwarded asynchronously to a remote/separate host, to avoid the "logs get wiped too
  once the local machine is compromised" problem.
- Event schema (shared across both layers):
```json
{
  "ts": "2026-09-11T22:10:00Z",
  "session_id": "...",
  "source": "hook|os_probe",
  "tool_name": "Bash",
  "action": "execute",
  "detail": {"command": "rm -rf ./build"},
  "cwd": "/home/init3/project",
  "risk_level": "high",
  "matched_rule": "dangerous_delete",
  "decision": "blocked|allowed|pending_confirm"
}
```

### 4.5 Alerting and Human Confirmation
- High-risk operations: terminal/system notification (`notify-send` / macOS `osascript`) + an
  optional requirement that the user click "allow once / always allow / deny" in the notification
  or a local web page.
- A local CLI (e.g. `CC-Monitor tail`, `CC-Monitor rules`) for live-viewing the event stream and adjusting
  rules; the MVP does not include a web dashboard.

## 5. Phased Roadmap

1. **MVP (done)**: hook interceptor + policy engine (rule matching) + local SQLite audit log + CLI
   viewer (`CC-Monitor tail/rules/stats`). Covers Linux/macOS (macOS untested).
2. **Phase 2 (Linux portion done)**: `CC-Monitor-probe` (bpftrace) tracks the exec/connect activity of
   the claude process tree for audit cross-verification; `CC-Monitor verify` detects "application layer
   bypassed" situations; the network layer captures `connect()` directly via eBPF instead of a MITM
   proxy. Still not done: a graphical desktop confirmation dialog for high-risk operations
   (currently a terminal tty confirmation), the macOS counterpart (ESF), and running it as a
   persistent service.
3. **Phase 3 (platformization, not started)**: an optional mandatory sandbox mode
   (Landlock/bwrap, sandbox-exec/containerization), cross-machine log aggregation, a
   community-shared rule set.

## 6. Known Limitations

- The application-layer hooks depend on Claude Code calling them honestly; if `settings.json` is
  tampered with (e.g. permission misconfiguration lets another process rewrite it), the hooks can
  be turned off — this is exactly why the system-layer backstop audit exists.
- macOS's mandatory sandbox/system-level audit (ESF) requires the user to manually approve it in
  System Settings (Full Disk Access, System Extension signing), so fully silent deployment isn't
  possible; the MVP phase does not depend on this path yet.
- Semantic-layer rules can't cover every "looks harmless but actually isn't" command combination —
  the rule set should keep iterating, with human confirmation kept as a backstop.
