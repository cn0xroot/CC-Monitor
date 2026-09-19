# 更新日志

[English](./CHANGELOG.en.md) | 简体中文

本文件记录 CC-Monitor 每个版本实现了什么功能。格式大致参考
[Keep a Changelog](https://keepachangelog.com/)，但不强制严格照搬其分类。

## [未发布]

### 新增
- **多 agent 支持（dev 分支）**：检测面从"只有 Claude Code"扩到 Codex CLI、Gemini CLI、
  Cursor、OpenCode、ZCode（应用层 hook / 插件 + 系统层探针）和 Aider（仅系统层）。
  - ZCode（Z.ai 的 agentic 开发环境，GLM 模型）：hook 协议与 Claude Code 同构，适配器复用 Claude
    协议，只处理 `Agent`→`Task` 别名和 `PostToolUseFailure`；配置写 `~/.zcode/cli/config.json` 的
    `hooks.events`（`type: process`）并置 `hooks.enabled=true`，保留别的插件 hook；桌面版内置
    Node 运行时按 argv（`/resources/glm/`）认，`zcode` CLI 按 comm 认。
  - 新增 Agent 注册表 `cc_monitor/agents/<id>.json` + `cc_monitor/registry.py`：每家 agent 的
    进程特征（comm / 可执行文件名 / argv 正则）、hook 协议与配置路径、工具名和入参字段映射、
    会话目录、家目录忽略路径、项目根标记、配置篡改路径全部数据化；代码里不再写死任何一家的
    名字。用户可在 `~/.cc-monitor/agents/` 放同名文件按字段覆盖。
  - 新增 hook 适配器 `cc_monitor/adapters/{claude,codex,gemini,cursor,opencode}.py`：`hook.py`
    重构成"适配器解析 stdin → 判定/审批/记录（agent 无关）→ 适配器输出"。其它 agent 的工具名
    进引擎前翻译成 Claude Code 词汇（`run_shell_command`→`Bash`、`filePath`→`file_path`……），
    87 条规则、越界检测、审批台一份代码服务所有 agent；原名存在 `events.native_tool`。Codex 的
    `apply_patch` 拆成逐文件的 Write/Edit 判定，任一文件命中拦截整个调用就拦。Cursor 的
    `afterFileEdit` 事后事件也跑规则，结果记成 observed。各家的拒绝格式：Codex 走
    `permissionDecision=deny`、Gemini 走 `{"decision":"deny"}`、Cursor 走 `{"permission":"deny"}`、
    OpenCode 插件看退出码 2。
  - `install.py --agent <id>|all`、`--list`：按注册表写各家配置（`~/.codex/hooks.json`、
    `~/.gemini/settings.json` hooks 块、`~/.cursor/hooks.json`、OpenCode 插件文件），幂等、不动
    用户已有条目；不带参数的行为与以前逐字节一致（已对真实 settings.json 做 no-op 验证）。
  - 系统层探针改成模板 `probe_linux.bt.tmpl` 由 `probe.py` 渲染：所有编译型 agent 的 comm 名进
    `sched_process_exec` 探点；新增 `cc_monitor/procscan.py` 扫 `/proc`，启动时把已在运行的
    agent 进程树播种进 `@watch`/`@root`（顺带修掉"探针启动前已在跑的 Claude Code 看不到"），
    运行中发现 node/python 托管的新根（Gemini CLI、Aider）就重启 bpftrace 纳入。事件带
    `root_pid` 和 `agent`，绕过交叉验证只比对同一家 agent 的 hook 记录。macOS `nettop` 探针同样
    按注册表认进程树。
  - 新规则 `agent_config_tamper`（改 Codex / Gemini / Cursor / OpenCode 的 hooks.json、
    settings.json、AGENTS.md、插件目录要确认），pattern 写 `@registry:config_tamper` 加载时从
    注册表展开；`history_read` 系列同样覆盖其它 agent 的会话目录；`kill_monitoring_process`
    加上 OpenCode 插件文件名。规则总数 86 → 87。
  - 存储：`events` 加 `agent`/`native_tool` 列，`pending_approvals` 加 `agent` 列，老行默认
    `claude-code`，幂等 `ALTER TABLE` 升级。`CC-Monitor agents` 子命令、`stats` 按 agent 计数。
  - Web UI：`/api/agents`；`/api/logs`、`/api/log-sessions` 支持 `?agent=`；顶栏 agent 过滤器；
    首页"被监测的 AI agent"卡；审计日志/会话下拉/审批卡/进程下钻带 agent 徽标；"新建会话"可选
    启动哪个 agent（按注册表 `launch_command`，环境变量剥离前缀也按注册表）；进程扫描认所有
    agent。只有 Claude Code 一家时以上全部隐藏，界面与以前一致。
  - 新测试 `tests/test_agents.py`（注册表、适配器解析/输出、各家 hook 端到端、installer 幂等、
    探针渲染与嵌套 agent 归属），`test_platform_caps.py` 改为检查渲染后的脚本并在有 bpftrace 时
    真的 `-d` dry-run 一遍。
  - 技术方案 `DESIGN-multi-agent.md`（含对 agentsight 的分析与借鉴清单）。
- **系统层事件归到会话**：新增 `sessions` 表——hook 进程沿 `/proc` 父进程链找到 agent 根进程
  （Claude Code：hook ← sh ← claude），把 `(agent, session_id) → (root_pid, root_start, cwd)` 登记
  进去；探针按根 pid 反查，`os_exec` / `os_net` / `os_file` / `os_listen` 都带上 `session_id`，
  Web UI 按会话过滤能看到内核层观测，会话生死改按"根 pid（+启动时刻）在不在"判断而不是按 cwd 猜。
  `CC-Monitor run --` 登记的会话同样进这张表。
- **Claude Tap 更名为 AI Tap**：导航、页面标题、CLI 帮助、README/官网文案全部改名，提示文案改为"读各家 agent 的会话文件"。
- **Claude Tap 认多种会话格式**：`describe_entry`（Python 与 JS 两份同步）按行形状自动识别 Claude Code /
  Antigravity CLI（真机 agy 1.2.6 的 `step_index/source/type` 格式，`<USER_REQUEST>` 剥壳、工具入参拆掉
  多套的一层 JSON 引号）/ Codex `rollout-*.jsonl`（按公开资料）；Tap 页助手消息按 agent 显示名；
  `/api/transcript` 带 `agent`；`staleSessions.js` 按注册表 `sessions.glob` 扫所有 agent 的会话文件。
- **会话根进程反推**：探针启动时，已在跑的 agent 根进程若还没有会话指向它，按 agent+cwd+6 小时内活跃
  反推一个（`sessions.evidence = cwd_recent`），hook 事件到来后用精确证据覆盖。
- **首页"系统层文件 / 端口观测"卡**：探针的 `os_file` / `os_listen` 按写入/删除/重命名/建目录/监听（本机/对外）/
  疑似绕过分类，带下钻明细；修一家 agent 时"被监测的 AI agent"卡没隐藏（`.strip-card` 的 `display:flex`
  压过 `[hidden]`）。
- **探针噪音与索引**：agent 自己的基础设施命令（hook 调用本身、状态栏的 `ps`/`stty`/`jj root`/
  `git rev-parse`）整条不落库，真机库里 68% 的 `os_exec` 是这些；`events` / `pending_approvals`
  加索引（以前一个都没有）。
- **Antigravity CLI（`agy`）与 Grok CLI 接入（实验性）**：Antigravity 的 hooks.json 按 hook 名分组、
  stdin 是 `toolCall {name, args}` 加 PascalCase 入参、输出 `{"decision": "deny"}`——本机 1.2.6 做过
  一轮端到端（拦截 / 审批台放行 / 探针归属与交叉验证）；Grok CLI 按其 `src/hooks/` 源码实现（退出码 2
  阻断），未运行过。所有非 Claude Code 的 agent 在注册表里标 `status: experimental`，`install.py --list`、
  `CC-Monitor agents`、install 输出和 Web UI 徽标（β 角标）都会标明"实验性、未真机验证"。
- **OpenClacky 接入（实验性）**：读 `~/.clacky/hooks.yml`（只认用户级，没有项目级），同一个事件能挂多条
  hook，而且两个事件的协议不一样：`before_tool_use` 走 rewrite 协议（`type: rewrite`），payload 是 Claude
  Code PreToolUse 的形状、退出码 2 阻断且理由 stderr 优先于 stdout；`after_tool_use` 只能用 simple 协议，
  payload 是 `{event, tool: {name, arguments}, result}`、`arguments` 是 JSON 字符串。适配器按
  `hook_event_name` / `event` 自动分辨这两种形状。工具名是小写（`terminal` / `write` / `file_reader`…），
  进规则引擎前过注册表映射，路径字段 `path` → `file_path`；terminal 的交互式输入（`session_id` + `input`，
  也就是往已经开着的 shell 里写“下半条命令行”）也当 command 送规则，否则 `rm -rf /` 从这条路进来是盲区。
  install.py 写 `~/.clacky/hooks.yml` 时用一对注释标记圈出自己那段（幂等、可整段删除），文件里已有同名键
  就一个字都不动、只打印待粘贴的片段。本机用 gem 自带的 `ShellHookLoader` 加载生成的配置做过一轮端到端
  （拦截 / 工具名与字段映射 / 交互输入均通过），未在真实会话里跑过。

- **嵌套 agent 归属改为"内层是自己的根"**：在 Claude Code 终端里启动 agy，agy 及其子进程的系统层
  事件归 antigravity-cli 而不是 claude-code——它的 hook 事件按自己的 `--agent` 记，交叉验证才对得上
  （旧口径下真机实测每条命令都被误报为绕过）。注册表新增 `process.file_ignore_globs`（agy 的
  `~/.local/bin/.update_test*`）；`state_dirs` 支持 `*` 前缀匹配（`.claude.json*` 盖住 Claude Code 写
  配置时的临时文件，不再误报绕过）。
- **探针文件级观测与监听端口**（借 agentsight `process_ext` 探点集）：写打开（`openat` 带写标志）、
  删除（`unlinkat`/`unlink`/`rmdir`）、重命名、建目录 → `os_file`；`bind`+`listen` → `os_listen`
  （`0.0.0.0`/`::` 标 `listen_exposed`）。unlink/rename/mkdir 用 enter→exit 配对只报成功的。
  相对路径解析：`sys_exit_openat` 时从任务 fd 表取 `struct file` 判 inode 是目录就报 `OPENDIR`，
  加 `DUP`/`FCHDIR`/`CHDIR`/`FORK`，用户态维护 (pid, fd)→目录 和 pid→cwd 两张表，`rm -rf`、
  `mkdir -p`、`shutil.rmtree` 的每级路径实测正确（agentsight 没做这一步）。噪音控制：内核丢
  `/proc` `/sys` `/dev`，用户态排除 `.git`/`node_modules`/缓存/agent 状态目录，60 秒窗口聚合，
  每根进程每秒 200 条熔断。文件路径类规则对内核层写入同样生效（子进程写 `~/.ssh` 也命中
  `sensitive_file_write`）；agent 进程自己直接写文件而 hook 层无对应 Write/Edit 记录 →
  `hook_bypass_suspected`。CLI/Web UI 新增两种 source 的展示与配色。
- **`CC-Monitor run [--agent <id>] -- <命令>`**：显式把一个进程绑定成某家 agent 的根（登记到
  `~/.cc-monitor/run/<pid>.json`，探针 3 秒内纳入，退出自动清理），设 `CC_MONITOR_AGENT` /
  `CC_MONITOR_SESSION` 后 exec；hook 命令行没写 `--agent` 时从环境变量取 agent。给无 hook 的
  自研 agent 用。新增 `tests/test_probe_files.py`（16 个用例）。

### 修复
- **OpenClacky 注册表正则多转义**（PR #3 合入时修）：`config_tamper_paths` / `history_paths` 写成 `\\\\.clacky`，解码后
  是"反斜杠 + 任意字符"，`agent_config_tamper` 对 `~/.clacky/hooks.yml` 不生效。改为单层转义，并加了一条对所有
  agent 的注册表正则做编译与转义检查的测试。
- **选了其它 agent 仍显示 Anthropic 账号与额度**：过滤器选中非 Claude Code 的 agent 时，"账号 & 额度"整块换成那家的
  "账号 & 环境"面板（新接口 `/api/agent-account`：接入状态、可执行文件与版本、hook 配置文件与是否已接、登录账号 /
  认证方式 / 凭证类型或 API Key 末四位、配置的模型、已监测会话数、最近活动、用过的模型；凭证本身不读），额度卡和状态页
  额度板显示"该 agent 无额度接口"，"隐藏敏感信息"同样对账号行生效。各家线索按其公开文件布局取（Antigravity /
  Gemini 的 `google_accounts.json`、Codex 的 `auth.json`、Grok 的 `user-settings.json`、OpenCode 的 `auth.json`、
  ZCode 的 `provider_config.json`），文件不存在那一项就不显示。Antigravity CLI 的登录账号读它自己的
  `~/.gemini/antigravity-cli/antigravity-oauth-token`（`id_token` 里的 email），不是 Gemini CLI 的 `google_accounts.json`——
  两家可以登不同的 Google 账号，真机上就是不同的；另加认证方式、令牌到期、配置的模型、已信任工作区数、安装 ID。
- **Antigravity 会话被判"已结束"、心跳不跳、模型为空**：agy 每跑一个工具 / hook 会 fork 一个几秒就退出的同名 agy
  子进程，hook 沿父链找到的"最近的 agent 进程"是这个短命子进程，会话登记到它上面，它一退出会话就被判死。现在
  hook 父链、`/proc` 扫描和内核探针三处口径一致：同一家 agent 的同名子进程不是根，归最外层那个同类祖先（Claude
  Code 的子代理 claude 进程同理）；别家嵌套（claude 里跑 agy）仍各是各的根。Antigravity 的 transcript 不带模型名，
  hook stdin 的 `modelName` 现在记进 `sessions.model`，Web UI 各处的模型列在 transcript 里找不到时用它。
- **其它 agent 的进程心跳不跳**：进程列表以前只按 cwd 把进程和审计会话对上，别家 agent 的 hook cwd 常常不是进程
  的启动目录（Antigravity 报工作区根），对不上就没有"最近活动"时间、心跳永远灰直线。现在优先用 `sessions` 表里
  hook 登记的根进程 pid 精确对上，对不上再退回 cwd。Antigravity 适配器不再把 `run_command` 的 `Cwd` 当事件 cwd。
- **切换 agent 过滤器后首页统计、下钻、审批台、状态页仍显示全量（Claude Code）数据**：以前只有 Log 审计和会话下拉
  认 `?agent=`。现在数据层统一处理：`lib/agentScope.js` 用 AsyncLocalStorage 把请求的 agent 带进所有查询，
  `FROM events` / `FROM pending_approvals` 自动改写成只含该 agent 的同名子查询，几十条 SQL 一条不改；
  `GROUP BY agent` 的汇总（/api/agents）不改写。前端切换过滤器时立刻重拉首页 / 状态页 / 审批台 / Tap 合并视图。
- **会话列表里的模型在中途 `/model` 切换后不更新**：`getModel()` 以前取 transcript 里第一次出现的 assistant
  模型，现在从文件尾部往前取最近一次的（尾部 500KB 没有 assistant 行再退回从头扫），缓存仍按 mtime 失效。

### 变更
- **账号面板新增标识符与本机环境信息**：从 9 行增到 17 行。新增账号 UUID / 组织 UUID /
  用户 ID / 机器 ID 四个标识符（截断成"头 8…尾 4"，完整值在悬停提示里，默认显示、跟着
  "隐藏敏感信息"一起打码，打码范围从 3 项扩到 7 项），以及 Claude Code 版本 / 安装方式 /
  自动更新 / 已配置 MCP 数四项本机环境信息（一律明文，它们不是身份信息，而且正是排查
  hook 失灵时要看的东西）。版本取 `claude --version` 的输出并进程内缓存，拿不到时两级
  兜底并标注"近似"，不假装是准确值。打码时连悬停提示一起遮——否则正文是星号但鼠标一放
  就看到原值。
- **日志类型分布六项各一色**：原来六行全是同一个 `var(--accent)`，颜色不承载任何信息。
  取马卡龙的色相家族但深度是算出来的——纯浅色调实测亮度超界、彩度发灰、对比度只有
  1.3~2.2:1，过不了可读性检查。浅色/深色各一套取值，五项检查全过，相邻对最差 ΔE 分别是
  11.4 和 12.5（目标线 8）。渲染顺序固定成 `SOURCE_ORDER`，让验证过的相邻关系成为不变量；
  颜色按 source 键绑定而非按名次。
- **沙漏重做**：14×24 放大到 30×46，加上下托板、沙子渐变、中间高的沙堆、正在漏的那道
  细沙（只在真的还在漏时才画，并跟随 `prefers-reduced-motion`），颜色跟随所在卡片而不再
  固定用强调色。Claude Code 星芒 16→24px，品牌 logo 24→30px。

### 修复
- **macOS 额度查询 401**：钥匙串里同一个 service 可能有多条记录。用 `sudo` 跑过一次
  Claude Code（macOS 的 sudo 默认不重置 `HOME`），root 会把凭证写进*你的*登录钥匙串，
  多出一条 `acct=root` 的 `Claude Code-credentials`；而 `security find-generic-password -s`
  不带 `-a` 返回的正是这条，它没人刷新，8 小时后过期，于是额度查询一直 401。改成先按
  当前用户名（`-a`）查、再退回不带 `-a`，所有来源解析后优先挑未过期的，全过期时返回过期
  最晚的那份交给调用方判断（套餐类型这类字段过期了照样能用）。
- **macOS 会话心跳全灰**：`tryReadCwd()` 只读 Linux 的 `/proc/<pid>/cwd`，macOS 上每个
  claude 进程的 cwd 都是 null，于是"活着的进程 cwd 集合"为空、每个会话都被判成 dead、
  生命体征一律画成灰色直线，刚刚还在干活的会话也一样。macOS 改用一次
  `lsof -a -p <pid,…> -d cwd -Fpn` 批量取，解析机器可读输出而不是给人看的对齐表格。
- **额度错误提示区分"没有凭证"和"凭证已过期"**：过期在本地就拦下来，给出"去 Claude Code
  里跑一次命令让它自动刷新，或执行 `/login`"的具体提示，不再拿过期 token 去请求然后回报
  一句笼统的"usage API 返回 401"。

  Linux 侧已实测无回归：`lsof` 一次都不会被调用（strace 确认只 execve 了 `node` 和 `ps`），
  `/proc` 分支原封不动（4/4 进程取到 cwd，会话 active 判定照常工作），两处改了签名的函数
  都只有一个调用点且已同步。唯一的行为变化是过期检查在 Linux 上同样生效，且判断没有容差，
  时钟偏差或 `expiresAt` 字段不准时会直接报过期而不再尝试。
- **分布数据条一直没有颜色**：`.fill` 是 span，默认 `display:inline`，而行内非替换元素的
  width/height 根本不生效，实际宽高一直是 0，背景色设了也画不出来。旁边的圆点同样是 span
  却正常，是因为它是 flex 容器的直接子项被 blockify 了。
- **两处卡片布局空洞**，取舍方向相反：文件操作那一行两 box 等宽、内容量相近，安装统计
  加到 7 项后换行把行高拉高，只有一行的那个底部空出约 124px，改成不强行等高 + 宽屏按
  内容量分宽；账号列和额度列宽度差很多，各按内容收会断成台阶，改成等高并让两列各自吃掉
  余量（额度列最后一块是 table，靠 `height:100%` 让行按比例撑开来吸收）。
- **账号列标签折行**：标签列 96px 装不下"Claude Code 版本"（实测需 117px）和英文的
  "Subscription started"，放宽到 122px，只改这一处。
- **软件安装识别按生态补齐，规则数 74 → 86**：原来的安装类规则是按具体可执行文件名
  枚举的，只认 pip / npm / apt 系 / gem / cargo / go / composer。拿 96 条真实安装命令跑了一遍
  规则引擎，覆盖率只有 22%——工具链和容器插件两类是 0%。补法不是继续堆枚举，而是按生态
  合并成 8 条规则：`js_package_install` / `js_package_install_global`（yarn/pnpm/bun/deno/npm ci）、
  `python_package_install_other`（conda/mamba/poetry/pipenv/pipx/pdm/rye）、`python_legacy_install`
  （easy_install、setup.py install）、`toolchain_install`（asdf/nvm/pyenv/rustup/mise/sdk/volta…）、
  `container_image_pull`（docker/podman pull、helm install）、`editor_plugin_install`
  （VS Code 扩展、gh extension、krew、`claude mcp add`）、`source_build_install`
  （make install、cmake --install、ninja install）。另外扩充了两条已有规则的正则：
  `system_package_install` 纳入 snap/flatpak/dpkg -i/rpm -i/emerge/nix/xbps/pkg/mas/eopkg，
  `package_install_other` 纳入 dotnet/cabal/stack/cpanm/luarocks/nimble/mix/dart/flutter/swift/R/julia
  及 go get、cargo binstall、bundle install、composer install。覆盖率 22% → 92%。
  风险分档沿用原有逻辑：写系统的要确认，写用户目录/项目目录的只记录。
- **uv 安装识别**：新增 `uv_pip_install`、`uv_pip_install_system`、`uv_project_install`、
  `sudo_uv_pip_install` 四条规则。此前 `uv pip install` 完全不命中任何规则——安装类规则都是
  `match: "segment"`（从子命令开头匹配），而 `uv pip install` 的开头是 `uv` 不是 `pip`，
  于是 `pip install requests` 会弹确认框、`uv pip install requests` 却一路畅通。
  分档按 uv 自己的语义定：它在没有激活虚拟环境时直接报错而不是装进系统 Python，所以普通
  `uv pip install` 是 low/log，只有 `--system` / `--break-system-packages` 才是 high/confirm，
  `sudo uv pip install` 跟 `sudo pip install` 一样 high/block。
- **首页软件安装统计从 5 张卡扩到 7 张**：新增"uv 安装 Python 包""其它 Python 包管理器"
  "工具链 / 版本管理器"，原"npm 安装"改为"JS 包管理器（npm/yarn/pnpm/bun）"。后端的
  `INSTALL_RULE_GROUPS` 现在是唯一事实来源，接口白名单和前端卡片渲染都从它推导，
  以后加一组不用再改三个地方。

### 修复
- **`env_dump` 规则的误判**：正则是全文搜索 `\b(env|printenv)\b`，于是任何把 `env` 当独立
  词用的命令都会被记成"打印全部环境变量（可能含密钥）"。实测误伤 `hatch env create`、
  `conda env list`、`poetry env info`、`nix-env -iA`、`mkdir env`。其中 `nix-env -i` 本来该算
  系统包安装，被这条规则抢先命中之后连分类都错了。改成只在命令开头、shell 操作符之后
  或 `$()` 里才算，语义正是"单独执行 env"。顺带把 `$(env)` 这种此前也匹配不到的写法补上。
  用 49 条正常命令（`make build`、`yarn test`、`docker run`、`conda activate`、`pip list` 等）
  回归，零误报。
- **"隐藏敏感信息"按钮收窄到三项**：原来把账号面板九个字段全部显示成 `***`，遮完之后
  整块面板只剩一列星号，失去了展示价值。现在只遮能指认到具体某个人的三项：姓名、
  邮箱、组织名；组织角色、套餐类型、额度档位、计费方式、账号创建时间、订阅开始时间
  属于账号属性而不是身份，照常显示。实现上把原来统一的 `v()` 拆成 `mask()` 和
  `plain()` 两个函数，九个字段各自明确走哪一个，比条件判断更不容易在以后加字段时
  搞错。打码值仍是定长 `***`，不泄露原值长度；额度百分比一如既往不打码。按钮的
  悬停说明中英两份都重写。

### 新增
- **介入级别改名 + 观察模式（`permissive`）**：原来的"审计开关：开始/暂停/停止"改称
  "介入级别：拦截中 / 观察模式 / 已关闭"。旧名字把在 `paused` 档下照常运行的东西命名成了
  停止对象——那一档审计一条不落，停的只是拦截，所以"暂停审计"会让人以为记录也断了
  （原来的停止确认框不得不用一整段话去解释"你真正想要的通常是暂停"，就是这个命名的补丁）。
  新增 `permissive` 作为该档的主名字，取名参考 SELinux 的 permissive / AppArmor 的
  complain：判定照跑、违规照记，只是不阻止。CLI 新增 `audit permissive` / `observe`，
  另接受 `enforcing`/`enforce`/`log-only`/`disabled`/`off` 等别名，`audit pause` 保留可用。
  **磁盘和 `/api/audit-state` 上存的仍然是 `running`/`paused`/`stopped` 三个值**，别名在入口处
  归一化，老版本和任何直接读状态文件的脚本都不受影响。
- **介入级别改用分段控件**：原来是"一个切换按钮 + 一个独立的停止按钮"，按钮上写的是动作
  不是状态，任何时刻只看得到一个选项；而且从"已关闭"出发时切换按钮指向"拦截中"，
  导致**关闭态没法一步切到观察模式**，必须先开回拦截再切一次，中间那一下是真的在拦截的。
  改成三档并排的 `radiogroup`：三档同时可见、点哪档去哪档、任意两档之间一步可达，控件本身
  即状态显示。当前档由 `aria-checked` 表达（样式和读屏器同一个事实来源），支持方向键和
  Home/End，控件下方一行说明随当前档变化。只有切到"已关闭"仍需二次确认。
- **三档专用配色**：拦截中=紫 `#9333ea`、观察模式=绿 `#22c55e`、已关闭=黄 `#facc15`，
  分段控件、顶栏状态药丸、首页摘要条圆点三处统一。刻意不复用 `--green`/`--yellow`/`--red`
  ——那是随主题变的"好/注意/坏"语义色，而档位要的是三个互相区分得开、跨主题一致的身份色
  （观察模式不是"警告"，关闭也不是"错误"）。每档配一个算过对比度的前景色，最低 5.38:1，
  全部达到 WCAG AA。选中态另有实心/空心小圆点，不只靠颜色传达。
- **Linux 探针补齐 IPv6**：`probe_linux.bt` 的三个探点原来只判 `AF_INET`，开了 IPv6 的机器上
  走 v6 的连接一条都不记——不是报错，是静默的观测盲区。`sys_enter_connect` 增加 `AF_INET6`
  分支；`tcp_sendmsg`/`tcp_cleanup_rbuf` 按地址族改用 `skc_v6_daddr`（IPv6 socket 上
  `skc_daddr` 是 0，照搬会把 v6 流量全堆到 `0.0.0.0`）。字节数聚合行的解析正则不用改，
  IPv6 地址里的冒号不影响按逗号切分。
- **README 新增"介入级别"章节**（中英各一份）：用通俗的比方说明三档分别管到什么程度、
  什么场景选哪档，重点讲清楚最容易混淆的"观察模式 vs 已关闭"——两者都不拦你，区别是
  事后有没有东西可看。

### 修复
- **`CC-Monitor verify` 在 macOS 上不再给假绿灯**：绕过检测靠内核层 execve 观测跟 hook 记录
  比对，只有 Linux 的 bpftrace 探针产生这种观测；macOS 那份用 nettop，只覆盖网络，于是
  `hook_bypass_suspected` 恒为空，命令恒输出绿色的"未发现可疑记录"。用户看到的是"检查通过"，
  实际是"从未检查过"——这种假安全感比没有这个功能更危险。现在 macOS 上如实说明该项检查
  在本平台不可用，并列出仍然有效的部分。Web UI 首页那个恒为 0 的"条疑似绕过监测"同样处理，
  后端新增 `bypassSupported` 标志，macOS 上显示"不适用"并带悬停说明。
- **`npm test` 无法运行**：`package.json` 里的 `node --test test/` 在 Node 22 下解析不了目录，
  报 `Cannot find module .../webui/test`，整套 Web UI 测试实际上一直没跑起来（单独指定
  文件才能跑）。改成 `node --test "test/**/*.test.js"`。
- **安装/启动脚本双语化**：`install.sh` 和 `start.sh` 新增系统语言检测，中文环境输出中文、
  其它一律英文（约 30 条提示）。判定顺序：`CC_MONITOR_LANG` 显式指定 > `LC_ALL` /
  `LC_MESSAGES` / `LANG` > macOS 的 `defaults read -g AppleLocale`——macOS 从图形界面打开
  的终端经常压根不设 `LANG`，少了最后这层兜底，mac 上的中文用户只会看到英文。
- **会话列表详情增加模型 token 用量**：新增"输入 / 输出 / 缓存 / Token 合计"四列，数据来自
  各会话的 transcript（复用"状态信息"页那套 `getTokenStats`）。没有 transcript 的会话
  （装 hooks 之前开的）如实显示 `-`。

## [2.0.0] - 2026-09-16

### 新增
- **跨工作目录行为检测**（新模块 `cc_monitor/workdir.py` + `policy.py` 新增
  `match: "workdir"` 规则类型）：已有规则全是"对某个字段做正则"，看不见 hook 输入里的
  cwd，判断不了"这个路径相对当前项目在哪"。新模块把一次工具调用要碰的所有路径抠出来
  （Read/Write/Edit/Glob/Grep 直接看 `file_path`/`path`；Bash 复用 `split_shell_segments`
  按子命令拆、`shlex` 认 token、`~`/`$HOME`/`$PWD` 展开、同一条命令里的 `cd` 会改后续
  相对路径的基准、`>`/`>>` 重定向和 `rm`/`mv`/`cp`/`tee`/`sed -i`/`tar -xC`/`git clone`
  等识别为写、`bash -c "..."` 递归拆），解析成绝对路径跟 cwd 比对，项目外的按位置分四档
  （`homeDotfile` 家目录隐藏文件、`otherUserHome` 别的用户家目录、`system` 系统目录、
  `otherProject` 其它）× 读/写。临时目录、`/dev`、系统目录里的解释器本身
  （`/usr/bin/python3 x.py`）、Claude Code `permissions.additionalDirectories` 里用户
  授权过的目录一律不报。`evaluate()` 新增 `cwd` 参数，hook 和 rematch 都会传。
- **四条新默认规则**（排在所有具体规则之后兜底，读 `~/.ssh` 这类被更具体规则先命中的
  仍算在原规则里）：`workdir_escape_write_sensitive`（`high`/`confirm`，往家目录隐藏
  文件/别人家目录/系统目录写）、`workdir_escape_write_other`（`medium`/`log`，往
  其它项目目录写——真实历史里一个会话跨到旁边项目改几百个文件很常见，默认只记录，
  想拦的话把 action 改成 confirm）、`workdir_escape_read_sensitive`（`medium`/`log`）、
  `workdir_escape_read_other`（`low`/`log`）。每条都带 `scopes`/`access`/`ignore_paths`
  字段，用户可以在 `rules.json` 里自己调档位、加白名单。规则数从 70 增至 74。
  claude 用 root 跑、项目却放在 `/home/<user>` 下的场景专门处理过：cwd 所在的那个
  用户家目录也算"自己家"，旁边的项目是 `otherProject`，不会误判成"别的用户的家"。
- **跨工作目录检测的降噪**（用 2500 多条真实历史事件做的调优）：把"cd 进子目录后误报
  整个项目"这一类彻底消掉（实测占误报的约七成），加上系统目录只读、Claude 自身状态目录
  等豁免；剩下的基本都是真的跨出去了（比如在 A 项目目录里读写 B 项目的文件——这种即便
  两个目录是同一份工作的不同副本，工具也无从判断，需要的话用规则的 `ignore_paths` 把
  某个目录并进来）。
  - **按项目根算边界，不按 hook 给的 cwd**：Claude Code 的 Bash 工具 `cd` 进子目录之后，
    hook 输入里的 `cwd` 也跟着变成子目录（比如 `proj/webui`），这时候改 `proj/README.md`
    会被当成跨目录——占了原来七成的误报。现在从 cwd 往上找 `.git`/`.hg`/`.svn`/
    `CLAUDE.md`/`.claude` 标记，取家目录之下最靠上的那一层当项目根。
  - **只读系统目录里的读不报**（`/usr`、`/lib*`、`/bin`、`/opt`、`/snap`、`/nix`、
    `/System`、`/Library`、`/Applications`，以及 `~/.cache`）：查共享库、看头文件、跑程序
    都是读这些地方；往这些地方写照样按 `system` 档报。`/etc`、`/proc`、`/var`、`/root` 这类
    放配置/状态的目录读仍然报。
  - **`~/.claude/projects` 整体忽略**：Claude Code 自己的会话记录/自动记忆/todo，读写它们是
    它正常工作的一部分；`~/.claude` 下别的东西（settings、凭证）照常报。
  - **忽略目录/项目内的路径按字面判定、不追符号链接**：`ln -sf /usr/lib/x.so /tmp/build/x.so`
    之前会被 realpath 解析成"往 /usr/lib 写"。
  - `/` 本身归到 `system` 档（`find /`、`ls /`）。
- **`CC-Monitor workdir` 子命令**：按规则小计 + 逐条列出最近的跨工作目录文件操作。
- **审批弹窗用通俗易懂的内容概述需要审批的操作指令**：74 条默认规则每条新增 `title` /
  `desc`（及 `title_en` / `desc_en`），用一句通俗的话说明这条规则拦的是什么操作、为什么
  要确认（比如 `git_force_push` →
  "git 强制推送：会覆盖远程分支历史，别人已拉取的提交可能丢失"）。AI 审批台的每张卡
  先显示"需要确认：<title>"，下面一行解释，规则 id 和工具名退到最后一行小字；Claude Code
  原生权限确认（没命中规则）按工具名给一句说明；审批历史表的"命中规则"列也显示通俗标题
  （悬停看 id）。终端里的确认提示和桌面通知同样带上 title/desc。新增 `/api/rules/meta`
  （`webui/lib/rules.js` 读 `~/.cc-monitor/rules.json`，用户改过的文案也能跟上）。
  老用户的 `rules.json` 会通过默认规则同步机制自动补上这些字段；用户自定义的规则没写
  title 就退回显示 id。
- **首页"跨工作目录操作"卡片** + `/api/drilldown/workdir-escape`：跟"高级威胁检测"
  同一套 `matched_rule` 归类/下钻模板，四个分类对应上面四条规则。
- **`tests/test_workdir.py`**：分档、文件类工具、Bash 路径抽取（含 heredoc 正文/字符串
  里的路径不误报、`cd` 跟踪、同一路径写覆盖读）、规则映射与优先级的回归测试。

- **截图检测大幅扩充**：原来只认 `scrot`/`gnome-screenshot` 那一撮桌面截图工具，实测
  394 条记录里 391 条其实是"读取图片文件"，真正的截图命令只识别出 3 条。现在按三类覆盖：
  宿主机屏幕（X11 / Wayland / macOS / Windows 截图工具、屏幕录制 ffmpeg x11grab 等、
  framebuffer 直读、脚本里的 `ImageGrab.grab()`/`pyautogui.screenshot()`/mss 等抓屏库）、
  网页（headless 浏览器 `--screenshot`、CDP `captureScreenshot`、Playwright/Puppeteer/
  Selenium 的截图 API、shot-scraper/wkhtmltoimage/gowitness 等工具）、虚拟机与远程设备
  （QEMU `screendump`（HMP 与 QMP 两种形式）、`virsh screenshot`、VBoxManage、VMware、
  VNC、`adb shell screencap`、`idevicescreenshot`、`simctl`）。识别数从 3 → 209，其中
  **QEMU 虚拟机截屏 174 条此前完全没有被检测到**。误报为 0：命中前会剥掉
  `sudo`/`env`/`timeout`/路径前缀等包装，`grep`/`rm`/`ls` 等纯检索命令即使提到关键字也
  不算，ImageMagick 的 `import` 必须带 `-window`/`-screen` 或图片文件名才算（避免撞上
  Python 的 `import`）。详情页新增按方式分类的小计与彩色徽章，真截屏不再被图片读取淹没。
- **账号信息一键打码**：「Anthropic 账号 & 额度」分组新增"隐藏敏感信息"按钮，把姓名 /
  邮箱 / 组织 / 组织角色 / 套餐 / 额度档位 / 计费方式 / 账号创建时间 / 订阅开始时间
  全部显示成 `***`，方便截图和演示。状态存本浏览器，只改显示、不动数据，额度百分比不打码。
- **额度进度条配色方案**：10 种可选（默认 / 分段色阶 / 红黄绿三档 / 蓝青 / 紫粉霓虹 /
  日落暖 / 森林绿 / 光谱 / 灰度 / 主题强调色），同时作用于额度卡、"已使用百分比"和
  "重置时间"三种进度条；选默认时后两者保持原来的 severity 配色。
- **claude 进程明细增加信息**：运行时间、模型 ID、事件数、内存占用（`ps` 的 `etime`/`rss`，
  POSIX 字段，Linux 与 macOS 通用；模型按 cwd 关联审计会话的 transcript 解析）。
- **被拦截的高危操作详情增加统计**：累计 / 最近 24 小时 / 最近 7 天三张卡，外加按命中规则、
  按工具、按工作目录三个维度的分类小计。

### 变更
- **首页改成紧凑仪表盘**（先用 Claude Design 出稿确认方向再落地；配色/圆角/字号/卡片
  边框全部沿用原来的主题变量，没有新颜色）：
  - 顶部一条**态势摘要**：审计状态 + claude 进程数、已监测会话（附进行中的 Web UI 终端
    会话数）、待审批（点击直达审批台）、已拦截 + 疑似绕过、单次额度剩余——原来这几个
    "现在怎么样"的数字散在页面四处。
  - 原来四条各带一段说明文字的控制条（审计开关/归档清空/同步更新/远程访问）收成**一行
    工具栏**，说明文字进 ⓘ 悬停气泡（新增 `data-i18n-tip`，中英文照常切换）。
  - 每个分组改成**短标题 + ⓘ**，不再每组占一整行长说明；安全类六张红卡并排，卡片下多一行
    小字提示覆盖范围（跨工作目录那张实时显示读/写/敏感位置计数，`/api/overview` 新增
    `workdirEscapeBreakdown`）；活动/命令类用紧凑卡（1.5rem 数字），MCP/Glob·Grep/TodoWrite
    三个低频计数合并成一张卡（每个数字仍各自可点开下钻）；文件操作/软件安装收进两个盒子。
  - 账号信息 + 额度卡 + 限额明细并成一行两栏。页面高度约减半，所有下钻入口和元素 id 都
    保留（app.js 的绑定不受影响）。
- **其它七个标签页统一成同一套页头**（`.page-head`：短标题 + ⓘ 说明 + 行内控件）：
  状态信息页改成跟首页一样的两栏账号/额度布局，模型使用统计和会话状态用分组标题；
  网络流量页的 GeoIP 精度徽章进页头、汇总卡改紧凑卡、地图图例移到分组标题右侧；
  AI 审批台的桌面通知按钮进页头，审批历史表格时间/结果/处理方式列不再折行、长文本列
  限宽省略（悬停看全文）；Log 审计 / Claude Tap 的开关和会话下拉框收进页头，Claude Tap
  没选会话时给一句提示而不是整页空白；终端会话侧栏标题同款；历史数据页头同款。
  所有页面的长段说明文字都从正文移进 ⓘ。
- **下钻弹窗加载失败时给出说明**：之前接口 404/无响应会一直停在"加载中…"（典型场景：
  刚更新过代码但正在运行的 Web UI 服务还是旧版本、没有新路由）；现在换成一句提示，
  告诉用户重启 Web UI。

- **下钻弹窗放宽到 1400px**：会话列表有 8 列（完整工作路径、36 位 UUID、时间范围…），
  原来跟"选择文件夹"那种窄弹窗共用 760px，列头被压成一列一个字、UUID 折成四行，一屏
  只看得到 10 行。现在单独放宽（一屏 24 行），窄屏改为横向滚动而不是继续挤；
  "选择文件夹"弹窗保持 760px 不变。
- **事件列表分段上色**：时间戳、文件夹名、session id、完整路径、命中规则各自配色（原来
  整行灰字），并抽出共用函数统一了 5 处手拼代码；下钻列表的操作标签复用 Log 审计页已有的
  按操作类型配色（读/写/编辑/Bash/删除），不再是没有颜色的裸标签。
- **生命体征指示器放大**：心形 14→20px、心电图 40×14→54×20，颜色深浅（也就是"有多活跃"）
  在表格里终于看得出层次。
- **"已监测的 Claude Code 会话"后面加了 Claude 星芒标记**（内联 SVG，无外部资源）。
- **规则文案回退**：用户改过的规则不会被默认规则合并覆盖，于是拿不到新版加的
  `title`/`desc`，审批台只能显示规则 id。展示时按 id 回退到内置默认文案（Python 与
  Node 两侧），不写回用户的 `rules.json`。

### 修复
- **Web UI 终端会话的健康状态永远是灰色**：`/api/sessions` 从来没返回 `statusAgoMs`，
  而 `vitalHeat()` 拿到 `undefined` 一律返回 0，导致颜色插值退化成纯灰、心电图拉直线，
  不管会话多活跃都一样。现在按"PTY 最近有输出"和"该目录最近有审计事件"取更近的那个返回。
- **账号额度卡片"剩余 · 单次额度"在窗口刚到期时显示 0%**：接口在 5 小时窗口过期、
  还没有新请求刷新数字的那段时间里，仍会把上一个窗口末尾的用量（用满就是 100%）连同
  已经过去的 `resets_at` 一起原样返回，前端按它算"剩余"就是 0%。现在 `resets_at` 已
  过就按 0 已用处理，并把用量夹在 0~100 之间。

## [1.8.0] - 2026-09-14

### 新增
- **"高级威胁检测"首页卡片**：复用 `matched_rule` 架构（不重复写正则），把此前几批新加的
  高危规则统一归类展示——`cryptoMining`（挖矿）、`dbFileWrite`（数据库任意文件写入）、
  `webshell`（webshell 代码特征）、`reverseEscapeShell`（反弹/逃逸 shell）、
  `downloadExec`（下载后执行）、`c2Framework`（C2 框架工具）、`postExploitation`
  （后渗透/内网横向工具）、`suspiciousMcp`（可疑 MCP 工具名）、`pentestRecon`
  （扫描/爆破工具）、`covertTunnel`（隐蔽隧道工具）十个分类，新增
  `/api/drilldown/advanced-threat`。
- **`policy.py` 的 `evaluate()` 新增 `field: "tool_name"` 支持**：规则可以直接匹配
  `tool_name` 本身，不再局限于 `tool_input` 里的字段——MCP 工具调用的 `tool_name`
  是运行时才知道的动态字符串（`mcp__<server>__<tool>`），没法像 Bash/Write 那样枚举进
  `tools` 列表。
- **新增 `mcp_suspicious_tool_name` 规则**（`high`/`confirm`）：MCP 工具名里出现
  `reverse-shell`/`c2`/`beacon`/`backdoor` 字样就标出来——直接对应分析
  AIPentest/CyberStrikeAI 时发现的反向 Shell MCP Server（官方文档明确支持接入 Claude
  Code 的 `.mcp.json`）。
- **新增 `post_exploitation_tool_execution` 规则**（`high`/`confirm`）：
  `linpeas`/`netexec`/`bloodhound`/`sharphound`/`smbmap`/`rpcclient`/`enum4linux-ng`
  这几个后渗透/内网横向阶段的标准工具，`c2_framework_execution` 加了 `pacu`（AWS 云
  攻击框架），`pentest_recon_tool_execution` 加了 18 个子域名枚举/Web 模糊测试工具
  （`rustscan`/`amass`/`subfinder`/`ffuf`/`feroxbuster`/`dirsearch` 等）。
- **新增"逆向分析工具调用"首页卡片**：识别 IDA/Ghidra/radare2/rizin/GDB 以及
  Binary Ninja/Hopper/x64dbg/WinDbg/dnSpy/JADX/apktool/Frida/binwalk/checksec 等
  一批逆向分析工具的调用，纯可见性统计（这些是专业逆向工程师/CTF/合规安全测试里的日常
  工具，不代表风险，不参与 confirm/block）。
- **新增 `shell_escape_via_utility` 规则**（`high`/`block`，参考
  [GTFOBins](https://github.com/GTFOBins/GTFOBins.github.io)）：`find -exec`、
  `awk system()`、`perl exec`、Python 的 `pty.spawn`/`os.system`、
  `tar --checkpoint-action=exec`、`vim -c ':!sh'`、`zip --unzip-command`、
  `script -c`、`ssh` 的 `ProxyCommand` 这几种"用一个看起来无害的日常工具逃逸出
  shell"的经典手法，"高级威胁检测"同步加了 `reverseEscapeShell` 分类（把这条和已有的
  `reverse_shell_pattern` 归到一起）。规则数从 58 增至 70。
- **首页新增"同步更新"按钮**：`POST /api/sync-update` 用 `execFile` 固定参数数组在
  项目源码目录跑 `git pull`（不经过 shell，不接受任何请求参数拼进命令行），把
  GitHub 上的新代码/新规则同步下来；二次确认弹窗，把 git 自己的输出/报错原样展示，
  不做任何自动冲突处理。
- **下钻详情统一视觉强化**：GitHub/SSH/下载/Docker/压缩归档/网络诊断/逆向分析/
  进程管理/敏感操作/敏感数据/高级威胁检测这十个共用同一套下钻模板的分组，事件明细
  里的分类徽章和"行为操作"标签统一标红加粗。

### 修复
- **`decision.submitted` 缺中英文翻译**：`UserPromptSubmit` 生命周期事件的
  `decision` 固定是 `"submitted"`，之前漏加了对应的 i18n key，中文界面下显示成了
  英文单词。
- **逆向分析工具调用分类器的几个精度问题**（用真实历史数据发现的）：真实场景里 IDA
  几乎都是绝对路径调用（比如 `/opt/idapro-9.0/idat64`），原来只认裸文件名开头会
  全部漏检，补了路径前缀剥离；`LD_LIBRARY_PATH=... gdb ...` 这种环境变量赋值前缀
  也会把剥离逻辑带偏，补了环境变量赋值剥离；rizin 家族只认了 `rz-bin`/`rz-asm`
  两个子工具，扩到 `rz-\w+`；`frida-ls-devices` 这类多段连字符的 frida 子命令
  漏匹配；新增 macOS `open -a "IDA Pro"` 等 GUI 启动方式识别。
- **`env_dump` 规则过度匹配**：`env VAR=val VAR2=val2 command` 这种设置环境变量
  启动子进程的常见写法（调试/构建脚本里很常见）被误判成"在 dump 环境变量"，加了
  负向前瞻排除掉赋值形式。用真实数据验证：某台机器上的历史误判从 134 条降到
  14 条，v1.7.1 加的自动重判机制自动生效，未手动干预。
- **归属地信息中文界面下显示英文**（比如 `Tseung Kwan O, HK`）：`geoip.js` 之前
  写死取 MaxMind 数据的英文名，改成跟着页面语言选（中文界面优先取
  `.names["zh-CN"]`）；另外新增一张 250 个国家/地区代码到中文名的静态映射表，
  给 DB-IP Lite 这类没有多语言字段的扁平格式数据源兜底（国家/地区一级能翻，城市名
  因为数据源限制没有中文版本，如实保留英文）。
- **`shell_escape_via_utility` 规则设计过程中修了两个正则精度 bug**：
  `script -qc /bin/sh` 这种合并短选项写法一开始没匹配上；
  `ssh -o ProxyCommand='ssh -W %h:%p jump' target`（合法跳板机用法）被误判成
  shell 逃逸——懒惰匹配的通配符吃到了 "ssh" 这个词自己的尾巴 "sh"，加了词边界
  卡死。

## [1.7.2] - 2026-09-14

### 新增
- **参考 [suricata-rules](https://github.com/al0ne/suricata-rules) 分类思路新增 9 条规则**：这是一份网络层面的
  Suricata IDS 规则集，跟 CC-Monitor 不是同一层检测（那边看网络包内容，这边看 Claude
  Code 自己发起的工具调用），规则文本本身不能照搬，但按它的目录分类找出了几个此前
  完全没覆盖的攻击技术类别：
  - `crypto_miner_pool_domain_command`/`_write`（`medium`/`confirm`）：命令行或写入内容
    里出现已知挖矿矿池域名（`pool.minexmr.com`/`monerohash.com`/`xmrpool.eu` 等，从该仓库
    `Crypto_miner_pool` 目录提取）或 `stratum://` 协议 URI。
  - `db_arbitrary_file_write`（`high`/`confirm`，`tools: ["Bash"]`）+
    `db_arbitrary_file_write_content`（`medium`/`confirm`，`tools: ["Write","Edit",
    "NotebookEdit"]`）：MySQL/MariaDB 的 `INTO OUTFILE`/`INTO DUMPFILE`/`general_log_file`
    这几个合法功能被滥用成任意文件写入、借此在 Web 目录落地 webshell 的经典手法（该仓库
    `Mysql` 目录的日志写文件规则思路），之前的 `db_destructive_command`
    只覆盖 DROP/DELETE/TRUNCATE，完全没管这种"写文件"用法。
  - `webshell_pattern_in_write`（`high`/`block`，插在 `dynamic_exec_in_write` 之前，
    优先命中）：菜刀/冰蝎/Weevely 这几类一句话马的经典代码形状（PHP 的
    `eval`/`assert` 直接调用 `$_POST`/`$_REQUEST` 数组、ASP 的 `eval request(`、JSP 的
    `Runtime.getRuntime().exec(request.getParameter`），比现有的泛化
    `dynamic_exec_in_write`（只认字面上的 `eval(`，噪音太大只能 log）精确得多，误判率低
    到可以直接 `block`——正常代码几乎不会写出这种形状。
  - `curl_download_then_exec`（`high`/`confirm`）：`curl_pipe_shell` 只抓
    `curl|sh` 管道形式，"先 `curl -o x.sh` 下载、再 `chmod +x && ./x.sh` 分两步执行"这种
    功能等价但没有管道符的变体之前完全漏检。
  - `c2_framework_execution`（`high`/`confirm`）/`pentest_recon_tool_execution`
    （`medium`/`log`）：渗透测试/C2 框架工具的命令行调用本身（`msfconsole`/`msfvenom`/
    `teamserver`/`impacket-*`/`mimikatz`/`cobaltstrike`/`sliver`/`havoc` 等 vs.
    `nmap`/`sqlmap`/`hydra`/`nikto`/`gobuster` 等扫描类工具，前者风险明显更高单独分级）。
  - `covert_tunnel_tool_execution`（`medium`/`confirm`）：`dnscat2`/`iodine`/`dns2tcp`/
    `ptunnel`/`icmptunnel`/`hans`/`pingtunnel` 这类 DNS/ICMP 隐蔽隧道工具的调用，跟
    1.7.1 加的 `ssh_tunnel_reverse_proxy` 是同一个"隐蔽出网通道"主题下的姊妹规则。
  `default_rules.json` 从 58 条增至 67 条。用真实 `policy.evaluate()` 跑了 25 个正负测试
  用例全部通过（含"webshell 规则不应该误伤普通代码里出现的动态执行调用"这类边界情况），
  `python3 -m unittest tests/test_rules.py` 和 webui 的 `node --test` 均无回归。已有
  用户的 `~/.cc-monitor/rules.json` 会在下次 hook 调用时经 1.7.1 加入的自动合并机制
  自动补上这 9 条，不需要手动同步。

## [1.7.1] - 2026-09-14

### 修复
- **macOS 上读取 shell 历史指令没被"敏感操作统计"识别到**：根因有两层。
  1. `~/.cc-monitor/rules.json` 是首次运行时拷的副本，之后新版本加进
     `default_rules.json` 的规则（包括 `history_read` 本身，1.6.0 才加的）根本不在老用户
     的文件里——实测一份 1.x 早期安装的 `rules.json` 只有 33 条规则，1.7.0 的默认表有 57 条。
     这类"改了默认规则但用户侧不生效"的问题在 CHANGELOG 里已经提醒过五六次"需要手动
     同步"，这次直接在 `policy.ensure_config()` 里做自动合并：本地缺失的默认规则按 id 补上
     （插在它在默认表里前一条规则后面，保持首个命中即返回的顺序语义）；新增
     `~/.cc-monitor/rules.defaults_snapshot.json` 记录上次同步时的默认表，本地某条规则跟快照
     一模一样（用户没改过）而默认表里这条变了（比如修正正则）就直接换成新的；用户改过的
     （跟快照不一样）一律不动；本地缺失但快照里有的 id 视为用户主动删除，不再补回。老版本
     升上来第一次没有快照，只补缺失的、不碰已有的。合并结果直接返回给 `load_rules()`，
     配置目录只读时也能用内存里合并好的规则跑，hook 本身不受影响。
  2. 即使规则在，原 `history_read` 正则也只认 `cat/less/more/head/tail/strings` 开头
     + 历史文件名这一种形态。Claude Code 在 Mac 上实际的读法几乎全在盲区：`python3 -c
     "open('~/.zsh_history')"`、`wc -l < ~/.zsh_history`、`for f in ~/.zsh_history ...`、
     `grep token ~/.zsh_history`、zsh 原生的 `fc -l`、`$HISTFILE`、macOS Terminal 按会话
     存的 `~/.zsh_sessions/*.history`、Claude Code 自己的 `~/.claude/history.jsonl`，以及
     最常见的——直接用 `Read` 工具读 `~/.zsh_history`（`sensitive_file_read` 规则根本没
     包含历史文件）。重写 `history_read`：只要命令文本里出现历史文件路径（不再要求特定
     读取命令前缀，`python`/`grep`/重定向都算）、`$HISTFILE`、`.zsh_sessions/`、
     `.claude/history.jsonl`，或子命令开头是 `history`/`fc -l` 就命中；新增
     `history_file_read`（`tools: ["Read", "Grep"]`, `field: "file_path"`, `log` 级别）覆盖
     Read/Grep 工具直接读历史文件。`history_tampering` 顺带补上 `.zsh_history` 和
     `rm .zsh_sessions/` 两种 Mac 上的清历史写法（原来只认 `.bash_history`）。
  3. WebUI 的敏感操作统计（`webui/lib/audit.js`）原来把四条规则 id 硬编码在 JS 常量和
     两处 SQL `IN (...)` 里三个地方，加规则要同步改三处；现在 SQL 从 `SENSITIVE_READ_RULES`
     常量生成，只改一处。`history_file_read` 归到"其它（历史指令读取等）"；取文本时
     Bash 看 `command`，其它工具看 `file_path`/`path`（原来只认 Read 一个工具名）。
  注意：之前没被识别到的历史读取事件当时 `matched_rule` 就是空的，不会追溯补算，
  统计只对修复之后的新事件生效。
- **排查"MacPorts `port install` 没被识别"**：`system_package_install` 从 1d762af 起就
  覆盖了 `port install/uninstall/upgrade/activate/deactivate/selfupdate`，规则引擎对
  `sudo port install`、`port -N install`、`/opt/local/bin/port install`、`xargs sudo port
  install` 等写法全部命中，而且审计库（含归档）里从来没有一条 `port` 命令经过 hook 的
  记录——说明这次"没识别到"不是规则漏了，而是那条命令压根没走 Claude Code 的 Bash 工具
  （在自己终端里敲的、用 `!` 前缀跑的、或者 Claude 因为 `sudo` 要密码而让用户自己去
  执行的，hook 都看不到；这是 PreToolUse 机制的边界，不是 bug）。顺手加固了 `port`
  这段正则：`-D /path`、`--debug` 这类带参数/长格式的全局选项夹在中间也能命中，动作
  列表补上 `sync`。
- **系统包管理器（apt/yum/dnf/pacman/brew/port）识别不准确：10 条"命中"全是误报**：
  审计库里归到 `system_package_install` 的 10 条事件，没有一条是真的在装软件——全是
  `grep "port install" default_rules.json`、python heredoc 里写着 `"apt install"` 字样的
  命令。根因是规则引擎对整条命令文本做 `re.search`，引号里的字符串、heredoc 正文、grep
  的搜索词一视同仁；`sudo_usage`/`sudo_pip_install` 也是同样的问题（修这个 bug 的过程中
  两条编辑命令就因为 heredoc 里出现 `sudo apt-get install`、`sudo pip install` 字样被拦了）。
  规则新增可选字段 `match`："search"（默认，行为不变）或 "segment"——把 Bash 命令按顶层
  `; & | 换行` 切成子命令（引号/heredoc 内部不切），每段剥掉 `sudo`/`env`/`xargs`/`time`/
  `nice`/`nohup` 包装、环境变量赋值前缀、可执行文件路径前缀（`/opt/local/bin/port` →
  `port`），再用 `re.match` 从开头匹配；`bash -c "..."`/`osascript ... do shell script "..."`
  的字符串体递归展开，藏在里面的真实安装不会漏。每段同时给"原样"和"剥包装"两个版本，
  `sudo_usage` 要看到 sudo 本身、`apt`/`brew`/`port` 规则要看到真正的命令名。切到 segment
  模式的规则：`system_package_install`、`package_install_other`、`npm_global_install`、
  `npm_local_install`、`sudo_usage`、`su_pkexec_privilege_escalation`、`sudo_pip_install`、
  `pip_install_no_venv`。`pip_install_venv_context` 依赖整条命令里的 venv 上下文
  （`source .venv/bin/activate` 在另一个子命令里），保持 search 模式。`package_install_other`
  里的 `brew install` 分支删掉（`system_package_install` 在前面已经接管，永远到不了）。
  segment 模式下 `matched_value` 是命中的那个子命令而不是整条命令，审批台/拦截原因里
  更直观。`policy.split_shell_segments`/`segment_heads` 跟 `webui/lib/audit.js` 的
  `splitShellSegments` 是同一个思路的 Python 版。
- **规则更新后历史事件自动按新规则重判**：首页各统计卡片都是按 `events.matched_rule`
  聚合的，而这个字段是事件发生那一刻按"当时的规则"算出来写死的——规则修好了，历史
  上的误报/漏报也不会自己消失。新增 `cc_monitor/rematch.py`：hook 每次调用算当前规则表
  的内容指纹（`policy.rules_fingerprint`，跟文件 mtime 无关，自动合并重写/touch 不会
  触发），跟 `meta` 表里记的"上次重判用的指纹"不一样就通过一条原子 upsert 认领，起一个
  独立后台进程跑 `CC-Monitor rematch --apply --quiet`（几千条事件逐条过正则要几秒，
  PreToolUse 不能卡这么久；多个 hook 同时发现也只有一个会起进程）。只改 `risk`/
  `matched_rule` 两列，`decision` 永远不动，归档库不碰。也可以手动：`CC-Monitor rematch`
  预览、`--apply` 写库。本机跑完之后"系统包管理器"从 10 变成 0，之前没识别到的 4 条
  历史指令读取事件也补上了 `history_read`。
- **README"已知限制"补充监测边界说明**：排查"brew/port 安装没被统计"时发现那几条
  命令是用户在自己终端里敲的（`~/.zsh_history` 里有、审计库里没有），hook 只能看到 Claude
  Code 发起的工具调用。这个边界之前文档里没写明，现在两种语言的"已知限制"都加了一条。
- **`tests/test_rules.py` 补充 segment 模式和 rematch 的用例**：12 种"提到了但没执行"的
  误报样例、23 种真实执行（含 `bash -c`、`xargs`、环境变量前缀、子 shell 括号、绝对路径）
  的命中样例，以及 rematch 改 `matched_rule` 不改 `decision` 的断言。
- **新增规则回归测试 `tests/test_rules.py`**：`python3 -m unittest tests/test_rules.py`，
  用隔离的 `CC_MONITOR_HOME` 跑，不碰用户自己的 `rules.json`。目前覆盖系统包管理器
  （含 MacPorts 各种写法）和历史指令读取两组"必须命中/不能误报"的样例，以后再报
  "某某没检测到"先往这里加一行样例就能复现。

## [1.7.0] - 2026-09-14

### 新增
- **新增 Claude Code 自身配置文件篡改检测**：改 `~/.claude/settings.json`（或项目内
  `.claude/settings.json`/`settings.local.json`）、`.claude/hooks/` 目录下的脚本、
  `CLAUDE.md` 之前完全没有规则覆盖。这是目前发现的最大缺口——改配置文件删掉 hook
  注册，比 `kill -9` 探针进程更隐蔽（不需要杀任何进程，Claude Code 下次工具调用
  时应用层监测就已经悄悄失效了），跟已有的 `kill_monitoring_process` 是同一个
  "防绕过"目标，但覆盖的是配置层面而不是进程层面。新增 `claude_config_tamper`
  （`risk: high`, `action: confirm`），`tools: ["Write", "Edit", "NotebookEdit"]`，
  `field: "file_path"`。用 `confirm` 而不是 `block`，是因为正常给自己项目加一个
  新 hook、改 `CLAUDE.md` 本来就是合理操作。插在 `shell_rc_write` 之后。
- **Docker 特权/挂载检测新增 Docker socket 挂载识别**：`docker_privileged_or_host_mount`
  原来只认 `--privileged` 和 `-v /:/` 这两种写法，`-v /var/run/docker.sock:/var/run/docker.sock`
  这个更常见、更经典的容器逃逸手法（挂载宿主机 docker socket 等于把宿主机 root
  权限直接送进容器）完全漏检。扩展正则加上 `docker.sock` 这个子串匹配，同时把
  这条规则的 `risk` 从 `medium` 提到 `high`（`--privileged`/`docker.sock` 挂载都是
  宿主机 root 等价的风险，`medium` 偏低了；`action` 维持 `confirm`，兼容合法的
  DinD/CI 场景）。
- **新增写入内容密钥格式扫描**：之前所有规则全部按文件路径/命令文本判断，Claude
  把 API key 写进任意一个不带敏感文件名特征的文件（比如 `config.py`、
  `notes.txt`）完全不会触发任何规则。新增 `secret_pattern_in_write`
  （`risk: high`, `action: confirm`），`tools: ["Write", "Edit", "NotebookEdit"]`，
  新增的 `field: "content"` 扫描私钥文件头（`-----BEGIN ... PRIVATE KEY-----`）、
  AWS Access Key（`AKIA`/`ASIA` 前缀）、GitHub token（`ghp_`/`gho_`/`ghu_`/`ghs_`/
  `ghr_`/`github_pat_`）、Anthropic/OpenAI key（`sk-ant-`/`sk-proj-`/`sk-`）、Slack
  token（`xox[baprs]-`）、Google API key（`AIza`）、npm token（`npm_`）、Stripe
  live key（`sk_live_`）这几类高置信度的固定前缀格式。`cc_monitor/policy.py` 的
  `FIELD_CANDIDATES` 新增 `"content": ["content", "new_string", "new_source"]`
  映射——Write 用 `content`、Edit 用 `new_string`、NotebookEdit 用
  `new_source`，三个工具语义上都是"即将写进文件的内容"，一条规则要同时认这三个
  字段名，跟已有 `file_path` 的多候选写法是同一个道理。已经写进 `.env`/`.ssh/`
  这类本来就被 `sensitive_file_write` 覆盖的路径不会重复触发——规则顺序保证更
  具体的路径规则先命中。局限性：按字符类型+长度的固定前缀匹配，不看信息熵，
  文档里的示例占位符密钥（比如全用 `x` 填充的假 key）如果长度凑巧够长也会被
  误判，这是所有轻量级密钥扫描工具（gitleaks/trufflehog 的非熵值模式）共有的
  局限，`action: confirm` 而不是 `block` 也是为了给这种误判留人工确认的余地。
- **新增 git hooks / git config 持久化攻击面检测**：`core.hooksPath`（把 git hooks
  重定向到别的目录）、`url.<url>.insteadOf`（悄悄把依赖源换成攻击者控制的仓库，
  真实供应链攻击手法）、直接用 Bash 重定向写入 `.git/hooks/`，之前都没有覆盖——
  跟已有的 `crontab_persistence`/`systemd_persistence` 是同一类"植入持久化后门"
  风险，但 git 生态里的对应手法完全是盲区。新增两条规则：`git_hooks_persistence`
  （`risk: medium`, `action: confirm`，`tools: ["Bash"]`，覆盖上面三种命令行写法）
  和 `git_hooks_file_write`（同样 `medium`/`confirm`，`tools: ["Write", "Edit",
  "NotebookEdit"]`，`field: "file_path"`，覆盖直接用 Write/Edit 工具往
  `.git/hooks/` 底下写文件这个命令行规则覆盖不到的写法）。`git_hooks_persistence`
  插在 `git_hard_reset_clean` 之后。
  以上四项用 26 个正负测试用例、外加 13 个覆盖全部旧规则类别的回归测试，全部
  直接调用 `cc_monitor/policy.py` 的真实 `evaluate()` 函数验证（不是简化版
  正则复现），确认新规则匹配正确、`FIELD_CANDIDATES` 新增 `"content"` 映射没有
  影响 `command`/`file_path`/`url` 这些既有字段的解析，`node --test` 5/5 全部
  通过。已有用户的 `~/.cc-monitor/rules.json` 不会自动更新，想要这些新规则生效
  需要手动同步。
- **落地 [slowmist-agent-security](https://github.com/evilcos/slowmist-agent-security)
  致谢里提到的 5 条规则思路**：`credential_grep_scan`（`grep -r`/`rg -r` 之类递归
  搜索 password/secret/api_key/token 等凭据关键字，`medium`/`confirm`）、
  `npx_pipx_ephemeral_run`（`npx`/`pnpm dlx`/`bunx`/`pipx run`/`uvx` 这类跳过本地
  安装痕迹直接执行远程包的一次性执行，`medium`/`confirm`）、`proc_env_read`（读取
  其它进程的 `/proc/<pid>/environ`/`cmdline`，跨进程偷凭据的经典手法，`high`/
  `confirm`）、`browser_credential_read` + `browser_credential_read_bash`（Chrome/
  Chromium/Brave/Edge/Firefox 的 `Cookies`/`Login Data`/`cookies.sqlite`/
  `logins.json`/`key4.db` 等登录态文件，分别覆盖 Read 工具和 Bash 命令行两种访问
  方式，`high`/`confirm`）、`dynamic_exec_in_write`（写入内容里出现 `eval(`/
  `exec(`/`os.system(`/`subprocess.*shell=True`/`new Function(`/
  `child_process.exec(` 这类动态执行代码，常见于植入后门，但正常代码里也很常见，
  故意压低到 `medium`/`log` 不打扰正常写代码）。
- **新增编码混淆执行检测**：`encoded_payload_exec`（`base64 -d`/`xxd -r -p` 解码后
  管道给 `sh`/`bash`/`zsh`/`python3`，是 `curl_pipe_shell` 最常见的绕过变体——同样
  是"下载/构造一段东西直接丢给解释器执行"，只是用编码绕开了对 `curl|wget` 关键字
  的文本匹配，`high`/`block`，跟 `curl_pipe_shell` 同等对待）。
- **新增 SSH 隧道/反向代理检测**：`ssh_tunnel_reverse_proxy`（`ssh -R`/`-D`/`-L`
  建隧道、`socat`、`chisel client`/`server`，`medium`/`confirm`——很多合法用途
  比如连内网数据库，所以没有做成 `block`）。插在 `reverse_shell_pattern` 之后，
  跟已有更严格的 socat 反弹 shell 特征是同一个"隐蔽出网通道"主题，评估顺序上
  `reverse_shell_pattern` 更精确的匹配优先命中。
- **`claude_config_tamper` 扩大覆盖面到 MCP/Skills 配置**：原来只认
  `.claude/settings*.json`/`.claude/hooks/`/`CLAUDE.md`，现在加上项目级
  `.mcp.json` 和 `.claude/skills/` 目录——写入一个恶意 MCP server 配置或恶意
  skill 定义，是比改 hooks 更隐蔽的持久化后门手法，也正是 slowmist 清单聚焦的
  攻击面。
  以上共新增 8 条规则（`default_rules.json` 从 49 条增至 57 条）+ 1 条既有规则的
  patch，用真实 `policy.evaluate()` 跑了 18 个正负测试用例全部通过验证。已有
  用户的 `~/.cc-monitor/rules.json` 不会自动更新，需要手动同步。
- **接入 6 个会话生命周期 hook**：`UserPromptSubmit`/`SessionStart`/`SessionEnd`/
  `PreCompact`/`Stop`/`SubagentStop`——之前只接了 `PreToolUse`/`PostToolUse`/
  `PermissionRequest`，纯对话、没有触发任何工具调用的轮次完全没有审计留痕。
  这 6 个新 hook 全部是**纯审计留痕**，不参与 confirm/block（生命周期事件没有
  "允许/拒绝"语义）：`UserPromptSubmit` 记录用户原始输入（唯一能看到"用户到底
  让 Claude 干了什么"的钩子）；`SessionStart`/`SessionEnd` 记录会话的开始来源
  （`startup`/`resume`/`clear`/`compact`）和结束原因；`PreCompact` 在长会话被
  压缩前记一笔（避免审计细节随上下文压缩丢失）；`Stop`/`SubagentStop` 记录主
  任务/子代理的结束。`cc_monitor/hook.py` 新增对应 6 个 `handle_*` 函数，
  `bin/CC-Monitor-hook <mode>` 新增 `prompt`/`session_start`/`session_end`/
  `precompact`/`stop`/`subagent_stop` 六种 mode；`install.py` 的 `merge_hooks()`
  改成用 `extra_hooks` 字典批量注册，新老用户重跑一遍 `install.py`/`install.sh`
  就会补上这几条（已装的 `PreToolUse`/`PostToolUse`/`PermissionRequest` 不动）。
  事件分别落到 `source="hook_prompt"`（`UserPromptSubmit`）和
  `source="hook_lifecycle"`（其余 5 个），`cc_monitor/format.py` 和
  `webui/lib/format.js` 同步加了对应的 `TOOL_LABELS`/`STAGE_LABELS`/`describe()`
  分支，Web UI 的 `i18n.js` 也补了中英文标签——首页"日志类型分布"、Log 审计页、
  终端 `CC-Monitor tail` 都能直接看到这些新事件，不需要额外改 UI 代码（沿用
  `events` 表已有的通用 source/tool_name/detail 结构）。用独立 `CC_MONITOR_HOME`
  测试目录端到端验证过 6 个 hook 的 stdin→SQLite 落库全过程，以及 Python/JS 两份
  `describe()` 输出完全一致。

## [1.6.0] - 2026-09-14

### 新增
- **npm 安装统计新增本地安装识别，不再只认全局**：`default_rules.json` 新增
  `npm_local_install` 规则（`risk: low`, `action: log`），匹配不带 `-g`/`--global` 的
  `npm install`/`npm i`，排在已有的 `npm_global_install`（`risk: medium`,
  `action: confirm`）后面，全局规则先命中的命令不会重复计到本地这边。以前本地
  `npm install` 完全没有任何规则覆盖——不拦截、不记录、不统计，首页"软件安装
  统计"里的"npm 全局安装"卡片对本地安装是彻底的盲区，即使 `npm install` 的
  `preinstall`/`postinstall` 生命周期脚本跟全局安装是同一个执行权限、同样是真实
  存在的供应链投毒入口（`event-stream`、`ua-parser-js` 这些真实事件都是本地安装
  阶段就已经中招，不需要等到全局安装那一步）。首页卡片文案改成"npm 安装"（原来是
  "npm 全局安装"），数字是本地+全局的合计；点开详情不会把两种混在一起平铺，而是
  分成"全局安装"/"本地安装"两组分别列出——风险等级不一样的东西不该在界面上看起来
  一样重。`INSTALL_RULE_GROUPS.npm` 同步更新为两条规则的并集。用真实
  WebSocket/无头浏览器验证过：首页卡片数字正确合并，点开详情两组分类完全正确
  （`sudo npm install -g pm2`、`npm install -g ccstatusline` 归到"全局"，
  `npm install`、`npm install lodash --save`、`npm i react` 归到"本地"）。已有用户
  的 `~/.cc-monitor/rules.json` 是首次运行时拷的副本，不会自动更新——想要这条新
  规则生效，删掉它让它重新生成，或者手动加进去。
- **"终端会话"新增"新建窗口"按钮**：跟"新建会话"共用同一个选工作目录的弹窗
  （弹窗标题/说明文字跟着按钮动态换），唯一的行为区别是不会自动往新建的 PTY 里
  敲 `claude\r`——原来"新建会话"打开的窗口固定会自动进 Claude Code 会话，单纯
  想要个终端跑跑脚本、看看文件的场景之前没有对应的入口。`SessionManager.
  create()` 新增 `launchClaude`（默认 `true`，不传就是原来的行为）参数，
  `POST /api/sessions` 透传 `launchClaude: false` 即可跳过。语言切换时弹窗的
  动态标题/说明文字也会跟着重新套用当前语言（复用 `syncGridToggleBtnText()`
  这些"状态相关文案"函数同一个模式，不能只靠 `data-i18n` 静态属性）。用真实
  WebSocket 连接分别抓了两种模式下的终端输出对比：`launchClaude:false` 只有
  裸 shell 提示符，`launchClaude:true` 能看到 `claude\r` 被写入终端。
- **世界地图新增"本机 ↔ 目的地"连线弧光点动画**：参考
  [BeeEye](https://github.com/cn0xroot/BeeEye)（同一个作者的另一个项目）的
  `WorldMap.jsx` 直接移植——每条连接画一条从示意起点到目的地的二次贝塞尔弧线
  （`arc2d()`，往极点方向鼓一点，有大圆航线的弧度感），头部带一个跑动的光点：
  方向跟着这条连接上传/下载哪个字节数更多走（下载为主时光点从目的地往回跑，
  推断出来的命令文本目标没有真实字节数，默认往外跑），2.2 秒一个周期，光点
  用独立一次 `drawArrays` 批量画（复用目的地发光点同一套 `pointProg`/
  `FRAG_POINT` 着色器），不是只给弧线本身调透明度——第一版只调透明度做的效果，
  实测截图确认过肉眼基本看不出哪段更亮，加了这个独立光点才是真的"看起来在跑"。
  "本机"在这张图上没有真实地理位置可言（这是运行 Claude Code 的这台机器，不是
  流量真正经过的公网出口），固定钉在 (0, 0)（南大西洋几内亚湾外海，"Null
  Island"）——不会为了这个另外发请求去问"我的公网 IP 在哪"，那样等于把用户的
  真实位置发给了第三方，图例里明确标注这不是真实位置。WebGL2 不可用时自动退化
  成 Canvas 2D 画同一套内容（海岸线/弧线/光点/发光点全都有，用
  `globalCompositeOperation='lighter'` 模拟 GL 那边的加法混合），地图不会因为
  拿不到 WebGL2 就整个消失。用无头浏览器实测截图验证过两条渲染路径：GL 模式和
  2D 模式下光点都正确沿弧线移动、方向都正确（上传为主的连接往外跑，下载为主的
  从目的地往回跑）。
- **首页新增"SSH 操作统计"和"下载行为统计"**：SSH 操作拆成 ssh（远程登录/执行）/
  scp（文件复制）/ sftp（文件传输）/ 密钥管理（`ssh-keygen`/`ssh-copy-id`/`ssh-add`/
  `ssh-agent`）/ 其它（`autossh`/`sshpass`）五张卡片；下载行为拆成 wget / curl（只在
  带 `-o`/`-O`/`--output` 落盘参数时才算，裸 curl 调 API 不算）/ aria2 / 其它
  （`axel`/`lftp`/`ftp`/`http`）四张卡片。识别方式跟已有的 GitHub 操作统计
  （`classifyGithubOp`）完全一致：按 `;`/`&`/`|`/换行拆成子命令，只看子命令开头，
  不对整条命令文本做子串匹配。新增 `webui/lib/audit.js` 的 `cc_ssh_op`/
  `cc_download_op` SQL 自定义函数，`/api/drilldown/ssh-op/:type`、
  `/api/drilldown/download-op/:type` 接口。
- **"AI 轨迹"卡片和世界地图新增命令文本推断的网络目标**：之前"AI 轨迹"完全依赖
  系统层探针（eBPF/nettop）的实测数据，很多人从没手动启动过探针（需要额外
  `sudo ./bin/CC-Monitor-probe`），即使 Claude 明明执行过一堆 wget/curl/git clone/
  ssh/scp 这类联网命令，这张卡片和世界地图也一直是空的。现在会从这些命令的文本里
  提取目标主机名（`extractCommandHosts()`：URL 里的 host、`user@host` 形式、
  `host:path` 形式，特意不认裸主机名——第一版曾经把 `curl -o out.tar.gz ...` 的
  输出文件名、`scp file.txt user@host:/path` 的本地源文件名都当成了"主机名"，因为
  这些字符串本身也是带点的、后面跟着空白，形状上没法用纯正则跟真主机名区分开，
  收紧成"必须有 `@` 前缀或紧跟冒号"两种明确写法后才不再误判），惰性 DNS 解析
  （`dnscache.js`，带缓存和超时，不在 hook 里做——避免拖慢每次 Bash 调用）+ 查
  GeoIP，跟探针实测数据合并进同一套 `network.js` 的 `listTraffic()`/`summary()`/
  `geoPairs()` 管线，用 `inferred:true` 标记，前端渲染成"推断"徽章（不会冒充成
  探针确认过的真实流量——命令有没有真的连通、字节数多少都无法得知）。已实测验证
  完整链路：真实 DNS 解析 github.com/example.com 到正确 IP、GeoIP 查到 Toronto/
  Singapore、"AI 轨迹"下钻里 Session/文件夹信息正确关联到发起命令的会话。
- **首页新增"截屏审计"卡片**：Claude Code 没有内置"截图"工具，识别靠三条独立信号——
  ① Bash 命令调用截图类 CLI 工具（`scrot`/`gnome-screenshot`/`import`/`spectacle`/
  `flameshot`/`maim`/`grim`/`xwd`、macOS 的 `screencapture`，以及 Wayland 下常见的
  `gdbus`/`dbus-send` 调用 `org.freedesktop.portal.Screenshot`，判断方式跟已有的
  `commandDeletesFiles()` 一个思路，按 `;`/`&`/`|`/换行拆成子命令分别看开头，不对
  整条命令文本做子串匹配，避免 `echo` 输出内容被误判）；② `Read` 工具打开的文件
  本身是图片（`.png`/`.jpg`/`.gif`/`.webp`/`.bmp`，范围比纯截图宽——用户明确要求
  把"查看已有图片内容"也算进来）；③ MCP/"computer use" 类工具的截图动作（工具名
  带 `screenshot` 字样，比如 Playwright/Puppeteer 这类浏览器自动化 MCP server 暴露
  出来的工具，或者 Anthropic Computer Use 的 `computer` 工具、`action` 字段等于
  `"screenshot"`）。新增 `webui/lib/audit.js` 的 `cc_is_screenshot` SQL 自定义函数、
  `/api/drilldown/screenshot` 接口。点开详情**只显示命令/文件路径等基本信息，不
  读取、不展示截图本身的图像内容**——这是用户明确要的尺度，截图很可能带敏感桌面
  信息，网页详情页不该把它 serve 出来。用隔离测试数据库 + 无头浏览器验证过端到端
  链路：首页卡片计数正确、点击详情正确列出匹配事件、不匹配的普通命令（`ls -la`、
  纯文本文件读取）正确排除在外。
- **新增 kill/pkill 监控进程检测规则**：`default_rules.json` 新增两条规则——
  `kill_monitoring_process`（`risk: high`, `action: confirm`）专门匹配
  `kill`/`pkill`/`killall` 后面跟着 CC-Monitor 自身进程名（探针二进制、
  `probe_linux.bt`/`probe_darwin.py`、`cc_monitor.probe`、`bpftrace`）的命令——
  这是"正在试图关掉安全监控本身"这个场景，用 `confirm` 而不是 `block`，因为
  正常维护/重启探针本来就是合理操作，不该被硬拦截，只是需要人确认一下；通用的
  `kill`/`pkill`/`killall`（`process_kill`，`risk: low`, `action: log`）单独放
  在后面兜底，只做记录不打扰，`kill`/`pkill` 在日常开发里太常见，全部要求确认
  会造成警报疲劳。两条规则插在 `disable_security_controls` 和 `sudo_pip_install`
  之间，规则顺序保证专门针对 CC-Monitor 自身进程的这条先匹配。已有用户的
  `~/.cc-monitor/rules.json` 是首次运行时拷的副本，不会自动更新，想要这两条新
  规则生效，删掉它让它重新生成，或者手动加进去。
- **首页新增"Docker 操作统计"**：跟 SSH/下载行为统计同一套思路，按 `;`/`&`/
  `|`/换行拆成子命令只看开头，拆成 run（启动容器）/ build（构建镜像）/ exec
  （进入容器执行）/ compose（`docker compose`/`docker-compose`）/ 其它
  （`ps`/`logs`/`images` 等只读查看类）五张卡片。run/build/exec 单独拆出来是
  因为这三个是"会执行任意外部镜像/Dockerfile/容器内命令"，风险跟纯只读查看不是
  一个量级。新增 `webui/lib/audit.js` 的 `classifyDockerOp`/`dockerOpsStats`/
  `dockerOpsDetails`、`cc_docker_op` SQL 自定义函数，`/api/drilldown/docker-op/:type`
  接口。用隔离测试数据库验证过 9 条真实命令（含一条 `echo "docker run..."` 的
  字符串输出，确认不会被误判成真的执行了 docker run）分类结果全部正确，用无头
  浏览器截图验证过首页卡片计数和点击详情弹窗都正确。
- **敏感文件读取检测扩展到 Bash 命令**：之前 `sensitive_file_read` 规则只覆盖
  `Read` 工具直接打开 `.ssh/`/`.aws/credentials`/`.env`/私钥等敏感路径的场景，
  用 `cat`/`less`/`head` 等 Bash 命令读同样的文件完全是盲区。新增
  `sensitive_file_read_bash`（`risk: medium`, `action: log`）覆盖
  `cat`/`less`/`more`/`head`/`tail`/`strings`/`xxd`/`hexdump`/`od` 后面跟着这些
  敏感路径的命令；另外新增 `env_dump`（`risk: low`, `action: log`）记录
  `env`/`printenv`/`export -p` 这类会把当前进程全部环境变量（可能包含 API key/
  token）打印到终端的命令。两条都插在已有的 `sensitive_file_read` 和
  `system_config_write` 之间。这几条规则复用了 `policy.py` 现有的 `re.search`
  纯正则匹配，没有像 webui 那边的 `splitShellSegments()` 一样做引号/heredoc
  感知——这是 Python 策略引擎全部 30+ 条规则共有的既有特点，不是这几条新规则
  引入的新问题，之后如果要修，得是对整个策略引擎的单独改造，不在这次范围内。
  同样地，已有用户的 `~/.cc-monitor/rules.json` 不会自动更新，想要这两条新
  规则生效需要手动同步。
- **新增 `su`/`pkexec` 提权检测**：之前只有 `sudo_usage` 这一条规则覆盖提权场景，
  `su`/`pkexec` 这两个跟 `sudo` 效果等价（切换/以其它用户身份执行命令，通常是
  root）的提权方式完全漏检。新增 `su_pkexec_privilege_escalation`
  （`risk: medium`, `action: confirm`），只认命令开头或 `;`/`&&`/`||` 之后紧跟的
  `su`/`pkexec`（写法跟已有 `sudo_usage` 的 `(^|;|&&|\|\|)\s*sudo\b` 完全一致），
  不会把 `echo su` 这类字符串输出、或 `subprocess.run(...)` 里当成普通标识符出现的
  "su" 误判成真的在提权。插在 `sudo_usage` 后面。
- **新增单文件 `chmod 777`（非递归）检测**：原来 `chmod_world_writable_recursive`
  只认目标路径以 `/` 或 `~` 开头的写法，`chmod_recursive_generic` 只认带 `-R` 的
  调用——`chmod 777 file.txt`（相对路径、单文件、不递归）这种真实存在的场景恰好
  两条都没覆盖到。新增 `chmod_777_single_file`（`risk: medium`, `action: confirm`），
  插在 `chmod_recursive_generic` 之后，靠规则顺序保证只在前两条都没命中时才轮到它
  （带 `-R` 的、目标是 `/`/`~` 开头的都已经在更早的规则里被更高级别处理过，不会
  重复触发或降级）。
- **新增数据库直连破坏性命令检测**：`mysql`/`psql`/`redis-cli`/`mongo`/`mongosh`/
  `sqlite3` 这类数据库命令行客户端接 `DROP`/`DELETE`/`TRUNCATE`（SQL）或
  `FLUSHALL`/`FLUSHDB`（Redis）之前完全没有任何规则覆盖——能直接读写生产数据，
  风险性质跟"删文件"是一回事，但完全在雷达外。新增 `db_destructive_command`
  （`risk: high`, `action: confirm`），插在 `history_tampering` 和
  `docker_privileged_or_host_mount` 之间。用 23 个正负测试用例验证过匹配和跟
  既有规则的优先级交互（比如 `chmod -R 777 subdir` 正确命中更早的
  `chmod_recursive_generic` 而不是新规则，`chmod 777 ~/.ssh/id_rsa` 正确命中
  `chmod_world_writable_recursive`），`node --test` 5/5 全部通过，不是回归。
  这三条同样复用 `policy.py` 现有的纯正则匹配，没有 webui 那边的引号/heredoc
  感知，理由跟上面 `sensitive_file_read_bash`/`env_dump` 一致；已有用户的
  `~/.cc-monitor/rules.json` 同样不会自动更新。
- **新增历史指令读取检测**：`cat ~/.bash_history`/`cat .history` 这类读取 shell
  历史文件的命令、以及直接执行裸 `history` 命令（会把当前会话的历史命令原样打印
  到 stdout），之前完全没有规则覆盖——命令历史里经常留着过去输入过的密码/token
  等明文凭据，是真实存在的信息泄露路径。新增 `history_read`（`risk: low`,
  `action: log`），覆盖 `cat`/`less`/`more`/`head`/`tail`/`strings` 读取
  `.bash_history`/`.zsh_history`/`.python_history`/`.mysql_history`/
  `.psql_history`/`.node_repl_history`/任意 `*.history` 文件、以及命令开头或
  `;`/`&&`/`||` 之后紧跟的裸 `history`（`history -c` 这种清空历史的破坏性用法
  已经由更早的 `history_tampering` 规则单独覆盖，靠规则顺序 + 显式排除
  `(?!\s*-c\b)` 避免重复触发）。插在 `history_tampering` 之后。用 13 个正负
  测试用例验证过匹配和优先级，不是回归。
- **加强反弹 shell / 后门执行检测**：原来的 `reverse_shell_pattern` 只认
  `nc ... -e /bin/sh` 这一种写法，覆盖面偏窄——真实攻击/红队工具箱里还有好几种
  常见变体完全漏检：`nc`/`ncat`/`netcat` 换用 `-c` 而不是 `-e`（部分 nc 变体的
  执行命令写法）、`ncat`/`netcat` 这两个 nc 的别名工具本身没被认到、`socat` 用
  `exec:` 目标做反弹 shell（很多加固过的系统没有带 `-e` 支持的 nc，`socat` 是
  最常见的替代品）、以及不带 `-e`/`-c` 参数、靠 `mkfifo` 建一个命名管道配合
  `nc`+shell 手动拼出来的反弹 shell（更隐蔽，规避了对 `-e`/`-c` 参数的检测）。
  扩展了 `reverse_shell_pattern` 的正则覆盖这四种新变体，`risk`/`action` 维持
  原来的 `high`/`block` 不变。用 17 个正负测试用例验证过匹配（含原有 `nc -e`/
  `/dev/tcp`/`sh -i` 写法必须继续命中，不能因为改动引入回归；以及 `nc -zv`/
  `nmap`/`ncat --ssl` 这类正常网络诊断用途不能被误伤）。范围上刻意不做的：
  Python/Perl/PHP/Ruby 这类脚本语言的一行反弹 shell（`python3 -c
  "import socket,subprocess..."`）——这类命令的"危险性"完全取决于脚本内容的
  语义，纯正则匹配要么漏掉绝大多数变体、要么把大量合法用到 `socket` 模块的
  脚本也拦下来，误报代价太高，不在这次范围内。
- **首页新增"压缩/归档操作统计"**：跟 SSH/下载/Docker 操作统计同一套思路，拆成
  tar / zip（含 unzip）/ 7z / gzip（含 gunzip/zcat）/ 其它
  （bzip2/xz/zstd/rar 等）五张卡片，按 Bash 命令文本识别。新增
  `webui/lib/audit.js` 的 `classifyArchiveOp`/`archiveOpsStats`/
  `archiveOpsDetails`、`cc_archive_op` SQL 自定义函数，
  `/api/drilldown/archive-op/:type` 接口。
- **首页新增"网络诊断工具统计"**：nc（含 ncat/netcat 别名）/ nmap / telnet /
  其它（socat）四张卡片，纯粹是"用过这些工具没有"的可见性统计，跟上面的反弹
  shell 风险判断是两回事——`nc -zv example.com 443` 这种正常端口探测也会被计入
  这张卡片，不代表危险。新增 `classifyNetdiagOp`/`netdiagOpsStats`/
  `netdiagOpsDetails`、`cc_netdiag_op` SQL 自定义函数，
  `/api/drilldown/netdiag-op/:type` 接口。
- **首页新增"进程管理/后台驻留统计"**：nohup / disown / 后台任务（命令末尾裸
  `&`）/ 其它（setsid）四张卡片。前两个按子命令开头识别，跟其它分类器一个思路；
  "后台任务"不一样——裸 `&` 不是某个命令的名字，是整条命令末尾的 shell 语法
  标记，`splitShellSegments()` 本身会把单个 `&` 当分隔符切开，没法通过"看子命令
  开头"识别，改成直接在原始命令文本上找"独立的 `&`"：前面不能紧跟 `&`/`>`（排除
  `&&`、`2>&1`、`&>` 这些不是真正后台标记的写法），后面不能紧跟数字/`&`/`>`
  （同样排除文件描述符重定向），且这个 `&` 后面（跳过空白）直接是命令末尾或
  `;`——故意收窄换取不误伤 `curl 'http://x.com/a&b=c'` 这类 URL 查询字符串里的
  `&`，代价是 `task1 & task2`（后台之后紧接着写下一条命令、中间没有 `;`）这种
  少见写法会漏检。新增 `classifyProcessBackground`/`procbgOpsStats`/
  `procbgOpsDetails`、`cc_procbg_op` SQL 自定义函数，
  `/api/drilldown/procbg-op/:type` 接口。
- **首页新增"子代理派生"统计卡片**：跟 MCP/Skill 调用统计同一个思路，只是分组
  字段换成 `tool_input` 里的 `subagent_type`（`general-purpose`/`Explore`/
  `Plan`/`fork`，或者用户自定义的子代理名字）。Claude Code 不同版本这个工具名
  叫 "Task" 还是 "Agent" 不完全一致，两个都认。子代理会消耗独立资源、有自己的
  一整套操作轨迹，之前完全混在笼统的"工具调用"计数里，没有单独可见性。新增
  `subagentCallStats`/`subagentCallBreakdown`/`subagentCallEvents`，
  `/api/drilldown/subagent-calls` 接口，复用 `mcpCallBreakdown`/
  `skillCallBreakdown` 已有的 SQL `json_extract` 分组手法。
  以上四个统计卡片 + 反弹 shell 检测扩展 + 历史指令读取检测都用隔离测试数据库
  （压缩/网络诊断/后台驻留三个分类器还额外验证了 `curl` URL 查询字符串里的 `&`、
  `cmd1 && cmd2`、`echo '...'` 这几种已知误判来源正确排除在外）+ 无头浏览器截图
  验证过端到端链路：首页卡片计数正确、点击详情正确列出匹配事件。`node --test`
  5/5 全部通过，不是回归。
- **首页折叠 GitHub/SSH/下载/Docker/压缩/网络诊断/进程管理这七组统计卡片**：
  这七组原来每组都是一整排细分类卡片（合计 6+5+4+5+5+4+4 = 33 张），叠在一起
  刷屏太厉害。改成每组只放一张汇总卡片（数字是这组所有分类的合计），点开才展示
  分类小计表 + 完整命令明细（每条前面挂一个分类徽章），交互模式跟已有的
  MCP/Skill/子代理调用卡片保持一致。`webui/lib/audit.js` 把七组各自的
  `xxxOpsStats()`/`xxxOpsDetails(type)` 换成两个通用函数
  `opsBreakdown(sqlFn)`/`opsEvents(sqlFn)`（七组背后本来就是同一个"按
  `cc_xxx_op()` 自定义 SQL 函数分类、`GROUP BY kind`"的查询形状，只是传的函数名
  不同，抽出来减少了约 190 行重复代码）；`server.js` 对应把 14 个 `/api/drilldown/
  xxx-op/:type` 单分类接口换成 7 个 `/api/drilldown/xxx-ops`（不带 `:type`）
  接口，一次性返回 `{breakdown, events}`；首页卡片总数改成读
  `sumN(audit.xxxOpsBreakdown())`。原来这七组专用的 `GITHUB_OP_TYPES` 等
  仅用于校验 URL `:type` 参数的常量、`drilldown.githubOp.suffix` 这个不再被
  引用的 i18n key 一并删除，没有留背景兼容代码。用隔离测试数据库 + 无头浏览器
  截图验证过：首页从 7 排 33 张卡片变成 1 排 7 张卡片，点开任意一张（截图验证的
  是 GitHub 操作）正确显示分类小计表和带语法高亮的命令明细列表，`node --test`
  5/5 全部通过，不是回归。

### 修复
- **命令分类器误报：heredoc/引号内多行字符串被当成多条独立子命令**：截屏审计、
  GitHub/SSH/下载操作统计、AI 轨迹的命令主机名提取等好几个分类器，共用同一套
  "按 `;`/`&`/`|`/换行拆成子命令再看开头"的判断方式，天真的换行切分有个漏洞——
  双引号参数、heredoc（`<<'EOF' ... EOF`）正文里的换行是内容本身的一部分，不是
  shell 语法意义上的命令分隔符。线上这台机器自己的审计数据抓到两个真实案例：
  `python3 -c "\nimport json,sys\n..."` 这种命令里，双引号参数中单独成一行的
  `import json,sys` 被当成了 ImageMagick 截图命令 `import` 的调用；
  `git commit -m "$(cat <<'EOF' ... EOF)"` 里，heredoc 正文中 word-wrap 过的一行
  （刚好是本项目上一条 commit 描述截图功能时提到的 "spectacle" 截图工具名）被
  当成了真的在调用 `spectacle` 截图——"误报太多"的用户反馈根源就在这里。新增
  `splitShellSegments()`，用一个简化版的 shell 分词器（跟踪当前在不在单/双
  引号、在不在 heredoc 正文里）替换所有分类器里原来的 `cmd.split(/[;&|\n]+/)`，
  只有真正在"顶层"的分隔符才切分。顺手把 `import` 从截屏 CLI 识别列表里删掉
  （ImageMagick 的 import 命令在现代 Linux 桌面上已经边缘化，"import" 又是
  Python 极常用的关键字，即使分词修好了也不值得为了这一个命令保留这个碰撞
  风险）。用两个真实复现案例验证过：改之前两条误报都会命中，改之后都正确排除，
  真的 `scrot`/`gnome-screenshot` 调用依然正确识别；其它分类器（GitHub/SSH/
  下载操作统计）跑现有的单元测试全部结果不变，不是回归。

## [1.5.0] - 2026-09-13

### 新增
- **AI 审批台接管 Claude Code 原生确认框**：新注册 `PermissionRequest` hook（`install.py`
  重跑会自动补上这一条，已有的两条不动）。以前审批台只镜像规则表里 `confirm` 的操作，
  Claude Code 自己要弹的 "Do you want to proceed?"（没命中任何规则的那些）在网页上完全
  看不到——`PreToolUse` 阶段根本不知道它接下来会不会弹。现在这类询问以 `kind='permission'`
  出现在审批台，按钮跟 confirm 一样（允许/拒绝/10、30 分钟/一直允许，"一直允许"按
  `session + 工具名` 记），网页或终端给了答案就通过 `hookSpecificOutput.decision.behavior`
  替用户答掉；没人答（90s 超时）或终端里敲回车，hook 静默退出、原生确认框照常弹出。
  审批历史新增 "已转回原生确认框" 状态。
- **macOS 系统层探针（网络部分）**：新增 `cc_monitor/probe_darwin.py`，`bin/CC-Monitor-probe`
  在 macOS 上自动切过去。用系统自带的 `nettop -d -L 0` 每 2 秒采样 claude 进程树（claude
  + 子进程，每次采样重新算）每条连接的远端 IP:port 和上传/下载字节增量，写进跟 Linux
  探针同一张 `network_traffic` 表和同一种 `os_net` 事件，网络流量页/世界地图/AI 轨迹在
  Mac 上不再永远是空的。不需要 root。没有 `execve` 观测（`verify` 的绕过检测仍是 Linux
  独有），域名只能靠反向 DNS 兜底。SIGTERM 时会把 nettop 子进程一起收掉。
  Web UI 上网络页的几条提示文案改成会告诉你"去跑 bin/CC-Monitor-probe"，并提到走本地
  代理时远端全是 127.0.0.1、地图上不会有点这种情况。
- **`install.sh` 自动安装并接线 ccstatusline**：新增第 1 步，检测系统上有没有
  [ccstatusline](https://github.com/sirmalloc/ccstatusline)（`command -v ccstatusline`），
  没有就 `npm install -g ccstatusline`；装好后如果 `~/.claude/settings.json` 里还没有
  `statusLine` 配置，`install.py` 的 `configure_statusline()` 会自动写入一份（`command:
  "ccstatusline"`，`padding: 0`，`refreshInterval: 10`）。两个条件都要满足才会真的写——
  没装就不接（接了也是空跑），已经有 `statusLine`（不管是不是 ccstatusline、不管什么参数）
  就绝不覆盖，尊重用户已有的定制。`--skip-ccstatusline` / `CC_MONITOR_SKIP_CCSTATUSLINE=1`
  能把安装和接线两件事一起跳过（内部会转成 `install.py --skip-statusline` 透传下去）。
  GeoIP 数据库下载顺延成第 5 步。
- **`install.sh` 第 5 步自动下载 GeoIP 数据库**：DB-IP Lite（CC BY 4.0，约 60MB）下到
  `~/.cc-monitor/dbip-city.mmdb`（尊重 `CC_MONITOR_HOME`）。已有任何 `.mmdb` 就跳过；
  先下到 `.part` 再改名、小于 1MB 视为失败并删掉，不会留半截文件让 geoip.js 静默打不开；
  失败只提示不中断。`--skip-geoip` / `CC_MONITOR_SKIP_GEOIP=1` 跳过，`CC_MONITOR_GEOIP_URL`
  换镜像。

- **`system_package_install` 规则覆盖 macOS 的包管理器**：`brew install/reinstall/uninstall/
  remove/rm/upgrade/tap/untap/bundle`（含 `brew cask …`）和 MacPorts 的 `port [-flags]
  install/uninstall/upgrade/activate/deactivate/selfupdate`（`port installed`、`lsof -i :port`
  这类不会误命中）。首页"软件安装统计"的"系统包管理器"卡片标签同步。顺手修了 `pacman
  -Syu` 不命中的问题（原正则要求 S/R 是最后一个字母）。已有用户的 `~/.cc-monitor/rules.json`
  是首次运行时拷的副本，不会自动更新——想要新规则的话删掉它让它重新生成，或者手动改。

### 修复
- **桌面版（Electron）在 macOS 上 AI 审批台完全没有提醒**：页面里走的是浏览器 Notification
  API，Electron 渲染进程里 `Notification.permission` 永远是 "granted"、`new Notification()`
  也不报错，但底层 UNUserNotificationCenter 对未正式签名的 app（`npm run electron` 用的
  node_modules 里那个 Electron.app 只有 ad-hoc 签名）直接拒绝，实测主进程侧是 failed 事件
  `UNErrorDomain error 1`（NotificationsNotAllowed），渲染进程侧静默失败。改为主进程自己
  每 2 秒轮询 `pending_approvals`：新请求 → `shell.beep()` + Dock 图标跳动 + 角标数字（这
  三样不需要任何授权），能弹系统通知就一并弹（点击跳到审批台），弹失败只警告一次不再重试。
  页面按 UA 识别 Electron 后关掉浏览器那条路，按钮改成说明文字，避免两边重复。
- **Web 终端"新建会话"直接 500（`posix_spawnp failed.`）**：node-pty 靠
  `prebuilds/<平台>/spawn-helper` 这个小程序起 pty，npm 解包时（实测 macOS + npm 11）
  会丢掉它的可执行位。新增 `webui/scripts/fix-node-pty-perms.js`，作为 `postinstall`
  跑一次，`lib/sessions.js` 加载时再幂等地跑一次（打包后没有 postinstall）。
- **macOS 上额度/套餐永远显示"没找到 Claude Code 的登录凭证"**：Claude Code 在 macOS 上
  不写 `~/.claude/.credentials.json`，OAuth 凭证存在登录钥匙串里（service
  `Claude Code-credentials`，内容是同一份 JSON）。全新的 Mac 必现。新增
  `webui/lib/credentials.js`：先读文件，没有再 `security find-generic-password -s
  "Claude Code-credentials" -w` 读钥匙串，`usage.js`/`account.js` 共用。跟有没有装
  ccstatusline 无关——我们不调用它，只是复刻它的读取逻辑（它在 macOS 上走的正是钥匙串）。
- **macOS 上终端里永远看不到 CC-Monitor 的 `[y/N]` 确认提示**：`notify.py` 用文本模式
  `open("/dev/tty", "r+")`，这会套一层要求可 seek 的 BufferedRandom；Linux 上对 tty
  `lseek` 返回 0 所以没事，macOS 返回 `ESPIPE`，`open()` 直接抛 `io.UnsupportedOperation`
  （`OSError` 子类）被静默吞掉，tty 一直是 None，只剩网页一条路。改成 `"r+b", buffering=0`
  的裸 FileIO。
- **终端处于 raw 模式时敲 y/N 可能把 hook 卡死**：Claude Code 的 TUI 让终端处于 raw 模式，
  回车发过来的是 `\r` 不是 `\n`，原来的 `readline()` 会一直等那个不来的换行，连网页那条
  路的轮询也一起卡住。改为直接读当前可读的字节、看首字符。

## [1.4.3] - 2026-09-13

### 新增
- **发布编译好的 Linux x64 二进制**：GitHub Release 现在附带打包好的
  `CC-Monitor-*.AppImage`，配一个 `cc-monitor-start.sh` 启动包装脚本——AppImage
  是单个可执行文件，双击/直接运行时不经过任何 npm 脚本，v1.4.2 里给 `npm run
  electron` 用的 node launcher 在这种运行方式下用不上（那个 launcher 依赖的是
  npm 脚本这一层，AppImage 根本不经过它）。这个脚本按运行身份决定要不要给
  AppImage 加 `--no-sandbox --disable-gpu-sandbox`，是 root 才加，其它身份原样
  启动，沙箱保护不受影响。已实测验证：直接双击/裸跑 AppImage 在 root 下依旧会
  FATAL 退出，必须用这个包装脚本或者手动加这两个参数启动。

### 修复
- **`electron-main.js` 里遗留的 root 沙箱兜底代码其实完全不起作用**：v1.4.2 里
  留了一段"就算 launcher 没生效，这里再兜底加一次 `--no-sandbox`"的代码，实测
  验证发现这段 JS 根本没有机会在 Chromium 的原生 FATAL 检查前执行到——这个检查
  发生在 Electron 启动的原生阶段，比 `electron-main.js` 里任何一行 JS（包括文件
  最开头）都早，连"在最开头用 Node 自己重新拉起带参数的自己"这种自愈写法都测过，
  同样来不及。删掉了这段无效代码，改为纯注释说明：这个开关只能从外部、在真正
  spawn 出 electron 进程之前带入 argv，`npm run electron` 走
  `scripts/electron-start.js`，打包后的二进制走上面新增的 `cc-monitor-start.sh`。

## [1.4.2] - 2026-09-13

### 修复
- **`npm run electron` 在 root 下无法启动**：Chromium 在原生启动阶段就会检查是否
  以 root 身份运行且没带 `--no-sandbox`，不满足直接 FATAL 退出——这个检查比
  `electron-main.js` 里任何 JS 代码都先执行，运行时用 `app.commandLine.
  appendSwitch()` 加这个开关完全没用，必须在真正 spawn electron 二进制那一刻
  的进程参数（argv）里就带上。解决这层后又暴露第二层：GPU 进程有自己独立的
  沙箱，root 下同样会失败（`GPU process isn't usable. Goodbye.`），还得加
  `--disable-gpu-sandbox`。新增了一个小 launcher 脚本（`webui/scripts/
  electron-start.js`），按 `process.getuid()` 判断身份，只有真的是 root 时才
  附加这两个开关，非 root 用户运行时完整沙箱保护不受任何影响。已在当前 root
  环境下用 `wmctrl`/`xdotool` 验证真实起了标题为 "CC-Monitor" 的独立窗口。

## [1.4.1] - 2026-09-13

### 修复
- **界面字号设置之前不是真正全局生效**：样式表里 62 处按钮/卡片数字/表格文字等
  的字号是写死的 px，只改 `body` 自己的 `font-size` 根本碰不到它们，调节滑块时
  页面看起来"没什么变化"。修复过程中还发现一个连带问题：把这 62 处全部换成相对
  根字号的 `rem` 单位后，第一版验证时发现即使 CSS 变量本身已经正确更新，
  `<html>` 的实际字号还是纹丝不动——原因是 `html, body { ... font-size: 1rem }`
  这条联合选择器规则会同时套到 `html` 和 `body` 头上，而 `1rem` 用在根元素自己
  身上不是"相对自己"、是相对浏览器默认的 16px，这条规则排在后面，把专门给
  `html` 写的字号规则覆盖掉了。现在用全新浏览器验证过：默认 14px 时按钮是
  13px、卡片数字 28px；调到 18px 后按钮变成 16.7px、卡片数字变成 36px——整站
  所有文字同比例联动缩放。
- **界面字体设置对导航栏/按钮类文字不生效**：`<button>`/`<select>`/`<input>`/
  `<textarea>` 这几个表单控件元素，浏览器自己的默认样式表压根不会让它们继承正文
  的 `font-family`（会摆烂用系统 UI 控件字体，实测是 Arial），这是每个浏览器的
  标准行为，不是继承链断了——"首页"/"状态信息"这些导航按钮、"新建会话"这类按钮
  换字体跟没换一样，根因就是这个。加一条 `button, input, select, textarea {
  font-family: inherit; }` 就解决了，截图验证过导航文字确实跟着变成楷体的手写
  笔画风格。

### 新增
- **界面字体新增三个中文选项**：楷体、黑体（思源黑体）、宋体（思源宋体）。没有
  把字体文件打包进项目——完整 CJK 字库一个 17～21MB，直接打包会让首次切字体的
  下载很慢——改成纯字体名引用，访问者的系统/浏览器本地装了对应字体就会生效
  （这台 Linux 机器本身已经装了 AR PL UKai/UMing、Noto Sans/Serif CJK、霞鹜文楷
  这些开源中文字体，同机或同局域网内访问能直接命中；Windows 的"微软雅黑"/
  "宋体"、Mac 的"苹方"/"华文楷体"也在各自字体栈里）。没有加"柳体"——系统上没有
  真正的柳公权风格书法字体，网上找到的几款标榜"柳体"的免费字体授权条款未经
  核实，不确定能不能安全打包，先跳过。

## [1.4.0] - 2026-09-13

### 新增
- **外观设置弹窗**（顶栏 ⚙ 按钮）：主题配色改成可视化色块网格（10 个主题各自的
  强调色圆点 + 高亮选中态），新增**界面字体**（系统默认/等宽/衬线/圆体）和
  **界面字号**（12～18px 滑块）两个之前完全没有的设置项，弹窗里带实时预览文字，
  两个新设置存 `localStorage`，刷新后保留；原来顶栏那个主题下拉框还在，两边保持
  同步，不是二选一的替换关系。
- **单次额度（5 小时窗口）改成显示"剩余百分比"**（原来是"已使用"），颜色换成
  conky 风格的分段色阶——5% 以下很红、85% 以上很绿，中间每 10% 一档，固定鲜艳色值，
  不跟主题走（这是专门给这一个进度条用的，跟其它额度条的连续渐变是两套独立配色）。
  其它额度条（周额度全部模型/Sonnet/Opus/Fable）颜色改成红→黄→绿连续渐变，换算
  成"健康度"（已用越多越红），渐变的三个锚点直接读当前主题的 `--red`/`--yellow`/
  `--green`，换主题这套颜色也跟着联动。所有额度卡片的文字标签都补上"已用"/"剩余"
  前缀，不会再看不出这个百分比到底是哪个方向。
- **Fable 模型的额度信息**：Anthropic 的用量接口没有给 Fable 专门的顶层字段（不像
  Opus/Sonnet 那样有 `seven_day_opus`/`seven_day_sonnet`），额度只挂在 `limits[]`
  里一条 `kind="weekly_scoped"` 的记录上——现在会动态从这条记录里摘取模型名和额度，
  不写死"Fable"，以后 Anthropic 加别的按模型限额也能自动跟着显示出来。
- **状态信息页新增"模型使用统计"表格**：按模型（Sonnet/Opus/…）汇总所有已监测会话
  的 token 用量（输入/输出/缓存/总计），同一 session 中途换过模型的话分开算。
- **状态信息页新增"额度明细（limits）"表格**（跟首页那份同一份数据），进度条也用
  加长加粗的版本；"重置时间"那一列新增一条紫色的"这个窗口已经过去多少"进度条。
- **状态信息页会话状态行新增"上下文窗口使用率"和"Context compaction 次数"**：前者
  是当前对话实际带着的上下文大小占比，按 200K 标准上下文窗口估算（Claude Code 只在
  它自己的 statusLine 输入里才带精确窗口大小，我们的 hooks 拿不到，这是近似值，
  UI 上用 hover 提示说清楚）；后者是真的从 transcript 里检测
  `type=system, subtype=compact_boundary` 事件数出来的，含自动/手动次数拆分和
  累计精简的 token 数，不是估算。
- **网络流量域名捕获改用 `uprobe:libc:getaddrinfo`**：之前只对连上的 IP 做事后反向
  DNS（PTR 记录），很多云厂商/CDN 出口 IP 根本没配 PTR，反向解析注定拿不到域名
  （实测 Anthropic 自己的 API IP 就是这样）；现在改成在应用层调用 `getaddrinfo()`
  解析域名的那一刻就用 uprobe 记下来，按 pid 存最近一次问的域名，接到 CONNECT 事件
  时直接查表——域名从连接真正发生之前就已经知道了，不管出口 IP 有没有配 PTR 都能
  拿到（用一个改名成 "claude" 的可执行文件模拟真实调用链，实测抓到了 Cloudflare
  出口 IP 上的 `example.com`，验证有效）。
- **网络流量页"连接次数"可以点开看明细**：每个目标地址一行的连接次数、以及页面
  顶部"总连接次数"/"不同 IP 数"两张汇总卡片，现在都能点开看这个目标/全部目标的
  每次连接时间、发起进程、PID。
- **首页新增"GitHub 操作统计"**：git push / git clone / git commit / git pull-fetch
  / gh CLI（PR/Issue/API…）/ 其它 git 操作六张卡片。大部分 git/gh 命令本来就不会
  命中任何规则（不违反任何 policy，压根不会打上 `matched_rule`），没法像软件安装
  统计那样直接复用规则引擎的判断结果，改成新写一个按子命令分类的识别函数（`;`/
  `&`/`|`/换行 切开分别看开头，避免把 `echo "git push 很危险"` 这种字符串输出也
  当成真的执行了 git push），注册成 SQLite 自定义函数 `cc_github_op()`直接在查询
  里用。点开每张卡片能看到具体是哪个 session、哪个文件夹、什么时候、执行的什么
  命令（复用文件操作/软件安装统计已经在用的下钻渲染逻辑）。

### 修复
- 额度明细（limits）表格里"已使用百分比"和"级别"两列文字重叠——加长版进度条用
  `width: 100%` 在表格的自动布局里跟其它列打架（百分比宽度的 flex 子元素不参与
  表格列的内在宽度计算，列被判定得很窄，导致条又想撑满又撑不开），改成固定
  `220px` 宽度，两边都不会再互相挤。
- Log 审计 / Claude Tap 的内容列表容器之前写死 `max-width: 900px`（明明叫
  ".wide"却限死宽度），宽屏下右边留一大截空白、滚动条也卡在页面中间不上不下，
  去掉这个限制改成撑满可用宽度。
- 首页"Claude Code 运行身份检测"和"Anthropic 账号信息"标题旁边两句冗长的说明
  文字按反馈精简掉了。

## [1.3.2] - 2026-09-12

### 新增
- **Anthropic 账号信息新增姓名/邮箱/组织/套餐**：不是新的网络请求，是 Claude Code
  自己维护的本地全局配置文件 `~/.claude.json`（`oauthAccount` 字段）——反编译
  [ccstatusline](https://github.com/sirmalloc/ccstatusline) 的 "Claude Account
  Email" 挂件确认的路径和字段名。新增字段：姓名、邮箱、组织名称、组织角色、套餐类型
  （比如 `claude_max`）、组织额度档位、计费方式、账号创建时间、订阅开始时间。首页放在
  "检测到的 claude 进程"下面，状态信息页放在"账号额度"前面。
- **AI 审批台新增历史记录**：`pending_approvals` 表本来就没有任何清空逻辑（首页"清空
  当前数据"按钮只清 `events` 表），所以历史记录天然就是长期保存的，这次只是把它显示
  出来——时间、Session、工具、命中规则、匹配内容、结果、处理方式。对于 `notify` 类
  记录（比如 `AskUserQuestion`），新增 `resolved_value` 字段，从对应 `PostToolUse`
  事件的 `tool_response.answers` 里把用户在终端里实际选的答案摘出来存下，历史记录里
  不止看得到当时问了什么，也看得到最后答了什么（旧记录没有这个数据，新产生的才有）。
- **额度明细（limits）百分比**换成圆角胶囊 + 发光描边的进度条样式，颜色跟着当前配色
  主题的 accent/yellow/red 变量联动（不是写死的固定色）。
- **状态信息页会话状态**新增 `Σ Total: X.XM · Cached: X.XM` 每会话 token 统计，跟
  [ccstatusline](https://github.com/sirmalloc/ccstatusline) 的 TokensTotal/
  TokensCached 挂件同一个计算口径（Total = input+output+cached，Cached =
  cache_read+cache_creation），之前只统计了 cache_read，漏了 cache_creation。
- 事件明细表格（工具调用/MCP 调用/Skill 调用统计的下钻、审批历史记录）的 Session ID
  前面统一带上文件夹名（比如 "webui · 6ca9e412…"），比一串截断的 UUID 好认。

### 修复
- CC-Monitor 自己的 `disk_overwrite` 规则正则表达式 `\b(dd|mkfs|fdisk|parted)\b`
  会把 `dd-table` 这种带连字符的 CSS 类名误判成 `dd` 磁盘命令拦截（正则的 `\b` 词
  边界把连字符当成了单词分隔符）——开发这次功能时被自己的规则拦了才发现，改成用
  `(?<![\w-])...(?![\w-])` 精确匹配独立的命令名。
- AI 审批台的桌面通知按钮、审批历史记录表格，切换中英文界面语言时不会重新翻译（imperative
  设置的 `textContent`，不在 `data-i18n` 的自动刷新范围内），已经把它们接进语言切换
  时的刷新流程。
- Log 审计 / Claude Tap 工具栏的会话筛选下拉框之前用 `margin-left: auto` 想推到最
  右边，但它在 DOM 里排在自动滚动开关前面，实际效果是开关跑到了它右边——加上
  `order` 让它排到真正最后。
- 首页账号信息的"账号创建时间"/"订阅开始时间"用 `toLocaleString().slice(0, 10)`
  截取日期部分，截出来的字符串带了个多余的逗号（"3/28/2026,"），改用
  `toLocaleDateString()`。

### 变更
- 之前给文件操作统计/软件安装统计/Anthropic 账号信息这几组统计卡片加过整卡片背景
  染色（先是跟随主题色，后来改成固定的霓虹配色，又发现忘了主题选择器本来就能改这个
  颜色），来回几轮后按最新反馈整体去掉了，卡片恢复成跟其它统计一样的纯色背景。

## [1.3.1] - 2026-09-12

### 新增
- **工具调用 / MCP 调用 / Skill 调用 / AI 轨迹下钻明细**新增 Session ID、文件夹路径、
  时间戳的事件级列表（不只是按类型/server/skill 分组的汇总数字）。AI 轨迹的连接
  事件来自内核层探针，没有 Session 概念，这两列改成显示说明文字，换成显示发起连接
  的进程/命令名（比如 `pip3`、`apt`、`curl`）做替代的归因方式。
- 首页导航栏顺序调整为：首页 / 状态信息 / 网络流量 / 终端会话 / AI 审批台 / Log 审计
  / Claude Tap / 历史数据。
- 文件操作统计 / 软件安装统计 / Anthropic 账号信息这几组统计卡片背景改成跟随当前
  配色主题的彩色底色（后续版本里又整体去掉了，见上面"未发布"的"变更"）。

### 修复
- 连接目的地世界地图的等距柱状投影没有按画布实际宽高比缩放，画布不是标准 2:1 比例
  时地图会被拉伸变形；改成按画布宽高比在 clip space 里补一次缩放，多出来的部分用
  留白而不是拉伸填满。

## [1.3.0] - 2026-09-12

### 新增
- **Claude Code 网络流量页**（导航栏"历史数据"前面）：连接明细表（目标 IP/端口、反解析
  域名、上传/下载字节数、连接次数、归属地）+ 汇总卡片 + WebGL2 世界地图（等距柱状投影 +
  本地打包低精度海岸线，参考 [BeeEye](https://github.com/cn0xroot/BeeEye) 的
  `WorldMap.jsx`，不依赖任何地图瓦片服务）。系统层探针新增 `tcp_sendmsg`/
  `tcp_cleanup_rbuf` 内核探点，按 `(ip, port)` 聚合真实上传/下载字节数（之前的探针只
  知道"连过哪个 IP:port"，不知道传了多少数据），写入新增的 `network_traffic` 表。
- **IP 归属地查询**（`webui/lib/geoip.js`）：本地数据库查询，不逐个 IP 发第三方 API
  请求。支持两种数据源：MaxMind GeoLite2（官方，需注册账号）或
  [DB-IP Lite](https://github.com/sapics/ip-location-db)（CC BY 4.0 开放许可，不用
  注册，直接下载现成 `.mmdb`），两种字段格式（嵌套/平铺）都识别。没配置数据库时如实
  返回"未配置"，不编造数据。
- **首页三张新统计卡片**：工具调用（只数 `hook_pre`，比"审计事件总数"更贴近直觉）、
  MCP 调用（按 `mcp__<server>__<tool>` 命名规则识别，下钻按 server 分组）、AI 轨迹
  （访问过的域名/IP，复用网络流量页的数据），均支持点击下钻。
- **Claude Code 运行身份检测**（首页常驻卡片 + 下钻明细）：跨平台（`ps`）检测机器上
  所有 `claude` 进程分别是什么操作系统用户在跑，跟 Web UI 自己的运行用户不一致时会
  有醒目提示——两边各自按自己进程的 `$HOME` 找 `~/.cc-monitor/`，不是同一个用户的话
  会各写各的数据库、终端里的确认框/审计事件网页永远看不到，这个功能就是把这种情况
  变得看得见。
- **"AI 审批台"新增对 Claude Code 澄清性问题的支持**：新的 `action: "notify"` 规则
  类型（区别于原来的 `confirm`）——像 `AskUserQuestion` 这类"Claude Code 在问用户
  问题"的工具调用，没有 allow/deny 语义，不阻塞、不弹 tty 确认框，只是把"现在有个
  问题在等你"这个状态展示到网页上（完整问题+选项，蓝色样式区分开），答案只能在触发
  它的终端里给，对应的 `PostToolUse` 一来就自动消失。

### 修复
- `geoip.js` 的并发竞态：`getStatus()`/`lookup()` 在同一次请求里被 `Promise.all`
  并发调用时，第二个调用可能看到"正在加载"就直接返回还没赋值完的 `reader`（`null`），
  导致明明数据库加载成功了，`available` 还是显示 `false`。改成让所有调用者共享同一个
  加载中的 Promise。
- `probe.py` 里 bpftrace 未安装的报错文案之前建议"brew 安装"，但这个探针依赖 Linux
  内核的 eBPF 子系统，macOS 上没有等价物，装不了也跑不起来，文案容易误导，已经改成
  明确说明。
- 首页 / 状态信息页的额度重置时间之前四舍五入到小时（"5 小时后"），差几分钟看不出来，
  改成精确到分钟。
- 事件时间戳（终端会话创建时间、Claude Tap 时间戳、重置时间的绝对时刻）统一改成
  24 小时制，不再跟着浏览器/系统 locale 可能显示成 12 小时制。

### 变更
- 中英文 README 的"首页"功能介绍严重过时，好几个早就做好的功能（审计开关、运行
  身份检测、Anthropic 账号信息、软件安装统计）一直没写进去，这次一起补齐；"已实现"
  路线图清单也补上了对应条目。

## [1.2.2] - 2026-09-12

### 修复
- Web UI 终端会话"模型ID识别失败"的真正根因：新建终端会话时，spawn 出来的 `claude`
  进程原样继承了 Node 服务进程自己的 `CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_CHILD_SESSION`
  等环境变量（当 `node server.js` 本身是在另一个 Claude Code 会话里启动的时候就会
  出现），导致它被当成"子会话"处理，根本不写自己的 transcript 文件。建终端前把这些
  变量摘干净了。（之前误判过是 cwd 符号链接不匹配，那个修复本身也有效、保留了，
  但不是这个 bug 的主因）
- WEB 终端会话经常"突然就没了"：服务端此前没有任何全局崩溃保护，一个请求/WS 消息
  里的未捕获异常会直接干掉整个进程、陪葬所有会话。加了 `uncaughtException`/
  `unhandledRejection` 兜底（记日志但不退出），`sessions.js` 的 `write()` 也补了
  漏掉的 try/catch。
- 网页刷新后终端会话/Claude Tap 选中的会话都要重新选：当前会话状态只是纯前端临时
  变量，刷新就归零。存进 `localStorage`，刷新自动恢复。顺手修了 Claude Tap 那边一个
  "判断是否首次建下拉选项"用错判断条件（`options.length===0` 因为 HTML 里写死了
  占位 option 永远为 false）导致恢复逻辑压根不触发的隐藏 bug。
- 待批准漏掉 Claude Code 原生的 WebSearch 等询问：新增 `web_search` 规则，并且把
  confirm 通过后的 hook 输出从纯 exit code 改成 `hookSpecificOutput.permissionDecision
  :"allow"` 这种 JSON 格式——不这样做的话，网页上点"允许"之后 Claude Code 自己的原生
  弹窗还会再问一遍。没被我们规则覆盖的操作仍然原样交给 Claude Code 自己的原生询问
  处理，不会被静默放行。
- 终端软件（非 WEB 端终端）的确认框在网页上看不到：根因是 Web UI 进程和你终端里
  `claude` 进程如果不是同一个操作系统用户，两边会读写完全不同的 `~/.cc-monitor/`
  数据库。新增"Claude Code 运行身份检测"卡片（首页常驻 + 下钻明细），检测到用户不
  一致时会有醒目提示；`start.sh` 用 root 启动时会警告，`server.js` 启动时打印当前
  运行用户。

### 新增
- 待批准增加"批准，且 10/30 分钟内不再询问"两个选项，跟"一直允许"共用同一套
  session 级别的记忆机制，只是多带一个过期时间。
- 待批准支持浏览器桌面通知（Notification API）：有新请求时哪怕没开着这个页面/
  标签页不在前台也能弹系统通知，点击直接跳回来处理，同一条请求不会重复通知。
- 首页"终端会话（进行中）"下钻增加 Session ID / 拦截绕过 / 时间范围三列，跟"所有
  会话"下钻保持一致。

### 变更
- "待批准"改名"AI 审批台"（英文 "AI Approvals"），中英文界面和文档同步更新。

## [1.2.1] - 2026-09-12

### 修复
- `webui/package.json` 的 `main` 字段一直是 `"server.js"`，导致 electron-builder 打包出来
  的桌面版直接把纯 Express 服务端脚本当成 Electron 主进程入口，完全绕过了
  `electron-main.js` 里开窗口、设置 9998 端口的逻辑（表现为：打包出来的 AppImage 不开
  窗口，还去抢网页版默认监听的 9999 端口）。之前手动跑 `electron electron-main.js`
  测试是好的，是因为显式指定了入口文件，掩盖了这个问题；实际打包才暴露出来。改成
  `"main": "electron-main.js"`。

### 变更
- `.gitignore` 新增 `webui/dist/`（electron-builder 的打包输出目录），避免几十上百 MB
  的二进制文件被误提交进仓库。

## [1.2.0] - 2026-09-12

### 新增
- **待批准审批中心**：新增导航页"待批准"，把 Claude Code 默认模式下"是否允许执行"的
  确认弹窗同步到 Web UI 上。同一条 `confirm` 类操作，既可以在触发它的终端里直接按
  y/N，也可以在网页上点"允许一次 / 拒绝一次 / 一直允许"——两条路谁先给出结果就用谁的
  （SQLite 里 `pending_approvals` 表配合 `WHERE status='pending'` 保证原子性，不会
  两边都生效或者互相冲突）。"一直允许"是按 session 生效的，不是改全局规则：同一个
  session 里这条规则以后不用再问，别的 session 哪怕跑一模一样的命令还是照常问。
  确认超时从 20 秒延长到 90 秒，给网页那条路留出反应时间。
- **终端会话状态灯**：每个终端会话现在会显示 working / blocked / idle 三种状态（关闭
  的显示 dead），跟 [herdr](https://github.com/herdrdev/herdr) "每个 pane 标状态、不用
  到处找卡住的那个"是类似的思路——不是另起一套检测机制，复用已有的数据源：有没有
  待处理的审批请求（最该优先看的 blocked）、终端最近有没有真输出过、审计事件最近有
  没有新记录，判定"在正常干活"还是"停在提示符前"。
- **首页 Anthropic 账号信息**：展示用量/额度相关的更多细节——`limits[]` 明细
  （session/weekly_all/weekly_scoped，各自的百分比、severity、resets_at，
  weekly_scoped 还带具体是限定给哪个模型）、`spend`（超出套餐额度后是否开通了额外
  付费额度，用了多少）。
- **软件安装统计**：首页"文件操作统计"下面新增 pip / 系统包管理器 / npm / 其它 四类
  安装操作次数统计，点击可以下钻看具体是哪些安装指令。复用 policy 规则引擎已经判过
  的 `matched_rule` 分组，识别逻辑只有一份，不会跟拦截逻辑的判断标准不一致。
- **远程访问安全开关**：首页新增"是否允许其它设备访问本服务"开关。默认仍然只绑
  `127.0.0.1`，这个默认值不会被网页开关自动改掉——真要监听所有网卡，得管理员显式设
  `CC_MONITOR_WEBUI_HOST=0.0.0.0` 再重启进程。网页开关管的是另一件事：即使显式绑成
  了 `0.0.0.0`，HTTP 中间件和 WebSocket upgrade 也会先查这个开关，默认关（拒绝非本机
  来源），开了才放行——给"确实想监听所有网卡"这个场景再加一道默认关闭的应用层闸门。
- **Claude Tap 全部会话视图**：新增合并视图，把所有有 transcript 的会话最近的内容
  按时间戳合并排序展示，不用再一个个会话切换着看。
- **一键安装 / 一键启动脚本**：新增 `install.sh`（检查 Python/Node 环境，跑
  `install.py`，装 webui 依赖，检查 bpftrace）和 `start.sh`（装依赖、启动 Web UI）。
- **桌面版（Electron）脚手架**：新增 `webui/electron-main.js`，直接 `require`
  现有的 `server.js`（Express + ws + node-pty + better-sqlite3）在 Electron 主进程里
  跑起来，不用改一行服务端代码；桌面版固定用 9998 端口，跟网页版的 9999 互不冲突，
  可以同时开着。目前只在 Linux 下验证了服务端能正常内嵌启动，Mac/Linux ARM64 打包
  还在计划中，尚未发布可下载的桌面安装包。

### 变更
- **README 默认语言改成英文**：原来的中文 `README.md` 移到 `README.zh-CN.md`，原来的
  `README.en.md` 内容合并进新的 `README.md`（英文），互相的语言切换链接同步更新。

### 修复
- `webui/lib/usage.js` 里 `https-proxy-agent` 是纯 ESM 包（`"type":"module"`，没有
  `require` 导出条件），在这个环境的 Node 22 下用 `require()` 碰巧能跑，但换到
  Electron 自带的旧版 Node 下会直接抛 `ERR_REQUIRE_ESM` 崩掉整个进程——这是在验证
  桌面版脚手架时用真实测试跑出来的问题，改成异步动态 `import()` 后两边都兼容。

## [1.1.2] - 2026-09-12

### 修复
- 修了一类"点了没反应"的 CSS 优先级 bug：`.error-banner`/`#terminal-statusline`/
  `#terminal-grid-pane`/`.archive-load-more` 这四个元素都写了不带 `[hidden]` 条件的
  unconditional `display`，优先级比浏览器默认的 `[hidden]{display:none}` 高，导致 JS
  设置 `.hidden = true` 完全不起作用——错误提示条点"知道了"关不掉、终端网格/单会话
  视图切换其实一直没真正切换过。补上对应的 `[hidden]{display:none}` 规则覆盖回去。

## [1.1.1] - 2026-09-12

### 修复
- Claude Tap 里思考内容为空时，文案从容易让人误以为"内容被隐藏"的"(内容已省略)"，
  改成明确说明原因：Claude Code 本身就没有把这段思考正文存到本地 transcript 里
  （只留了校验用的 signature）——这台机器上全部项目的 transcript 统计下来，
  14556 个思考块无一例外全是空的，不是 CC-Monitor 能读取到但选择不显示的内容，
  改代码变不出数据。

## [1.1] - 2026-09-12

`v1.0` 打完 tag 之后新做的功能/修复：

### 新增
- 首页新增**审计开关**：开始 / 暂停 / 停止（合并成一个切换按钮 + 一个独立的停止按钮），
  三态语义不同——`running` 正常判定+拦截+记录；`paused` 只观察不拦截（仍按规则算
  risk/matched_rule 记下来，但从不真的拦截或弹确认框）；`stopped` 完全不介入，不判定
  也不记录。顶栏常驻一个状态指示灯，随时能看到当前是不是被暂停/停止了。
- 首页新增**数据管理**：持久化归档（用 SQLite 官方 `backup()` API 给当前 `events.db`
  做完整快照，存到 `~/.cc-monitor/archives/`）、清空当前数据（`DELETE` + 重置自增 ID）。
- 新增**历史数据**页：列出所有归档快照，每份可以点"打开"翻看里面具体记录的事件
  （复用 Log 审计同一套渲染），支持删除单条归档。
- "新建终端会话"弹窗新增**文件夹浏览器**：服务端目录列表接口 + 简单 UI，选的是运行
  Web UI 那台机器上的路径（不是浏览器本机的，原生 `<input webkitdirectory>` 选的是
  错误的那台机器）。
- Web 终端新增自动确认 Claude Code 首次打开陌生目录时弹出的"信任此文件夹"确认框——
  不然这个确认框没人处理的话，后续任何一次正常回车都会把 Claude Code 悄悄退出，界面
  上却看起来"终端明明是好的"。
- 首页"Web UI 终端会话（进行中）"卡片改成可点击下钻，显示每个会话的 cwd/状态/已运行
  时长/连接数，并按 cwd 弱关联匹配审计记录，附带显示模型和事件数；点一行可以直接跳到
  终端页面打开那个会话。
- Log 审计 / Claude Tap 都加了"自动滚动到最新"开关（iOS 风格滑动开关），关掉之后新
  内容照常记录/轮询，只是不再抢用户正在往上翻看历史时的滚动条。
- Claude Tap 新增"显示思考详情"开关，`thinking` 块默认折叠只露出几行，展开看全部——
  但如果 transcript 里这段思考本来就没存文字（Claude Code 有时候只存校验签名不存明文），
  开关也变不出内容，这是数据本身的限制。
- Claude Tap 的"用户"轮次里，工具结果如果是结构化对象/数组，改成带缩进的 JSON 格式
  单独展示，不再挤成一行。
- Claude Tap 现在最新消息放最上面，往下越来越旧（配合自动滚动开关，勾选着就自动滚回
  顶部）；打开一个会话不再从 transcript 第一行开始翻，改成直接定位到最近的内容——
  不然像常驻好几天、几万行的长会话，打开看到的全是好几天前的历史。
- 5 个新增主题：Midnight / Ocean / Forest / Sunset / Rose，配色移植自
  [AI_Web_Search](https://github.com/cn0xroot/AI_Web_Search)。
- `Makefile`：`make install` / `make uninstall`，可以把 CLI 工具装到系统路径
  （`/usr/local/lib/cc-monitor` + 命令行链接），不用记着代码放在哪个目录。

### 修复
- 删除文件操作识别：从 SQL `LIKE '%rm %'` 整串子串匹配（"confirm "这类词尾带"rm "的
  普通文本会被误判成删除）改成按命令分隔符拆开、只看子命令开头是不是
  `rm/rmdir/unlink/shred/git rm/find -delete`，大幅减少误报。
- **Log 审计页把其它 tab 全部挡住**这个长期存在的 bug：根因是 `#view-logs` 用 ID
  选择器写了个不带 `.active` 条件的 `display:flex`，优先级比 `.view{display:none}`
  这条 class 规则高，导致这个页面无论选没选中都常年可见，把 DOM 顺序在它后面的终端
  会话/Claude Tap/状态信息/历史数据全部挤到屏幕外。用无头浏览器实测复现+验证修复。
- Claude Tap 下拉框在用户正操作（focus 在它上面）时被定时轮询强制重建选项、把下拉
  框关掉/选项刷没的问题。
- Claude Tap 页面内容一多，工具栏（会话切换下拉）被卷到屏幕外够不着的问题。
- 静态资源加了跟进程启动时间绑定的版本号（`?v=<timestamp>`），避免浏览器/中间代理的
  缓存导致"服务端明明改了，页面却死活还是旧的"。
- Claude Tap 选中一个"hooks 记录了 transcript 路径但文件实际不存在"的会话（常见于
  一次性工具调用/后台任务）时，之前会一直显示"0 · 路径"、看起来像卡住了；现在会
  明确提示文件不存在。

## [1.0] - 2026-09-12

首个正式版本。双层监测架构 + 完整 Web UI。

### 核心监测
- **应用层**：`PreToolUse`/`PostToolUse` hooks，基于有序正则规则表（`default_rules.json`，
  30+ 条规则）判定放行/拦截/确认，覆盖高危删除、系统级软件安装（apt/yum/pip 未用虚拟
  环境等）、权限提升、反弹 shell、持久化后门（crontab/systemd）、SSH key 篡改等场景。
- **系统层**：`CC-Monitor-probe`（Linux，`bpftrace`）独立于 hooks 之外，在内核层跟踪
  `claude` 进程派生出的所有子进程的 `execve`/`connect`，`CC-Monitor verify` 交叉比对
  hooks 记录，标出"探针看到了、hook 没记录"的可疑差异（绕过检测）。
- 网络层可视化：eBPF 直接抓 `connect()` 目标 IP:port，不解密 TLS、不用装 CA 证书。
- 实时日志通俗呈现：`CC-Monitor tail`，终端自动彩色高亮，Bash 命令按语法着色。

### Web UI
- **首页**：概览统计，各卡片可点击下钻详情。
- **Log 审计**：全宽实时日志，按会话过滤，风险/操作类型/状态徽章配色。
- **终端会话**：`node-pty` 起真实 PTY，浏览器里直接对话；WebGL 加速渲染，GPU 不可用
  自动退化成 Canvas；支持网格视图（herdr 风格）同屏显示所有会话。
- **Claude Tap**：读 Claude Code 自己写的本地 transcript JSONL（`transcript_path`），
  还原发给/收到模型的完整对话（文本/思考/工具调用/工具结果/token 用量），不是抓包。
- **状态信息**：账号额度（跟 [ccstatusline](https://github.com/sirmalloc/ccstatusline)
  读同一份 OAuth 凭证）+ 每个会话的模型/token 用量/吞吐速率/git 分支/拦截情况。
- 中英文切换 + 5 套主题（标准配色/深色/浅色/Dracula/Nord）。
- 中文楷体 + 英文系统 UI 字体的字体栈。

### 安装
- `install.py`：按 `command` 字段去重合并写入 hooks 数组，不覆盖已有配置。
