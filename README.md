# CC-Monitor

[English](./README.en.md) | 简体中文

还在为 AI 开发时不知道 AI Agent 在你的电脑上执行了哪些操作吗？试试这个工具吧，实时监测
Claude Code 在本机的文件读写、命令执行、网络访问等操作，对高危操作拦截/确认，全部操作
留痕审计，避免 AI 工具误操作破坏系统或泄露数据。技术方案见
[DESIGN.md](./DESIGN.md)（[English](./DESIGN.en.md)）。

## Web UI

`webui/` 是一个独立的 Node.js 服务，提供浏览器界面：

```bash
cd webui
npm install
node server.js          # 默认监听 http://127.0.0.1:9999，只绑定 localhost
```

- **首页**：概览统计——进行中的终端会话数、监测到的 Claude Code 会话总数、审计事件总数、拦截/疑似绕过次数、文件读/写/编辑/删除次数、日志类型与风险等级分布。"会话总数"/"审计事件总数"/"已拦截的高危操作"三张卡片可以点开看下钻详情（分别是会话列表、按事件类型+所属 session 的明细、被拦截操作的完整列表）。
- **Log 审计**：全宽的实时审计日志查看（按会话过滤，会话下拉框显示"文件夹 · 模型 · 短ID"而不是一串看不出区别的 ID），复用 CLI 那套人类可读的事件翻译逻辑。
- **终端会话**：直接在浏览器里开一个 Claude Code 终端对话（node-pty 起 PTY），不用再切到本地终端软件；用 `xterm.js` + WebGL 插件渲染，有 GPU 就用 GPU 加速，没有自动退化成 Canvas。侧边栏可以切换到**网格视图**（herdr 风格），同屏显示所有进行中的会话，点哪个面板就给哪个发键盘输入。
- **Claude Tap**：查看某个会话发给/收到模型的**完整对话内容**（不只是"调用了哪个工具"）——文本、思考、工具调用、工具结果、token 用量，按字段分色渲染。数据来源是 Claude Code 自己写在本地的 transcript JSONL 文件（hook payload 里的 `transcript_path`），不是抓包/MITM。CLI 等价命令：`CC-Monitor tap [--session ID] [-f]`。
- **状态信息**：账号级额度（单次 5 小时窗口 / 周额度 / 分模型周额度 + 重置时间，跟 [ccstatusline](https://github.com/sirmalloc/ccstatusline) 读同一份 Claude Code OAuth 凭证查询同一个 `api.anthropic.com/api/oauth/usage` 接口）+ 每个会话的模型、token 用量、吞吐速率（tok/s，由 transcript 估算）、cwd、git 分支、活跃时长、拦截情况。
- **中英文切换 + 多主题**：右上角语言按钮（中文/EN）和主题下拉（标准配色/深色/浅色/Dracula/Nord/Midnight/Ocean/Forest/Sunset/Rose，后 5 个移植自 [AI_Web_Search](https://github.com/cn0xroot/AI_Web_Search) 的配色方案），选择存 `localStorage`。翻译范围是界面文案（导航、按钮、标题、空状态提示、风险/操作/状态标签），不翻译数据本身（命令文本、工具输出、transcript 对话原文）。审计日志的风险/操作类型/状态徽章用固定的高饱和配色（不随主题变化），高危操作整行标红加粗。

因为这个 UI 还在快速迭代，静态资源都设了 `Cache-Control: no-store`——改完代码直接刷新页面就能看到最新效果，不用担心浏览器缓存旧版本。

只绑定 `127.0.0.1`，因为这是个能直接开终端 spawn 进程的工具，没做认证，不能暴露到公网/局域网。

## 截图

| 首页概览 | 会话列表下钻 |
|---|---|
| ![首页](./pic/home-zh.png) | ![会话列表](./pic/home-sessions-zh.png) |

| 事件类型明细 | 被拦截的高危操作 |
|---|---|
| ![事件类型明细](./pic/home-events-zh.png) | ![被拦截的高危操作](./pic/home-blocked-zh.png) |

| 审计日志 |
|---|
| ![审计日志](./pic/audit-log-zh.png) |

## 功能介绍

CC-Monitor 是双层监测架构：

- **应用层（Claude Code Hooks）**：注册 `PreToolUse`/`PostToolUse` hook，拿到每次工具调用的
  语义信息（工具名、命令、文件路径），按规则判定放行/拦截/需要确认。这是主力，成本低、覆盖面广。
- **系统层（eBPF 探针，Linux）**：`CC-Monitor-probe` 用 `bpftrace` 独立于 Claude Code 之外，直接在
  内核层跟踪 `claude` 进程派生出的整棵子孙进程树的 `execve`/`connect`，交叉验证应用层 hooks
  有没有被绕过或篡改——这是第二道防线，即使 hooks 配置被破坏也能兜底发现异常。

具体能力：

| 能力 | 说明 |
|---|---|
| 高危操作拦截 | 命中规则的 `Bash`/`Write`/`Edit` 等操作可以直接拒绝（如 `rm -rf /`、写 `~/.ssh/`） |
| 人工确认 | 中风险操作在终端弹出确认提示 + 桌面通知，超时/无 tty 默认拒绝 |
| 审计日志 | 所有事件落盘 SQLite，`tool_input`/`tool_response` 全量留存 |
| 人类可读实时日志 | `CC-Monitor tail` 把原始 JSON 翻译成"事件类型 + 摘要 + 结果"，终端自动彩色高亮，Bash 命令按语法（命令名/参数/字符串/变量/管道）着色 |
| 绕过检测 | `CC-Monitor verify` 比对系统层探针观测到的命令和 hook 记录，标出"探针看到了、但 hook 没记录"的可疑命令 |
| 网络层可视化 | eBPF 直接抓 `connect()` 目标 IP:port，不解密 TLS、不用装 CA 证书 |

## 实现原理

功能介绍是"能做什么"，这里是"怎么做到的"，每条机制都能在源码里直接对上号（完整版见 [DESIGN.md](./DESIGN.md)）：

- **Hook 拦截**：Claude Code 每次调用工具前后，会把一份 JSON payload 通过 stdin 传给
  `settings.json` 里配置的 hook 命令，同步等它退出。`CC-Monitor-hook` 退出码是 2 就代表拒绝——
  stderr 里的原因会被 Claude Code 展示出来。它是每次调用都拉起的一次性子进程，不是常驻服务，
  所以也没有"进程挂了监控就失效"这种问题（但也意味着改完规则不用重启任何东西，下一次调用直接生效）。
- **规则引擎**：`default_rules.json` 是一份有序规则表，`policy.evaluate()` 按顺序逐条尝试，
  第一条命中就生效（first-match-wins），所以更具体的规则要写在更通用的规则前面。每条规则声明
  `tools`（适用哪些工具）、`field`（从 `tool_input` 里取哪个字段，比如 `command`/`file_path`/`url`）、
  `pattern`（正则）、`risk`/`action`。规则文件首次使用时从 `default_rules.json` 拷贝到
  `~/.cc-monitor/rules.json`，之后可以自己改。
- **系统层 eBPF 探针**：`probe_linux.bt` 挂在内核的 `execve`/`connect` 等 tracepoint 上，先用
  `comm=="claude"` 认出 Claude Code 自己的进程，再监听 `sched_process_fork` 事件，把"正在被监控"
  这个标记沿着进程树一路传给它 fork 出来的所有子孙进程——不管子进程改名叫什么都跟得上。
  `CC-Monitor verify` 拿探针观测到的命令去匹配同一时间窗口内 hook 记录的命令文本（做了引号归一化，
  兼容 zsh 快照包装命令时对引号的转义），标出"探针看到了、hook 却没记录"的可疑差异。
- **Claude Tap**：hook 的 JSON payload 里有个 `transcript_path` 字段，指向 Claude Code 自己写在本地
  的对话 transcript JSONL 文件。直接读这个文件、解析里面的 `user`/`assistant`/`tool_use`/`tool_result`
  等条目就能还原完整对话——不抓包、不用装 CA 证书、不需要中间人代理。
- **账号额度显示**：读 `~/.claude/.credentials.json` 里 Claude Code 自己保存的 OAuth token，
  拿它去调 Anthropic 官方的 `api.anthropic.com/api/oauth/usage` 接口（带上
  `anthropic-beta: oauth-2025-04-20` 请求头）——跟 [ccstatusline](https://github.com/sirmalloc/ccstatusline)
  读的是同一份凭证、查的是同一个接口，不是我们自己另外维护了一套用量统计。
- **Web 终端**：用 `node-pty` 起一个真正的伪终端（PTY），跟你在本地开一个终端窗口没有本质区别；
  创建之后自动往这个 PTY 里"敲"`claude\r`帮你启动。Claude Code 第一次打开一个没信任过的目录时会弹
  一个"是否信任这个文件夹"的确认框，默认高亮选项是"No, exit"——这里检测到这段提示文本后会自动按
  方向键+回车替你选"Yes, I trust this folder"，不然这个确认框没人处理的话，后续任何一次正常的回车
  操作都会把 Claude Code 意外退出，界面上却看起来"终端明明是好的"。
- **数据持久化/归档**：首页"持久化归档"用的是 SQLite 官方的 `backup()` API 给当前 `events.db`
  做一次完整快照（不是简单复制文件——`backup()` 会正确处理 WAL 模式下还没落盘的数据），存到
  `~/.cc-monitor/archives/` 下；"清空当前数据"则是对同一个库执行 `DELETE` 并重置自增 ID。

## 安装

依赖：Python 3（标准库即可，无第三方包依赖）。系统层探针额外依赖 Linux 的 `bpftrace`。

有两种装法，效果一样，选一种就行：

### 方式一：直接在当前目录用（不动系统路径）

```bash
# 1. 把整个 CC-Monitor 目录放到你想要的位置（这里假设已经在 ~/Tools/CC-Monitor）
cd ~/Tools/CC-Monitor

# 2. 安装 hooks 到 Claude Code 配置（会自动 chmod +x bin/ 下的脚本）
python3 install.py                       # 全局安装：写入 ~/.claude/settings.json
python3 install.py --project /path/to/proj   # 只对某个项目生效
python3 install.py --target /path/to/settings.json  # 显式指定 settings.json（跨用户安装时用）

# 3.（可选）如果要用系统层探针，装 bpftrace
sudo apt install bpftrace        # Debian/Ubuntu
# 其它发行版参考 bpftrace 官方文档；macOS 暂不支持系统层探针
```

安装脚本按 `command` 字段去重合并写入 `PreToolUse`/`PostToolUse` hook 数组，**不会覆盖**你已有
的其它 hooks 配置；遇到损坏的 `settings.json` 会自动备份成 `.json.bak` 再重建。安装后**重启
Claude Code** 新开的会话才会读到新配置。

### 方式二：`make install` 装到系统路径

想要有个全局命令、不用记着这份代码放在哪个目录，可以装到系统里：

```bash
sudo make install                    # 默认装到 /usr/local/lib/cc-monitor + /usr/local/bin
sudo make install PREFIX=/opt/cc-monitor   # 或者自定义前缀

# 装完之后，任意目录都能直接用命令，再照方式一的第 2 步注册 hooks（用装完之后打印出来的路径）：
CC-Monitor tail -v
python3 /usr/local/lib/cc-monitor/install.py
```

`make install` 只负责"把代码放到系统里、建好命令行链接"，**不会**自动改你的
`~/.claude/settings.json`——注册 hooks 这一步需要自己手动跑一遍 `install.py`（命令行结尾会
打印出装好之后的准确路径）。卸载用 `sudo make uninstall`（同样只删代码和命令链接，`settings.json`
里的 hooks 条目需要自己手动删）。

## 编译方式

CC-Monitor 是纯 Python 实现（标准库 `sqlite3`/`json`/`argparse`/`re` 等，无第三方依赖），**不需要编译**：

- `bin/CC-Monitor`、`bin/CC-Monitor-hook`、`bin/CC-Monitor-probe` 都是带 `#!/usr/bin/env python3` shebang 的可执行脚本，`install.py` 会自动给它们加执行权限。
- 系统层探针依赖的 `bpftrace` 是系统包管理器直接安装的现成二进制，不需要自己编译；`cc_monitor/probe_linux.bt` 是 bpftrace 脚本，运行时由 `bpftrace` 解释执行，同样不需要编译。
- `Makefile` 里的 `make install` 不是编译，只是把文件拷到 `PREFIX` 下再建命令行链接，见上面"安装"一节。
- 目前**没有**打包成单文件可执行程序（比如用 PyInstaller/Nuitka），这属于待办事项，见下方"开发进展"。

## 使用方式

```bash
# 实时查看监测到的事件（Ctrl+C 退出）
./bin/CC-Monitor tail
./bin/CC-Monitor tail -v          # 额外打印原始 JSON

# 查看当前生效的规则
./bin/CC-Monitor rules

# 查看统计（按风险等级/决策结果计数）
./bin/CC-Monitor stats

# 系统层探针（需要 root，用于交叉验证 hooks 有没有被绕过）
sudo ./bin/CC-Monitor-probe

# 查看探针标记的"可能绕过监测"的记录
./bin/CC-Monitor verify
```

**环境变量**：

| 变量 | 作用 |
|---|---|
| `CC_MONITOR_HOME` | 覆盖事件库/规则文件目录（默认 `~/.cc-monitor/`） |
| `CC_MONITOR_COLOR` | `always`/`never` 强制开关终端配色（默认按是否为真终端自动判断） |
| `NO_COLOR` | 设置后强制关闭配色（通用约定） |

事件与规则存放在 `~/.cc-monitor/`：`events.db`（SQLite 审计日志）、`rules.json`（可编辑规则，改了
立即生效不用重启）。

**规则格式**（`rules.json` 是规则数组）：

```json
{
  "id": "规则名",
  "risk": "high | medium | low",
  "action": "block | confirm | log",
  "tools": ["Bash"],
  "field": "command | file_path | url",
  "pattern": "正则表达式"
}
```

- `block`：直接拦截，Claude Code 收到拒绝原因。
- `confirm`：终端弹出确认提示（等待 tty 输入 `y` 才放行）+ 桌面通知，无 tty/超时默认拒绝。
- `log`：放行但记录审计日志。

默认规则见 [cc_monitor/default_rules.json](./cc_monitor/default_rules.json)，涵盖：危险删除、磁盘覆写
命令、`curl|bash`、递归 777、`sudo`、`git push --force`、读写 SSH 密钥/凭据文件、写系统目录等。

## 功能开发进展

每个版本具体实现了什么功能，见 [CHANGELOG.md](./CHANGELOG.md)（[English](./CHANGELOG.en.md)）。

### 已实现

- [x] 应用层 Hook 拦截器（`PreToolUse`/`PostToolUse`），覆盖 Bash/Write/Edit/Read/WebFetch 等全部工具
- [x] 策略引擎：正则规则匹配 + 三种动作（block/confirm/log）+ 三级风险分类
- [x] SQLite 审计日志（`events.db`），事件对 hook 输入/输出全量留存
- [x] CLI：`CC-Monitor tail`（实时查看）/`rules`（查看规则）/`stats`（统计）/`verify`（绕过检测）
- [x] 人类可读事件格式化：把原始 JSON 翻译成"事件类型 + 摘要 + 结果"
- [x] 终端彩色输出：风险等级/决策结果/规则名独立配色，支持 `NO_COLOR`/`CC_MONITOR_COLOR`
- [x] Bash 命令语法高亮（命令名/参数/字符串/变量/管道重定向分色）
- [x] 终端确认（`/dev/tty` 交互）+ 桌面通知（`notify-send`/`osascript`）
- [x] 安装脚本：安全合并 hooks 到 `settings.json`（全局/项目/自定义路径三种模式），不覆盖已有配置
- [x] 系统层探针（`CC-Monitor-probe`，仅 Linux）：eBPF 跟踪 Claude Code 进程树的 `execve`/`connect`
- [x] 绕过检测：探针观测到的命令与 hook 记录模糊比对（进程树 + 时间窗口 + 去引号子串匹配），标记 `hook_bypass_suspected`
- [x] 网络层可视化：eBPF 直接抓 `connect()` 目标 IP:port + 反向 DNS，不用 MITM 代理

### 未实现 / 待办

- [ ] **macOS 支持**：设计文档里规划的 Endpoint Security Framework 方案完全未实现（需要签名的
      系统扩展 + 用户手动授权 Full Disk Access），目前 CC-Monitor 只在 Linux 上验证过
- [ ] **强制沙箱**（Phase 3）：Landlock LSM / bubblewrap（Linux）、`sandbox-exec`/容器化（macOS），
      目前只能拦截+告警，不能把 Claude Code 关进一个真正强制隔离的沙箱里
- [ ] **`CC-Monitor-probe` 常驻化**：目前需要手动 `sudo` 启动，没有 systemd unit / 开机自启，需要用户自己决定要不要装成常驻服务
- [ ] **审计日志防篡改**：日志和被监测进程同一用户权限，理论上可被同用户进程删除/篡改；异地转发、只追加权限（`chattr +a`）等加固手段还没做
- [ ] **多机日志集中上报 / 规则库社区化**（Phase 3）：目前是纯本地单机工具
- [ ] **高危操作的图形化确认弹窗**：目前只有终端 tty 文本确认，没有可点击的 GUI 允许/拒绝对话框
- [ ] **规则语义化判断**：目前纯正则匹配，没有轻量模型辅助判断命令意图（比如识别用自然语言描述的等价危险操作）
- [ ] **打包为单文件可执行程序**：目前依赖系统 Python 环境直接跑，没有用 PyInstaller/Nuitka 之类打包

## 已知限制

- `confirm` 依赖 `/dev/tty`，无交互终端（CI/无头环境）时直接拒绝。
- 探针的绕过检测是模糊匹配，不是精确语义分析；系统负载高、探针处理有延迟时，`CC-Monitor verify`
  可能需要稍等片刻才能看到最新结果。
- 网络层只看 IP:port，看不到真实域名（靠反向 DNS 尽力还原，不一定准）。

## Contributors

- [cn0xroot](https://github.com/cn0xroot)
