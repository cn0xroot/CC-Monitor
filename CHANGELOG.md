# 更新日志

[English](./CHANGELOG.en.md) | 简体中文

本文件记录 CC-Monitor 每个版本实现了什么功能。格式大致参考
[Keep a Changelog](https://keepachangelog.com/)，但不强制严格照搬其分类。

## [未发布]

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
