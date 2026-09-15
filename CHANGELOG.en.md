# Changelog

English | [简体中文](./CHANGELOG.md)

This file records what shipped in each version of CC-Monitor. Loosely follows
[Keep a Changelog](https://keepachangelog.com/) without strictly enforcing its categories.

## [1.7.2] - 2026-09-14

### Added
- **9 new rules inspired by the category breakdown of [suricata-rules](https://github.com/al0ne/suricata-rules)**:
  a network-layer Suricata IDS ruleset — a different detection layer from CC-Monitor entirely
  (packet content vs. Claude Code's own tool calls), so its rule text itself isn't portable, but
  its directory structure surfaced several attack-technique classes CC-Monitor had zero coverage
  for:
  - `crypto_miner_pool_domain_command`/`_write` (`medium`/`confirm`): a known cryptocurrency
    mining-pool domain (`pool.minexmr.com`/`monerohash.com`/`xmrpool.eu`, etc. — pulled from that
    repo's `Crypto_miner_pool` directory) or a `stratum://` URI appearing in a command or written
    content.
  - `db_arbitrary_file_write` (`high`/`confirm`, `tools: ["Bash"]`) +
    `db_arbitrary_file_write_content` (`medium`/`confirm`, `tools: ["Write","Edit",
    "NotebookEdit"]`): MySQL/MariaDB's `INTO OUTFILE`/`INTO DUMPFILE`/`general_log_file`
    features abused as an arbitrary-file-write primitive to drop a webshell into a web root (the
    idea behind that repo's `Mysql` directory's log-based file-write rule) — the existing
    `db_destructive_command` only covered DROP/DELETE/TRUNCATE, never this file-write technique.
  - `webshell_pattern_in_write` (`high`/`block`, inserted ahead of `dynamic_exec_in_write` so it
    wins first): the classic one-liner shapes behind China Chopper/Behinder/Weevely-style
    webshells (PHP's dynamic-exec builtins called directly on superglobal request arrays, and the
    equivalent ASP/JSP request-driven exec shapes) — far more precise than the existing catch-all
    `dynamic_exec_in_write` (which only recognizes a bare dynamic-exec call and is too noisy for
    anything above `log`); the false-positive rate here is low enough to justify an outright
    `block` — ordinary code essentially never takes this exact shape.
  - `curl_download_then_exec` (`high`/`confirm`): `curl_pipe_shell` only catches the `curl|sh`
    pipe form; "download with `curl -o x.sh`, then separately `chmod +x && ./x.sh`" — functionally
    identical but with no pipe character — went completely undetected before.
  - `c2_framework_execution` (`high`/`confirm`) / `pentest_recon_tool_execution` (`medium`/`log`):
    direct command-line invocation of pentest/C2-framework tooling (`msfconsole`/`msfvenom`/
    `teamserver`/`impacket-*`/`mimikatz`/`cobaltstrike`/`sliver`/`havoc`, vs. scanning tools like
    `nmap`/`sqlmap`/`hydra`/`nikto`/`gobuster` — the former is clearly higher-risk and gets its
    own tier).
  - `covert_tunnel_tool_execution` (`medium`/`confirm`): invocation of DNS/ICMP covert-tunneling
    tools (`dnscat2`/`iodine`/`dns2tcp`/`ptunnel`/`icmptunnel`/`hans`/`pingtunnel`) — a sibling
    rule to 1.7.1's `ssh_tunnel_reverse_proxy` under the same "covert outbound channel" theme.
  `default_rules.json` grows from 58 to 67 rules. Verified with 25 positive/negative test cases
  against the real `policy.evaluate()` (including the edge case that the new webshell rule must
  not catch an ordinary dynamic-exec call in regular code), plus a clean
  `python3 -m unittest tests/test_rules.py` and webui `node --test` run with no regressions. An
  existing user's `~/.cc-monitor/rules.json` will pick up all 9 automatically on the next hook
  invocation via the auto-merge mechanism added in 1.7.1 — no manual sync needed.

## [1.7.1] - 2026-09-14

### Fixed
- **Shell-history reads on macOS were not picked up by the sensitive-operations stats**: two root
  causes stacked.
  1. `~/.cc-monitor/rules.json` is a one-time copy made on first run, so rules added to
     `default_rules.json` by later versions (including `history_read` itself, which only arrived in
     1.6.0) never reached existing users — an early-1.x install measured 33 rules against 57 in the
     1.7.0 defaults. The CHANGELOG has warned "sync manually" half a dozen times; this release
     makes `policy.ensure_config()` merge automatically instead. Default rules missing locally are
     inserted by id right after their predecessor in the default table (preserving the ordered,
     first-match-wins semantics). A new `~/.cc-monitor/rules.defaults_snapshot.json` records the
     default table as of the last sync: a local rule identical to its snapshot (never edited by the
     user) whose default changed (e.g. a regex fix) is replaced with the new default; a rule that
     differs from the snapshot (user-edited) is left alone; an id missing locally but present in the
     snapshot counts as deliberately deleted and is not restored. The first sync after upgrading from
     an older version has no snapshot, so it only adds missing rules and never touches existing ones.
     The merged list is returned straight to `load_rules()`, so a read-only config dir still runs on
     the in-memory merge without affecting the hook.
  2. Even with the rule present, the old `history_read` regex only matched the single shape
     `cat/less/more/head/tail/strings` + history filename. How Claude Code actually reads history on a
     Mac was almost entirely outside it: `python3 -c "open('~/.zsh_history')"`,
     `wc -l < ~/.zsh_history`, `for f in ~/.zsh_history ...`, `grep token ~/.zsh_history`, zsh's
     native `fc -l`, `$HISTFILE`, macOS Terminal's per-session `~/.zsh_sessions/*.history`, Claude
     Code's own `~/.claude/history.jsonl`, and — most common of all — reading `~/.zsh_history` with
     the `Read` tool (the `sensitive_file_read` rule never included history files). `history_read` is
     rewritten: any history-file path anywhere in the command text (no reader-command prefix
     required, so `python`/`grep`/redirections all count), `$HISTFILE`, `.zsh_sessions/`,
     `.claude/history.jsonl`, or a sub-command starting with `history`/`fc -l` now matches. A new
     `history_file_read` rule (`tools: ["Read", "Grep"]`, `field: "file_path"`, `log` level) covers
     the Read/Grep tools reading history files directly. `history_tampering` also gains
     `.zsh_history` and `rm .zsh_sessions/`, the two Mac-side ways of wiping history (it only knew
     `.bash_history`).
  3. The WebUI sensitive-operations stats (`webui/lib/audit.js`) hardcoded the four rule ids in
     three places (a JS constant plus two SQL `IN (...)` lists); the SQL is now generated from the
     `SENSITIVE_READ_RULES` constant so there is one place to edit. `history_file_read` lands in
     "Other (shell history reads, etc.)"; the text used for classification is `command` for Bash and
     `file_path`/`path` for every other tool (previously only the literal tool name `Read` was
     recognised).
  Note: history reads that went unrecognised before the fix were stored with an empty
  `matched_rule` and are not recomputed retroactively; the stats only cover new events.
- **Investigated "MacPorts `port install` not detected"**: `system_package_install` has
  covered `port install/uninstall/upgrade/activate/deactivate/selfupdate` since 1d762af, the
  rule engine matches `sudo port install`, `port -N install`, `/opt/local/bin/port install`,
  `xargs sudo port install` and friends, and the audit DB (archives included) holds no record of
  any `port` command ever passing through the hook — so this was not a rule gap: the command
  never went through Claude Code's Bash tool (typed in the user's own terminal, run with the `!`
  prefix, or delegated back to the user because `sudo` needs a password — none of these are
  visible to a PreToolUse hook; that is the boundary of the mechanism, not a bug). The `port`
  regex was hardened anyway: global options carrying an argument or in long form (`-D /path`,
  `--debug`) between `port` and the action now match, and `sync` joins the action list.
- **System-package-manager (apt/yum/dnf/pacman/brew/port) stats were inaccurate: all 10 "hits"
  were false positives**: none of the 10 events attributed to `system_package_install` installed
  anything — they were `grep "port install" default_rules.json` and python heredocs containing the
  string `"apt install"`. Root cause: the rule engine ran `re.search` over the whole command text,
  treating quoted strings, heredoc bodies and grep search terms like real commands; `sudo_usage`
  and `sudo_pip_install` had the same problem (two editing commands during this fix got blocked
  because their heredocs mentioned `sudo apt-get install` / `sudo pip install`). Rules gain an
  optional `match` field: "search" (default, unchanged) or "segment" — split the Bash command into
  top-level sub-commands on `; & | newline` (never inside quotes/heredocs), strip `sudo`/`env`/
  `xargs`/`time`/`nice`/`nohup` wrappers, env-assignment prefixes and executable path prefixes
  (`/opt/local/bin/port` → `port`) from each, then `re.match` at the start; `bash -c "..."` and
  `osascript ... do shell script "..."` bodies are recursed into so a real install hidden in them
  still hits. Each segment is offered both raw and wrapper-stripped, because `sudo_usage` needs to
  see `sudo` itself while `apt`/`brew`/`port` rules need the real command name. Switched to
  segment mode: `system_package_install`, `package_install_other`, `npm_global_install`,
  `npm_local_install`, `sudo_usage`, `su_pkexec_privilege_escalation`, `sudo_pip_install`,
  `pip_install_no_venv`. `pip_install_venv_context` stays in search mode because its venv context
  (`source .venv/bin/activate`) lives in another sub-command. The dead `brew install` branch in
  `package_install_other` is removed (`system_package_install` runs first and always wins). In
  segment mode `matched_value` is the matching sub-command rather than the whole command, which
  reads better in the approvals UI and block reasons. `policy.split_shell_segments`/`segment_heads`
  are the Python counterpart of `splitShellSegments` in `webui/lib/audit.js`.
- **Historical events are re-evaluated automatically when rules change**: every home-page stat
  card aggregates `events.matched_rule`, a value computed once at event time against the rules of
  that moment — fixing a rule never un-did past false positives or picked up past misses. New
  `cc_monitor/rematch.py`: on every hook invocation the content fingerprint of the effective rule
  set (`policy.rules_fingerprint`, independent of file mtime, so auto-merge rewrites and `touch`
  don't trigger it) is compared with the one recorded in a `meta` table; when it differs the hook
  claims it with one atomic upsert and spawns a detached background `CC-Monitor rematch --apply
  --quiet` (thousands of events through the regexes take seconds, which a PreToolUse hook must not
  block on; concurrent hooks noticing the change spawn only one process). Only `risk`/
  `matched_rule` are rewritten, `decision` is never touched, archives are left alone. Manual:
  `CC-Monitor rematch` previews, `--apply` writes. On this machine the system-package count went
  from 10 to 0 and the 4 previously unrecognised shell-history reads gained `history_read`.
- **README "Known limitations" now states the monitoring boundary**: while investigating
  "brew/port installs are not counted" the commands turned out to have been typed in the user's
  own terminal (present in `~/.zsh_history`, absent from the audit DB); hooks only see tool calls
  Claude Code makes. The boundary was undocumented before; both READMEs now spell it out.
- **`tests/test_rules.py` covers segment mode and rematch**: 12 "mentioned but not executed"
  false-positive samples, 23 real-execution hits (including `bash -c`, `xargs`, env-var prefixes,
  subshell parentheses, absolute paths), and the assertion that rematch changes `matched_rule`
  but never `decision`.
- **New rules regression test `tests/test_rules.py`**: run with
  `python3 -m unittest tests/test_rules.py`; it uses an isolated `CC_MONITOR_HOME` and never
  touches the user's own `rules.json`. Currently covers the system-package-manager group
  (all MacPorts spellings included) and shell-history reads as "must hit / must not hit"
  samples, so the next "X was not detected" report starts by adding one sample line there.

## [1.7.0] - 2026-09-14

### Added
- **New detection for tampering with Claude Code's own config**: editing
  `~/.claude/settings.json` (or a project's `.claude/settings.json`/`settings.local.json`),
  scripts under `.claude/hooks/`, or `CLAUDE.md` had zero rule coverage before. This is the
  biggest gap found so far — rewriting the config to drop a hook registration is stealthier
  than `kill -9`-ing the probe process (no process needs to die; the application-layer
  monitoring just silently stops firing on the next tool call). Same "anti-bypass" goal as the
  existing `kill_monitoring_process`, just at the config layer instead of the process layer.
  Added `claude_config_tamper` (`risk: high`, `action: confirm`),
  `tools: ["Write", "Edit", "NotebookEdit"]`, `field: "file_path"`. `confirm` rather than
  `block` since adding a new hook to your own project or editing `CLAUDE.md` is a completely
  normal action. Inserted right after `shell_rc_write`.
- **Docker privileged/mount detection extended to Docker-socket mounts**:
  `docker_privileged_or_host_mount` previously only recognized `--privileged` and `-v /:/` —
  `-v /var/run/docker.sock:/var/run/docker.sock`, a more common and classic container-escape
  technique (mounting the host's Docker socket hands the container host-root-equivalent
  control), was a complete blind spot. Extended the regex with a `docker.sock` substring match,
  and bumped this rule's `risk` from `medium` to `high` (both `--privileged` and a docker.sock
  mount are host-root-equivalent risk, `medium` undersold it; `action` stays `confirm` to
  accommodate legitimate DinD/CI use cases).
- **New secret-format scanning on written content**: every existing rule judged by file path or
  command text — Claude writing an API key into a file with no sensitive-looking name (e.g.
  `config.py`, `notes.txt`) triggered nothing at all. Added `secret_pattern_in_write`
  (`risk: high`, `action: confirm`), `tools: ["Write", "Edit", "NotebookEdit"]`, using a new
  `field: "content"` to scan for private-key headers (`-----BEGIN ... PRIVATE KEY-----`), AWS
  access keys (`AKIA`/`ASIA` prefix), GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/
  `github_pat_`), Anthropic/OpenAI keys (`sk-ant-`/`sk-proj-`/`sk-`), Slack tokens
  (`xox[baprs]-`), Google API keys (`AIza`), npm tokens (`npm_`), and Stripe live keys
  (`sk_live_`) — high-confidence, fixed-prefix formats. Added a
  `"content": ["content", "new_string", "new_source"]` mapping to `FIELD_CANDIDATES` in
  `cc_monitor/policy.py` — Write uses `content`, Edit uses `new_string`, NotebookEdit uses
  `new_source`, all three semantically "the content about to be written," so one rule needs to
  recognize all three field names, the same trick already used for `file_path`. Writes to paths
  already covered by `sensitive_file_write` (like `.env`/`.ssh/`) won't double-fire — rule
  ordering ensures the more specific path rule wins first. Limitation: this is a fixed-prefix,
  character-class-and-length match, not an entropy check, so a sufficiently long placeholder key
  in documentation (all `x`s, say) can false-positive — the same limitation every lightweight,
  non-entropy secret scanner (gitleaks/trufflehog's non-entropy patterns) shares; `confirm`
  rather than `block` leaves room for a human to wave off exactly that case.
- **New git-hooks/git-config persistence-attack-surface detection**: `core.hooksPath`
  (redirecting git hooks to another directory), `url.<url>.insteadOf` (quietly swapping a
  dependency's source for an attacker-controlled repo — a real supply-chain technique), and
  writing directly into `.git/hooks/` via Bash redirection all had zero coverage before — the
  same "plant a persistent backdoor" risk category as the existing `crontab_persistence`/
  `systemd_persistence`, but the git-ecosystem equivalent was a complete blind spot. Added two
  rules: `git_hooks_persistence` (`risk: medium`, `action: confirm`, `tools: ["Bash"]`, covering
  the three command-line forms above) and `git_hooks_file_write` (same `medium`/`confirm`,
  `tools: ["Write", "Edit", "NotebookEdit"]`, `field: "file_path"`, covering writing into
  `.git/hooks/` directly via the Write/Edit tool — a form the command-based rule can't see).
  `git_hooks_persistence` is inserted right after `git_hard_reset_clean`.
  All four items above were verified with 26 positive/negative test cases, plus 13 regression
  cases covering every pre-existing rule category, all calling `cc_monitor/policy.py`'s real
  `evaluate()` directly (not a simplified regex re-implementation) — confirming the new rules
  match correctly and that adding the `"content"` mapping to `FIELD_CANDIDATES` didn't disturb
  how the existing `command`/`file_path`/`url` fields resolve. `node --test` still passes 5/5.
  As with prior rule additions, an existing user's `~/.cc-monitor/rules.json` won't auto-update
  to pick these up.
- **Implemented the 5 rule ideas named in the [slowmist-agent-security](https://github.com/evilcos/slowmist-agent-security)
  acknowledgment**: `credential_grep_scan` (recursive `grep -r`/`rg -r` searches for
  password/secret/api_key/token-style keywords, `medium`/`confirm`); `npx_pipx_ephemeral_run`
  (`npx`/`pnpm dlx`/`bunx`/`pipx run`/`uvx` — one-shot execution of a remote package without a
  local install footprint, `medium`/`confirm`); `proc_env_read` (reading another process's
  `/proc/<pid>/environ`/`cmdline` — a classic cross-process credential-theft technique,
  `high`/`confirm`); `browser_credential_read` + `browser_credential_read_bash` (Chrome/
  Chromium/Brave/Edge/Firefox `Cookies`/`Login Data`/`cookies.sqlite`/`logins.json`/`key4.db`
  files, covering both the Read tool and Bash command-line access paths, `high`/`confirm`);
  `dynamic_exec_in_write` (`eval(`/`exec(`/`os.system(`/`subprocess.*shell=True`/
  `new Function(`/`child_process.exec(` appearing in written content — common in planted
  backdoors, but also extremely common in ordinary code, so deliberately kept at
  `medium`/`log` to avoid interrupting normal coding).
- **Added encoded-payload execution detection**: `encoded_payload_exec` (`base64 -d`/
  `xxd -r -p` decoding piped into `sh`/`bash`/`zsh`/`python3` — the most common bypass variant
  of `curl_pipe_shell`, same "fetch/construct something and hand it straight to an interpreter"
  pattern, just obfuscated past the literal `curl`/`wget` text match; `high`/`block`, treated
  the same as `curl_pipe_shell`).
- **Added SSH tunnel / reverse-proxy detection**: `ssh_tunnel_reverse_proxy` (`ssh -R`/`-D`/
  `-L` tunnels, `socat`, `chisel client`/`server`; `medium`/`confirm` — plenty of legitimate
  uses like reaching an internal database, so not a `block`). Inserted right after
  `reverse_shell_pattern`; the more specific existing socat reverse-shell pattern still wins
  evaluation order when both could match.
- **Extended `claude_config_tamper` to cover MCP/Skills config too**: previously only matched
  `.claude/settings*.json`/`.claude/hooks/`/`CLAUDE.md`; now also covers project-level
  `.mcp.json` and the `.claude/skills/` directory — planting a malicious MCP server config or
  a malicious skill definition is a more subtle persistence backdoor than editing hooks, and is
  exactly the attack surface the slowmist checklist is focused on.
  Together this is 8 new rules (`default_rules.json` grows from 49 to 57) plus one patch to an
  existing rule, verified with 18 positive/negative test cases against the real
  `policy.evaluate()`. As always, an existing user's `~/.cc-monitor/rules.json` won't
  auto-update — resync manually to pick these up.
- **Wired up 6 session-lifecycle hooks**: `UserPromptSubmit`/`SessionStart`/`SessionEnd`/
  `PreCompact`/`Stop`/`SubagentStop` — previously only `PreToolUse`/`PostToolUse`/
  `PermissionRequest` were wired, so a purely conversational turn that never called a tool left
  zero audit trail. All 6 new hooks are **pure audit trail, never confirm/block** (lifecycle
  events have no "allow/deny" semantics): `UserPromptSubmit` records the user's raw input (the
  only hook that can show what the user actually asked Claude to do); `SessionStart`/
  `SessionEnd` record how a session started (`startup`/`resume`/`clear`/`compact`) and why it
  ended; `PreCompact` records a marker right before a long session gets compacted (so audit
  detail doesn't silently vanish with the compaction); `Stop`/`SubagentStop` record when the
  main task or a subagent finishes. `cc_monitor/hook.py` gained 6 corresponding `handle_*`
  functions, and `bin/CC-Monitor-hook <mode>` gained `prompt`/`session_start`/`session_end`/
  `precompact`/`stop`/`subagent_stop` modes; `install.py`'s `merge_hooks()` now takes an
  `extra_hooks` dict to register them in bulk — existing users just need to rerun
  `install.py`/`install.sh` to pick these up (the already-installed `PreToolUse`/
  `PostToolUse`/`PermissionRequest` entries are left untouched). Events land under
  `source="hook_prompt"` (`UserPromptSubmit`) and `source="hook_lifecycle"` (the other 5);
  `cc_monitor/format.py` and `webui/lib/format.js` got matching `TOOL_LABELS`/`STAGE_LABELS`/
  `describe()` branches, and `i18n.js` got the matching bilingual labels — the home page's
  "event type breakdown", the Log page, and terminal `CC-Monitor tail` all show these new
  events out of the box, no further UI wiring needed (they reuse the `events` table's existing
  generic source/tool_name/detail shape). Verified end-to-end against an isolated
  `CC_MONITOR_HOME` test directory (stdin → SQLite for all 6 hooks), and confirmed the Python
  and JS `describe()` implementations produce identical output.

## [1.6.0] - 2026-09-14

### Added
- **npm install stats now recognize local installs, not just global ones**: added an
  `npm_local_install` rule to `default_rules.json` (`risk: low`, `action: log`) matching
  `npm install`/`npm i` without `-g`/`--global`, placed after the existing
  `npm_global_install` rule (`risk: medium`, `action: confirm`) so a command the global rule
  already claimed never double-counts on the local side. Previously a local `npm install` had
  zero rule coverage at all — never blocked, never logged, never counted — and the Home page's
  "npm global installs" card was a complete blind spot for it, even though `npm install`'s
  `preinstall`/`postinstall` lifecycle scripts run with the exact same privileges as a global
  install and are just as real a supply-chain attack surface (the `event-stream` and
  `ua-parser-js` incidents both compromised machines at the local-install stage, not global).
  The Home card's label changed to "npm installs" (was "npm global installs"), showing the
  combined local+global total; clicking through no longer flattens both kinds into one list —
  the drilldown splits into separate "Global installs"/"Local installs" groups, since risk
  levels that aren't the same shouldn't look the same on screen. `INSTALL_RULE_GROUPS.npm` was
  updated to the union of both rules. Verified over a real WebSocket connection and a headless
  browser: the Home card correctly sums both, and the drilldown correctly sorts
  `sudo npm install -g pm2` / `npm install -g ccstatusline` into "Global" and
  `npm install` / `npm install lodash --save` / `npm i react` into "Local". An existing
  `~/.cc-monitor/rules.json` is a copy made on first run and won't pick up the new rule
  automatically — delete it to regenerate, or add it by hand.
- **New "New Window" button on Terminal Sessions**: shares the same working-directory picker
  modal as "New Session" (the modal's title/hint text swap dynamically based on which button
  opened it), the only behavioral difference being it never types `claude\r` into the freshly
  spawned PTY — "New Session" always drops you straight into a Claude Code session, and there
  was previously no entry point for just wanting a plain terminal to run a script or poke
  around files. `SessionManager.create()` gained a `launchClaude` parameter (defaults to
  `true`, so passing nothing keeps the old behavior); `POST /api/sessions` passes through
  `launchClaude: false` to skip it. The modal's dynamic title/hint also get re-applied on a
  language switch (reusing the same pattern as `syncGridToggleBtnText()` and friends for
  "state-dependent" text — a plain `data-i18n` static attribute alone isn't enough here).
  Verified by capturing terminal output over a real WebSocket connection for both modes:
  `launchClaude:false` shows only a bare shell prompt, `launchClaude:true` shows `claude\r`
  actually typed into the terminal.
- **World map gained an animated "this machine ↔ destination" arc with a travelling light
  dot**: a direct port of [BeeEye](https://github.com/cn0xroot/BeeEye) (another project by the
  same author)'s `WorldMap.jsx` — each connection draws a quadratic-bezier arc from a
  schematic anchor to the destination (`arc2d()`, bowed toward the pole for a great-circle
  feel), with a travelling dot at the head: direction follows whichever side of the connection
  moved more bytes (download-heavy animates back toward the anchor; inferred command-text
  targets have no real byte counts, so they default outward), a 2.2s cycle, the dot itself
  drawn as a single batched `drawArrays` call reusing the same `pointProg`/`FRAG_POINT` shader
  already used for destination glows — not just alpha-modulating the arc line itself, which
  the first version did and which a real screenshot showed was barely perceptible; the
  separate dot is what actually reads as "something travelling." The anchor has no real
  geographic meaning here (this is the machine running Claude Code, not the public egress the
  traffic actually passes through), so it's pinned at (0, 0) (open ocean off the Gulf of
  Guinea, "Null Island") — no extra request is made to ask a third party for the public IP
  just for this, and the legend explicitly says it isn't a real location. Falls back to Canvas
  2D (coastlines/arcs/dots/glows all present, `globalCompositeOperation='lighter'` standing in
  for the GL side's additive blending) when WebGL2 isn't available, so the map never
  disappears entirely just because of that. Verified both rendering paths with real
  screenshots from a headless browser: the dot correctly travels along the arc and the
  direction is correct in both GL and 2D mode (upload-heavy animates outward, download-heavy
  animates back toward the anchor).
- **New "SSH Operations" and "Downloads" cards on the Home page**: SSH operations split into
  five cards — ssh (remote login/exec) / scp (file copy) / sftp (file transfer) / key
  management (`ssh-keygen`/`ssh-copy-id`/`ssh-add`/`ssh-agent`) / other
  (`autossh`/`sshpass`); downloads split into four — wget / curl (only counted when it writes
  to a file via `-o`/`-O`/`--output` — a bare curl call to an API isn't a "download") / aria2 /
  other (`axel`/`lftp`/`ftp`/`http`). Classified exactly like the existing GitHub operation
  stats (`classifyGithubOp`): split on `;`/`&`/`|`/newlines, check each sub-command's start,
  never a substring match against the whole text. Added the `cc_ssh_op`/`cc_download_op` SQL
  custom functions in `webui/lib/audit.js`, and `/api/drilldown/ssh-op/:type`,
  `/api/drilldown/download-op/:type` endpoints.
- **The "AI Trajectory" card and world map now also include command-text-inferred network
  targets**: "AI Trajectory" used to depend entirely on the system-layer probe's (eBPF/nettop)
  observed data, and many people never start the probe by hand (it needs a separate
  `sudo ./bin/CC-Monitor-probe`), so the card and the world map stayed empty even when Claude
  had clearly run a pile of networked commands like wget/curl/git clone/ssh/scp. Now the
  target hostname is extracted from these commands' text (`extractCommandHosts()`: the host in
  a URL, `user@host` form, `host:path` form — deliberately never a bare hostname with no `@`
  and no trailing colon; an earlier version misread the output filename in
  `curl -o out.tar.gz ...` and the local source path in `scp file.txt user@host:/path` as
  "hostnames," since those strings are also dotted and followed by whitespace, structurally
  indistinguishable from a real host by regex alone — tightening the rule to require an `@`
  prefix or an immediately-following colon fixed it), lazily resolved via DNS
  (`dnscache.js`, cached with a timeout — deliberately not done inside the hook, to avoid
  slowing down every Bash call) and geo-located, then merged into the same `network.js`
  pipeline (`listTraffic()`/`summary()`/`geoPairs()`) used for probe data, tagged
  `inferred: true` and rendered as an "inferred" badge on the frontend — never passed off as
  confirmed probe traffic, since there's no way to know whether the command actually connected
  or how many bytes moved. Verified end-to-end: real DNS resolution of github.com/example.com
  to correct IPs, GeoIP lookups landing in Toronto/Singapore, and the AI Trajectory drilldown
  correctly attributing Session/folder info back to the session that ran the command.
- **New "Screenshot Audit" card on the Home page**: Claude Code has no built-in "screenshot"
  tool, so this is identified from three independent signals — ① a Bash command invoking a
  screenshot CLI (`scrot`, `gnome-screenshot`, `import`, `spectacle`, `flameshot`, `maim`,
  `grim`, `xwd`, macOS's `screencapture`, or the Wayland-typical `gdbus`/`dbus-send` call to
  `org.freedesktop.portal.Screenshot` — matched the same way as the existing
  `commandDeletesFiles()`: split on `;`/`&`/`|`/newlines and check each sub-command's start,
  never a substring match against the whole text, so an `echo`'d string can't be misread as a
  real invocation); ② the `Read` tool opening a file that's itself an image
  (`.png`/`.jpg`/`.gif`/`.webp`/`.bmp` — deliberately broader than "screenshot," since the user
  explicitly wanted viewing an existing image counted too); ③ an MCP/"computer use" tool's
  screenshot action (a tool name containing "screenshot" — e.g. what browser-automation MCP
  servers like Playwright/Puppeteer expose — or a `computer` tool whose `action` field is
  `"screenshot"`). Added the `cc_is_screenshot` SQL custom function in `webui/lib/audit.js` and
  a new `/api/drilldown/screenshot` endpoint. The drilldown **only shows basic info (the command
  or file path), never reads or renders the screenshot's own image content** — an explicit scope
  call from the user, since a screenshot can easily contain sensitive desktop content that a web
  page shouldn't be serving. Verified end-to-end with an isolated test database and a headless
  browser: the home card count is correct, the drilldown lists exactly the matching events, and
  non-matching commands (`ls -la`, opening a plain text file) are correctly excluded.
- **New kill/pkill monitoring-tamper detection rules**: `default_rules.json` gains two rules —
  `kill_monitoring_process` (`risk: high`, `action: confirm`) matches `kill`/`pkill`/`killall`
  followed by one of CC-Monitor's own process names (the probe binary, `probe_linux.bt`/
  `probe_darwin.py`, `cc_monitor.probe`, `bpftrace`) — this is the "someone is trying to shut
  down the monitoring itself" scenario, set to `confirm` rather than `block` since restarting
  the probe for legitimate maintenance is a normal action that shouldn't be hard-blocked, just
  surfaced for a human to confirm; a generic `kill`/`pkill`/`killall` (`process_kill`, `risk: low`,
  `action: log`) sits after it as a catch-all, log-only, since killing processes is extremely
  common in day-to-day dev work and flagging every instance for confirmation would cause alert
  fatigue. Both rules are inserted between `disable_security_controls` and `sudo_pip_install`,
  with ordering ensuring the CC-Monitor-specific rule matches first. An existing user's
  `~/.cc-monitor/rules.json` is a copy made on first run and does not auto-update — delete it to
  regenerate, or add these rules manually, to pick them up.
- **New "Docker Operations" home card**: same approach as the SSH/Download operation stats —
  split on `;`/`&`/`|`/newlines and check only each sub-command's start, into five cards: run
  (start a container) / build (build an image) / exec (run inside a running container) / compose
  (`docker compose` or the standalone `docker-compose`) / other (read-only inspection commands
  like `ps`/`logs`/`images`). run/build/exec are broken out separately because they can execute
  arbitrary code from an external image, Dockerfile, or a running container — not the same risk
  tier as pure read-only inspection. Added `classifyDockerOp`/`dockerOpsStats`/`dockerOpsDetails`
  and the `cc_docker_op` SQL custom function in `webui/lib/audit.js`, plus a new
  `/api/drilldown/docker-op/:type` endpoint. Verified against 9 real commands in an isolated test
  database (including an `echo "docker run..."` string, confirmed not to be misread as an actual
  `docker run`) — all classified correctly; also verified the home card counts and the drilldown
  modal via a headless-browser screenshot.
- **Sensitive-file-read detection extended to Bash commands**: previously the
  `sensitive_file_read` rule only covered the `Read` tool opening sensitive paths
  (`.ssh/`, `.aws/credentials`, `.env`, private keys, etc.) directly — reading the same files via
  a Bash command like `cat`/`less`/`head` was a complete blind spot. Added
  `sensitive_file_read_bash` (`risk: medium`, `action: log`) covering
  `cat`/`less`/`more`/`head`/`tail`/`strings`/`xxd`/`hexdump`/`od` followed by one of those
  sensitive paths, plus `env_dump` (`risk: low`, `action: log`) logging
  `env`/`printenv`/`export -p` — commands that print the entire current-process environment
  (which can include API keys/tokens) to the terminal. Both rules are inserted between the
  existing `sensitive_file_read` and `system_config_write`. These rules reuse `policy.py`'s
  existing plain `re.search` matching and do not get the same quote/heredoc awareness as the
  webui-side `splitShellSegments()` — that's a pre-existing characteristic shared by all 30+
  rules in the Python policy engine, not something newly introduced by these rules; fixing it
  properly would mean reworking the whole policy engine, which is out of scope here. As with the
  rules above, an existing user's `~/.cc-monitor/rules.json` won't auto-update to pick these up.
- **New `su`/`pkexec` privilege-escalation detection**: previously only `sudo_usage` covered
  privilege escalation — `su`/`pkexec`, which achieve the same thing (switch to, or run as,
  another user — typically root), were a complete blind spot. Added
  `su_pkexec_privilege_escalation` (`risk: medium`, `action: confirm`), matching `su`/`pkexec`
  only at the start of a command or right after `;`/`&&`/`||` (the same shape as the existing
  `sudo_usage` pattern, `(^|;|&&|\|\|)\s*sudo\b`), so an `echo su`-style string or the token "su"
  appearing inside something like `subprocess.run(...)` isn't misread as an actual escalation.
  Inserted right after `sudo_usage`.
- **New single-file, non-recursive `chmod 777` detection**: `chmod_world_writable_recursive` only
  matched when the target path started with `/` or `~`, and `chmod_recursive_generic` only
  matched when `-R` was present — `chmod 777 file.txt` (a relative path, single file, no
  recursion) fell through both. Added `chmod_777_single_file` (`risk: medium`, `action: confirm`),
  inserted right after `chmod_recursive_generic` so rule ordering guarantees it only fires when
  neither of the earlier two already matched (a `-R` call or a `/`- or `~`-rooted target is
  already handled, at its appropriate severity, by an earlier rule — no double-firing or
  downgrade).
- **New destructive direct-database-command detection**: `mysql`/`psql`/`redis-cli`/`mongo`/
  `mongosh`/`sqlite3` followed by `DROP`/`DELETE`/`TRUNCATE` (SQL) or `FLUSHALL`/`FLUSHDB` (Redis)
  previously had zero rule coverage — these can write directly to production data, the same risk
  category as "deleting files," but were completely off the radar. Added `db_destructive_command`
  (`risk: high`, `action: confirm`), inserted between `history_tampering` and
  `docker_privileged_or_host_mount`. Verified with 23 positive/negative test cases covering both
  matching and the interaction with existing rules' precedence (e.g. `chmod -R 777 subdir`
  correctly hits the earlier `chmod_recursive_generic` rather than the new one, and
  `chmod 777 ~/.ssh/id_rsa` correctly hits `chmod_world_writable_recursive`); `node --test` still
  passes 5/5 — not a regression. These three rules reuse `policy.py`'s existing plain regex
  matching without the webui-side quote/heredoc awareness, for the same reason noted above for
  `sensitive_file_read_bash`/`env_dump`; an existing user's `~/.cc-monitor/rules.json` likewise
  won't auto-update.
- **New shell-history-read detection**: commands reading shell history files (`cat
  ~/.bash_history`, `cat .history`, etc.) and running the bare `history` builtin (which dumps the
  current session's command history straight to stdout) had zero rule coverage — command history
  frequently retains plaintext passwords/tokens typed as CLI arguments in the past, a real
  information-leak path. Added `history_read` (`risk: low`, `action: log`), covering
  `cat`/`less`/`more`/`head`/`tail`/`strings` reading `.bash_history`/`.zsh_history`/
  `.python_history`/`.mysql_history`/`.psql_history`/`.node_repl_history`/any `*.history` file, and
  a bare `history` at the start of a command or right after `;`/`&&`/`||` (the destructive
  `history -c` case is already covered by the earlier `history_tampering` rule; ordering plus an
  explicit `(?!\s*-c\b)` exclusion avoids double-firing). Inserted right after `history_tampering`.
  Verified with 13 positive/negative test cases covering matching and precedence — not a
  regression.
- **Strengthened reverse-shell / backdoor-execution detection**: the previous
  `reverse_shell_pattern` only recognized `nc ... -e /bin/sh` — real attacker/red-team toolkits
  have several common variants that were a complete blind spot: `nc`/`ncat`/`netcat` using `-c`
  instead of `-e` (how some nc variants invoke a command), `ncat`/`netcat` — nc's own aliases —
  weren't recognized at all, `socat` doing a reverse shell via an `exec:` target (many hardened
  systems ship an nc without `-e` support, making `socat` the most common substitute), and a
  reverse shell hand-assembled from a `mkfifo` named pipe plus `nc` + a shell without any `-e`/`-c`
  flag at all (stealthier, since it evades any check keyed on those flags). Expanded
  `reverse_shell_pattern`'s regex to cover all four new variants, keeping `risk`/`action` at the
  existing `high`/`block`. Verified with 17 positive/negative test cases (the original `nc -e`,
  `/dev/tcp`, and `sh -i` forms had to keep matching — no regression from the change — while
  ordinary network-diagnostic usage like `nc -zv`, `nmap`, `ncat --ssl` had to stay unflagged).
  Deliberately out of scope: one-liner reverse shells in scripting languages (Python/Perl/PHP/Ruby,
  e.g. `python3 -c "import socket,subprocess..."`) — their "danger" depends entirely on the
  script's semantics, and a plain regex would either miss most variants or flag a large amount of
  legitimate code that happens to use the `socket` module; the false-positive cost was judged too
  high for this pass.
- **New "Archive/Compression Operations" home card**: same approach as the SSH/Download/Docker
  operation stats — split into tar / zip (including unzip) / 7z / gzip (including gunzip/zcat) /
  other (bzip2/xz/zstd/rar, etc.), five cards, classified from the Bash command text. Added
  `classifyArchiveOp`/`archiveOpsStats`/`archiveOpsDetails` and the `cc_archive_op` SQL custom
  function in `webui/lib/audit.js`, plus a new `/api/drilldown/archive-op/:type` endpoint.
- **New "Network Diagnostic Tools" home card**: nc (including the ncat/netcat aliases) / nmap /
  telnet / other (socat), four cards — purely a "was this tool used" visibility stat, a separate
  concern from the reverse-shell risk judgment above: `nc -zv example.com 443`, an ordinary port
  probe, is still counted on this card without implying danger. Added
  `classifyNetdiagOp`/`netdiagOpsStats`/`netdiagOpsDetails` and the `cc_netdiag_op` SQL custom
  function, plus a new `/api/drilldown/netdiag-op/:type` endpoint.
- **New "Process Management / Backgrounding" home card**: nohup / disown / background job (a bare
  trailing `&`) / other (setsid), four cards. The first two are classified by sub-command start,
  the same approach as the other classifiers; "background job" is different — a bare `&` isn't a
  command name, it's a shell-syntax marker at the end of the whole command, and
  `splitShellSegments()` itself treats a lone `&` as a separator, so it can't be identified by
  "look at the sub-command's start." Instead it's detected by scanning the raw command text for an
  "isolated `&`": not immediately preceded by `&`/`>` (excludes `&&`, `2>&1`, `&>` — none of which
  are real background markers), not immediately followed by a digit/`&`/`>` (excludes file
  descriptor redirection), and, after that `&` (skipping whitespace), immediately the end of the
  command or a `;`. This is deliberately narrow to avoid false-positiving on the `&` inside a URL
  query string like `curl 'http://x.com/a&b=c'`, at the cost of missing a rarer form like
  `task1 & task2` (backgrounding immediately followed by another command with no `;` in between).
  Added `classifyProcessBackground`/`procbgOpsStats`/`procbgOpsDetails` and the `cc_procbg_op` SQL
  custom function, plus a new `/api/drilldown/procbg-op/:type` endpoint.
- **New "Subagent spawns" home card**: same approach as the MCP/Skill call stats, just grouped by
  the `subagent_type` field in `tool_input` (`general-purpose`/`Explore`/`Plan`/`fork`, or a
  user-defined subagent name). Different Claude Code versions call this tool "Task" or "Agent" —
  both are recognized. Subagents consume independent resources and have their own full trail of
  operations, previously buried inside the generic "tool calls" count with no dedicated
  visibility. Added `subagentCallStats`/`subagentCallBreakdown`/`subagentCallEvents` and a new
  `/api/drilldown/subagent-calls` endpoint, reusing the same SQL `json_extract` grouping technique
  already used by `mcpCallBreakdown`/`skillCallBreakdown`.
  All four of the above stat cards, plus the reverse-shell detection expansion and the
  history-read detection, were verified against isolated test databases (the archive/netdiag/
  procbg classifiers additionally verified that a `&` inside a curl URL query string, `cmd1 &&
  cmd2`, and `echo '...'` — three known false-positive sources — are correctly excluded) plus a
  headless-browser screenshot of the end-to-end flow: home card counts are correct, and the
  drilldown lists exactly the matching events. `node --test` still passes 5/5 — not a regression.
- **Collapsed the GitHub/SSH/Download/Docker/Archive/Network-Diagnostics/Process-Management home
  cards into one card per group**: these seven groups previously each rendered a full row of
  sub-category cards (6+5+4+5+5+4+4 = 33 cards total), which stacked up into a wall of cards. Each
  group now shows a single summary card (the number is the sum across that group's categories);
  clicking it reveals a category breakdown table plus the full command list (each entry tagged
  with a category badge) — the same interaction pattern already used by the MCP/Skill/Subagent
  call cards. In `webui/lib/audit.js`, each group's separate `xxxOpsStats()`/`xxxOpsDetails(type)`
  pair was replaced with two generic functions, `opsBreakdown(sqlFn)`/`opsEvents(sqlFn)` (all
  seven groups were already the same "classify via a `cc_xxx_op()` SQL custom function, `GROUP BY
  kind`" query shape, just with a different function name — extracting it removed about 190 lines
  of duplication). `server.js` correspondingly replaced the 14 single-category
  `/api/drilldown/xxx-op/:type` endpoints with 7 `/api/drilldown/xxx-ops` endpoints (no `:type`),
  each returning `{breakdown, events}` in one call; the home card totals now read
  `sumN(audit.xxxOpsBreakdown())`. The now-unused per-group constants that existed only to
  validate the old `:type` URL parameter (e.g. `GITHUB_OP_TYPES`) and the orphaned
  `drilldown.githubOp.suffix` i18n key were removed along with them — no backwards-compat
  leftovers. Verified against an isolated test database plus a headless-browser screenshot: the
  home page went from 7 rows of 33 cards down to 1 row of 7 cards, and opening one (GitHub
  operations was the one screenshotted) correctly shows the category breakdown table and the
  syntax-highlighted command list. `node --test` still passes 5/5 — not a regression.

### Fixed
- **Command classifiers false-positiving: heredoc/quoted multi-line strings misread as
  several independent sub-commands**: Screenshot Audit, GitHub/SSH/Download operation stats,
  and the AI Trajectory command-hostname extraction all share the same "split on
  `;`/`&`/`|`/newlines, check each sub-command's start" approach — but the naive newline split
  has a hole: a newline inside a double-quoted argument or a heredoc body (`<<'EOF' ... EOF`)
  is part of the content, not a shell-syntax command separator. This machine's own audit data
  caught two real cases: in `python3 -c "\nimport json,sys\n..."`, the line `import json,sys`
  inside the quoted argument got read as an invocation of ImageMagick's `import` screenshot
  command; in `git commit -m "$(cat <<'EOF' ... EOF)"`, a word-wrapped line inside the heredoc
  body (which happened to be this project's own previous commit describing the screenshot
  feature, mentioning the "spectacle" screenshot tool by name) got read as an actual call to
  `spectacle` — this is exactly what the "too many false positives" report was catching. Added
  `splitShellSegments()`, a small shell tokenizer (tracks whether the cursor is currently
  inside a single/double quote or a heredoc body) that replaces every classifier's old
  `cmd.split(/[;&|\n]+/)` — only separators at the true "top level" now split. Also dropped
  `import` from the screenshot CLI list entirely (ImageMagick's `import` is already marginal
  on modern Linux desktops, and "import" is too common a Python keyword to be worth the
  collision risk even with the tokenizer fixed). Verified against the two real reproduction
  cases: both false-matched before the fix and are correctly excluded after, while genuine
  `scrot`/`gnome-screenshot` invocations still match; the other classifiers (GitHub/SSH/
  Download operation stats) were re-run through their existing unit tests with identical
  results — not a regression.

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
- **`install.sh` now installs and wires up ccstatusline**: new step 1 checks whether
  [ccstatusline](https://github.com/sirmalloc/ccstatusline) is already on `PATH`
  (`command -v ccstatusline`) and runs `npm install -g ccstatusline` if not; once it's
  available, `install.py`'s `configure_statusline()` writes a `statusLine` entry into
  `~/.claude/settings.json` if one isn't already there (`command: "ccstatusline"`,
  `padding: 0`, `refreshInterval: 10`). Both conditions have to hold before anything is
  written — not installed means nothing to wire up, and an existing `statusLine` (whether
  it's ccstatusline or something else, with any settings) is never overwritten, respecting
  whatever the user already configured. `--skip-ccstatusline` /
  `CC_MONITOR_SKIP_CCSTATUSLINE=1` skips both the install and the wiring (internally passed
  through as `install.py --skip-statusline`). The GeoIP download step is renumbered to 5.
- **`install.sh` step 5 downloads the GeoIP database**: DB-IP Lite (CC BY 4.0, ~60MB) to
  `~/.cc-monitor/dbip-city.mmdb` (honours `CC_MONITOR_HOME`). Skipped if any `.mmdb` is
  already present; downloads to a `.part` file first and treats anything under 1MB as a
  failure (deleted), so a truncated file can never make geoip.js fail silently; a failed
  download warns without aborting. `--skip-geoip` / `CC_MONITOR_SKIP_GEOIP=1` skips it,
  `CC_MONITOR_GEOIP_URL` points at a mirror.

- **`system_package_install` rule now covers macOS package managers**: `brew
  install/reinstall/uninstall/remove/rm/upgrade/tap/untap/bundle` (incl. `brew cask …`) and
  MacPorts `port [-flags] install/uninstall/upgrade/activate/deactivate/selfupdate` (things
  like `port installed` or `lsof -i :port` don't match). The "system package manager" card on
  the home page is relabelled accordingly. Also fixed `pacman -Syu` not matching (the old
  regex required S/R to be the last flag letter). Note that an existing
  `~/.cc-monitor/rules.json` is a copy made on first run and is not updated automatically —
  delete it to regenerate, or edit it by hand.

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
