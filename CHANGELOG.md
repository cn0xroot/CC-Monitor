# 更新日志

[English](./CHANGELOG.en.md) | 简体中文

本文件记录 CC-Monitor 每个版本实现了什么功能。格式大致参考
[Keep a Changelog](https://keepachangelog.com/)，但不强制严格照搬其分类。

## [未发布]

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
