"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");

const SCROLLBACK_LIMIT = 5000;

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

  create({ cwd, cols = 100, rows = 30 } = {}) {
    const id = crypto.randomUUID();
    const shell = process.env.SHELL || "/bin/bash";
    const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

    const term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workDir,
      env: process.env,
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

    // Launch Claude Code directly in this session's shell, like a user typing it.
    setTimeout(() => {
      if (session.alive) term.write("claude\r");
    }, 150);

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
    }));
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.alive) s.pty.write(data);
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
