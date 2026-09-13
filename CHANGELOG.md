# 更新日志

[English](./CHANGELOG.en.md) | 简体中文

本文件记录 CC-Monitor 每个版本实现了什么功能。格式大致参考
[Keep a Changelog](https://keepachangelog.com/)，但不强制严格照搬其分类。

## [未发布]

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
  `claude` 进程派生出的整棵子孙进程树的 `execve`/`connect`，`CC-Monitor verify` 交叉比对
  hooks 记录，标出"探针看到了、hook 没记录"的可疑差异（绕过检测）。
- 网络层可视化：eBPF 直接抓 `connect()` 目标 IP:port，不解密 TLS、不用装 CA 证书。
- 人类可读实时日志：`CC-Monitor tail`，终端自动彩色高亮，Bash 命令按语法着色。

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
