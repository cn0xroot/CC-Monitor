"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");
const agentsRegistry = require("./agents");
// 启动时顺手确认 node-pty 的 spawn-helper 有可执行位（见 scripts/fix-node-pty-perms.js，
// 没有的话 pty.spawn 会直接抛 "posix_spawnp failed."）。幂等，通常什么都不做。
try {
  require("../scripts/fix-node-pty-perms").fixNodePtyPerms();
} catch (e) {
  // 修不了（只读文件系统之类）就算了，真有问题下面 spawn 时会报出来
}

const SCROLLBACK_LIMIT = 5000;

// 如果启动 CC-Monitor 这个 Node 进程本身就是在一个 Claude Code 会话里面（比如开发时
// 直接在 claude 里跑 `node server.js`——这本来就是个很正常的用法），process.env 就会
// 带着那个"外层"会话的 CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_CHILD_SESSION 等变量。
// 新建的终端会话如果原样继承这些变量，spawn 出来的 claude 会被当成那个外层会话的
// "子会话"，不会把自己当独立顶层会话对待——观察到的直接后果是它根本不写自己的
// transcript .jsonl 文件（Web UI 这边模型ID、token 用量这些依赖 transcript 的信息就永远
// 是空的，跟目录是不是 /tmp 没关系，纯粹是环境变量污染）。建终端前把这些变量摘掉，
// 让每个 Web UI 终端会话里跑起来的 claude 都是货真价实的独立顶层会话。
// 其它 agent 同理（Codex 的 CODEX_*、OpenCode 的 OPENCODE_*……），前缀列表来自注册表的
// env_strip_prefixes；Claude Code 这几个写死在这里兜底，注册表读不到也不影响老行为。
const CLAUDE_ENV_PREFIX = /^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$)/;
function cleanEnv() {
  const prefixes = [];
  for (const a of agentsRegistry.list()) {
    for (const p of a.envStripPrefixes || []) prefixes.push(p);
  }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (CLAUDE_ENV_PREFIX.test(k)) continue;
    if (prefixes.some((p) => (p.endsWith("_") ? k.startsWith(p) : k === p))) continue;
    env[k] = v;
  }
  return env;
}

// "新建会话"要自动敲的启动命令：按 agent id 查注册表的 launch_command；不认识的 id 或者
// 没写启动命令的 agent 退回 claude（老行为）。只允许安全字符，别的一律当 claude 处理——
// 这个字符串是要写进 PTY 的。
function launchCommandFor(agentId) {
  const spec = agentsRegistry.get(agentId || "claude-code");
  const cmd = spec && spec.launchCommand;
  return cmd && /^[A-Za-z0-9._-]+$/.test(cmd) ? cmd : "claude";
}

// Claude Code 的信任确认框是用逐词 "ESC[<N>G"（光标绝对定位）画出来的，不是普通空格，
// 所以原始数据流里 "Yes, I trust this folder" 根本不是连续子串。这里把 ANSI 转义序列
// 和空白都去掉再比较，"trustthisfolder" 在去空白之后必然是连续的。
function stripAnsiAndSpace(s) {
  return s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

class SessionManager {
  constructor() {
    this.sessions = new Map(); // id -> session record
  }

  create({ cwd, cols = 100, rows = 30, launchClaude = true, agent = "claude-code" } = {}) {
    const id = crypto.randomUUID();
    const shell = process.env.SHELL || "/bin/bash";
    const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

    const term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workDir,
      env: cleanEnv(),
    });

    const session = {
      id,
      cwd: workDir,
      createdAt: Date.now(),
      pty: term,
      clients: new Set(),
      scrollback: [],
      alive: true,
      exitCode: null,
      lastOutputAt: Date.now(),
    };

    // Claude Code 第一次在某个还没被信任过的目录里启动时，会弹一个"是否信任这个文件夹"
    // 的确认框，默认高亮的选项是 "No, exit"。这里没人替它确认的话，Claude Code 就会
    // 一直卡在这个框上；要是这之后又有任何键盘输入以回车结束（哪怕只是用户正常打字），
    // 就会直接选中 "No, exit" 把 Claude Code 退出、回到裸 shell——界面上看起来完全正常
    // （zsh 提示符能用），但其实 Claude Code 已经没了。既然这个终端本来就是从我们自己
    // "新建会话"这个入口开的，打开这个目录这件事用户已经等于确认过一遍了，这里检测到
    // 这个确认框就自动按下方向键+回车替它选 "Yes, I trust this folder"。
    let trustPromptHandled = false;
    let recentOutput = "";

    term.onData((data) => {
      session.lastOutputAt = Date.now();
      session.scrollback.push(data);
      if (session.scrollback.length > SCROLLBACK_LIMIT) session.scrollback.shift();
      this._broadcast(session, { type: "data", data });

      if (!trustPromptHandled) {
        recentOutput = (recentOutput + data).slice(-8000);
        if (stripAnsiAndSpace(recentOutput).includes("yes,itrustthisfolder")) {
          trustPromptHandled = true;
          setTimeout(() => {
            if (session.alive) term.write("\x1b[B");
            setTimeout(() => {
              if (session.alive) term.write("\r");
            }, 120);
          }, 150);
        }
      }
    });

    term.onExit(({ exitCode }) => {
      session.alive = false;
      session.exitCode = exitCode;
      this._broadcast(session, { type: "exit", exitCode });
    });

    this.sessions.set(id, session);

    // "新建窗口"（launchClaude:false）要的就是一个裸 shell，不自动敲 claude——
    // 跟"新建会话"共用同一套 PTY/信任确认框逻辑，唯一区别就这一行要不要执行。
    if (launchClaude) {
      // Launch the agent directly in this session's shell, like a user typing it.
      const cmd = launchCommandFor(agent);
      session.agent = agent || "claude-code";
      setTimeout(() => {
        if (session.alive) term.write(cmd + "\r");
      }, 150);
    }

    return session;
  }

  _broadcast(session, payload) {
    const msg = JSON.stringify(payload);
    for (const ws of session.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.createdAt,
      alive: s.alive,
      exitCode: s.exitCode,
      clientCount: s.clients.size,
      lastOutputAt: s.lastOutputAt,
    }));
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return;
    try {
      s.pty.write(data);
    } catch (e) {
      // pty 刚好在这一瞬间退出了；不用管，onExit 回调会把 alive 标记更新掉
    }
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.alive && cols > 0 && rows > 0) {
      try {
        s.pty.resize(cols, rows);
      } catch (e) {
        // pty already exited; ignore
      }
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      s.pty.kill();
    } catch (e) {
      // already dead
    }
    this.sessions.delete(id);
    return true;
  }
}

module.exports = { SessionManager };
