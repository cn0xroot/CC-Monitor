"use strict";
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

function dbPath() {
  const home = process.env.CC_MONITOR_HOME || path.join(os.homedir(), ".cc-monitor");
  return path.join(home, "events.db");
}

// 按 ; & | 换行 把一条 Bash 命令切成"子命令"分别看开头——这是本文件好几个分类器
// 共用的手法（不对整条命令文本做子串匹配，避免 echo 出来的字符串被误判成真的
// 执行了什么）。但天真地对整条命令文本做 cmd.split(/[;&|\n]+/) 有个漏洞：引号内的
// 多行字符串参数、heredoc（<<'EOF' ... EOF）的正文里，换行是内容的一部分，不是
// shell 语法意义上的命令分隔符——如果不管这些，会被当成一堆"独立子命令"分别去看
// 开头，实测线上数据抓到两个真实案例：
//   1. `python3 -c "\nimport json, sys\n..."` —— 双引号参数里的 "import json, sys"
//      单独成一行，被当成了 ImageMagick 截图命令 import 的调用；
//   2. `git commit -m "$(cat <<'EOF' ... EOF)"` —— heredoc 正文里 word-wrap 过的一行
//      刚好以 "spectacle" 开头（描述 KDE 截图工具名字的说明文字），被当成了真的在
//      调用 spectacle 截图。
// splitShellSegments() 用一个简化版的 shell 分词器解决这个问题：跟踪当前在不在
// 单/双引号、在不在 heredoc 正文里，只有真正在"顶层"（不在引号/heredoc 内部）的
// ; & | 换行才当分隔符。不追求 100% 还原 bash 语法（比如反引号/嵌套 $() 里的换行
// 没特殊处理），但已经覆盖了实际观测到的两种误判来源。
function splitShellSegments(cmd) {
  const segments = [];
  let cur = "";
  let i = 0;
  let quote = null; // "'" | '"' | null
  let heredocEnd = null; // 结束定界符，或者 null（不在 heredoc 正文里）
  const n = cmd.length;
  while (i < n) {
    if (heredocEnd !== null) {
      const lineEnd = cmd.indexOf("\n", i);
      const line = lineEnd === -1 ? cmd.slice(i) : cmd.slice(i, lineEnd);
      cur += line;
      if (line.trim() === heredocEnd) heredocEnd = null;
      if (lineEnd === -1) {
        i = n;
      } else {
        cur += "\n";
        i = lineEnd + 1;
      }
      continue;
    }
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "<" && cmd[i + 1] === "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) {
        cur += m[0];
        i += m[0].length;
        const nl = cmd.indexOf("\n", i);
        if (nl === -1) {
          i = n;
        } else {
          cur += cmd.slice(i, nl + 1);
          i = nl + 1;
          heredocEnd = m[2];
        }
        continue;
      }
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) segments.push(cur);
  return segments;
}

// 判断一条 Bash 命令里是不是真的在删文件——按 splitShellSegments() 切成子命令分别
// 看开头，而不是对整条命令文本做子串匹配。之前用 SQL LIKE '%rm %' 之类的写法会把
// "confirm "/"warm "/"term " 这些词尾带 "rm " 的普通输出也算成删除，
// 或者把 echo 出来的字符串（比如 echo "rm -rf 很危险"）也算成真的删除，误报非常多。
function commandDeletesFiles(cmd) {
  if (!cmd) return false;
  // find -exec rm ... \; / cmd | xargs rm 这类不在子命令开头，单独兜底判断一下。
  if (/(?:^|\s)(?:-exec\s+|xargs\s+(?:-\S+\s+)*)(?:rm|shred|unlink)\b/.test(cmd)) return true;
  const segments = splitShellSegments(cmd);
  for (const raw of segments) {
    const seg = raw.trim().replace(/^sudo\s+/, "");
    if (/^(rm|rmdir|unlink|shred|trash-put|trash)\b/.test(seg)) return true;
    if (/^git\s+rm\b/.test(seg)) return true;
    if (/^find\b/.test(seg) && /(?:^|\s)-delete(?:\s|$)/.test(seg)) return true;
  }
  return false;
}

function isDeleteEvent(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return commandDeletesFiles(detail.command || "") ? 1 : 0;
  } catch (e) {
    return 0;
  }
}

// GitHub 相关操作分类——跟 commandDeletesFiles 同一个思路：按 ; & | 换行 切成子命令
// 分别看开头，而不是对整条命令文本做子串匹配（避免把 echo "git push 很危险" 这种
// 字符串输出也算成真的执行了 git push）。一条 Bash 命令里可能好几个子命令都命中
// （比如 `git add . && git commit -m x && git push`），按"最具体"优先返回一个分类，
// 不是每个子命令都单独计数——跟 commandDeletesFiles 返回单个布尔值是同一个道理。
const GITHUB_OP_ORDER = ["push", "clone", "commit", "pullFetch", "ghCli", "otherGit"];
function classifyGithubOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^git\s+push\b/.test(seg)) found.add("push");
    else if (/^git\s+clone\b/.test(seg)) found.add("clone");
    else if (/^git\s+commit\b/.test(seg)) found.add("commit");
    else if (/^git\s+(pull|fetch)\b/.test(seg)) found.add("pullFetch");
    else if (/^gh\s+\S/.test(seg)) found.add("ghCli");
    else if (/^git\s+\S/.test(seg)) found.add("otherGit");
  }
  for (const kind of GITHUB_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function githubOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyGithubOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// SSH 相关操作分类——跟 classifyGithubOp 完全一样的思路：按 ; & | 换行拆成子命令，
// 只看子命令开头（`\s|$` 而不是 `\b`，是为了不把 ssh-keygen/ssh-copy-id/ssh-add/
// ssh-agent 这些名字里带连字符的独立命令误判成 "ssh" 本身——单纯用 \b 的话
// "ssh-keygen" 里 "ssh" 后面紧跟的 "-" 也算一次词边界，会被 /^ssh\b/ 误命中）。
const SSH_OP_ORDER = ["ssh", "scp", "sftp", "keyManagement", "other"];
function classifySshOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^ssh(\s|$)/.test(seg)) found.add("ssh");
    else if (/^scp(\s|$)/.test(seg)) found.add("scp");
    else if (/^sftp(\s|$)/.test(seg)) found.add("sftp");
    else if (/^(ssh-keygen|ssh-copy-id|ssh-add|ssh-agent)(\s|$)/.test(seg)) found.add("keyManagement");
    else if (/^(autossh|sshpass|ssh-askpass)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of SSH_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function sshOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifySshOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 下载行为分类——跟 classifyGithubOp/classifySshOp 一样按子命令开头识别，注意不要
// 跟其它已经单独统计过的分类重叠（git clone 算 GitHub 操作、pip/npm/系统包管理器
// 安装算软件安装统计，这里全部不再重复计数，只看专门的下载类工具）。
// curl 单独处理：只有带了真正落盘的参数（-o/-O/--output/--remote-name）才算"下载"，
// 裸 curl（比如 curl https://api.example.com/status）绝大多数是在调 API 看返回内容，
// 不是在下载文件，全算成下载会把普通的接口调用也算进来，噪音太大。
const DOWNLOAD_OP_ORDER = ["wget", "curl", "aria2", "other"];
const CURL_OUTPUT_FLAG_RE = /(^|\s)(-O\b|--remote-name\b|-o\s|--output(\s|=))/;
function classifyDownloadOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^wget2?(\s|$)/.test(seg)) found.add("wget");
    else if (/^curl(\s|$)/.test(seg) && CURL_OUTPUT_FLAG_RE.test(seg)) found.add("curl");
    else if (/^aria2c?(\s|$)/.test(seg)) found.add("aria2");
    else if (/^(axel|lftp|ftp|http|https)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of DOWNLOAD_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function downloadOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyDownloadOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// Docker 操作分类——跟 classifySshOp/classifyDownloadOp 一样按子命令开头识别。
// build/run 单独拆出来是因为这两个是"会执行任意外部镜像/Dockerfile 里的指令"，
// 风险跟普通的 ps/logs/images 这类只读查看类操作不是一个量级；exec 单独拆出来是
// 因为这是"进到一个已经在跑的容器里执行命令"，跟宿主机上直接跑命令的风险类似；
// compose 覆盖 docker compose（v2 子命令）和独立的 docker-compose（v1 二进制）。
// docker-compose 单独判断是不是子命令开头，不能套用 \b（否则会被 docker 一起命中）。
const DOCKER_OP_ORDER = ["run", "build", "exec", "compose", "other"];
function classifyDockerOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^docker-compose(\s|$)/.test(seg)) found.add("compose");
    else if (/^docker\s+compose\b/.test(seg)) found.add("compose");
    else if (/^docker\s+run\b/.test(seg)) found.add("run");
    else if (/^docker\s+build\b/.test(seg)) found.add("build");
    else if (/^docker\s+exec\b/.test(seg)) found.add("exec");
    else if (/^docker(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of DOCKER_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function dockerOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyDockerOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 压缩/归档操作分类——跟 classifyDockerOp 同一套思路，按子命令开头识别。
const ARCHIVE_OP_ORDER = ["tar", "zip", "sevenZip", "gzip", "other"];
function classifyArchiveOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^tar(\s|$)/.test(seg)) found.add("tar");
    else if (/^(zip|unzip)(\s|$)/.test(seg)) found.add("zip");
    else if (/^(7z|7za|7zr)(\s|$)/.test(seg)) found.add("sevenZip");
    else if (/^(gzip|gunzip|zcat)(\s|$)/.test(seg)) found.add("gzip");
    else if (/^(bzip2|bunzip2|xz|unxz|zstd|unzstd|lzma|unlzma|rar|unrar)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of ARCHIVE_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function archiveOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyArchiveOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 网络诊断工具分类——nc/ncat/netcat 单独统计，不代表就是反弹 shell：`nc -e /bin/sh`
// 这种真正危险的用法已经由 policy.py 的 reverse_shell_pattern 规则单独拦截/告警了，
// 这里只是"这条命令用过 nc/nmap/telnet 之类的工具"这个更宽的可见性统计，跟风险判断
// 是两回事。
const NETDIAG_OP_ORDER = ["nc", "nmap", "telnet", "other"];
function classifyNetdiagOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^(nc|ncat|netcat)(\s|$)/.test(seg)) found.add("nc");
    else if (/^nmap(\s|$)/.test(seg)) found.add("nmap");
    else if (/^telnet(\s|$)/.test(seg)) found.add("telnet");
    else if (/^socat(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of NETDIAG_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function netdiagOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyNetdiagOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 逆向分析工具调用——跟网络诊断工具同一个思路：纯可见性统计，不代表风险判断。
// IDA/Ghidra/radare2/GDB 这些是专业逆向工程师的日常工具，CTF/漏洞研究/合规安全
// 测试里到处都是，没有理由拦截或要求确认；但"Claude 有没有用过这些工具分析过
// 什么二进制"本身是个值得沉淀的可见性信号，尤其结合会话的 cwd/命令明细能帮着
// 复盘一次逆向分析任务到底摸了哪些文件。按工具家族分类，不细到具体子命令参数。
const REVERSE_ENG_OP_ORDER = ["ida", "ghidra", "radare2", "gdb", "other"];
// 真实数据里 IDA/GDB 这些经常是绝对路径调用的（比如 /opt/idapro-9.0/idat64），装了
// 之后极少会特地加进 PATH——只按 "^ida..." 从头匹配会把这类调用全部漏掉。跟
// policy.py 的 _normalize_head 一个思路：先剥掉子命令开头可能有的环境变量赋值前缀
// （LD_LIBRARY_PATH=xxx PYTHONHOME=xxx gdb ...这种，实测线上真的有——手动给 gdb 挂
// 定制运行时库路径来跑跨架构调试），再剥可执行文件的路径前缀，最后拿裸文件名匹配。
// 顺序不能反：如果先剥路径前缀，会把 "LD_LIBRARY_PATH=/a/b/c" 这个环境变量赋值本身
// 误当成"路径/文件名"来剥（截出来的"文件名"是这个赋值的最后一段，不是真正在跑的
// 命令），必须先把环境变量赋值这一层完全去掉。
const ENV_ASSIGN_RE = /^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
function stripEnvAssignments(seg) {
  return seg.replace(ENV_ASSIGN_RE, "");
}
function stripPathPrefix(seg) {
  const m = seg.match(/^(\S*\/)(\S+)/);
  return m ? seg.slice(m[1].length) : seg;
}
// macOS 上 IDA/Ghidra/Hopper/Binary Ninja 这类 GUI 逆向工具常打包成 .app，用
// `open -a "IDA Pro"` 这种方式启动，不是直接跑一个裸的可执行文件名——单独识别这个
// 调用形态，跟上面按可执行文件名匹配的逻辑并列判断。
const MACOS_OPEN_APP_RE = /^open\s+(-\S+\s+)*-a\s+["']?([^"'\n]+?)["']?(\s|$)/;
function classifyReverseEngOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd)
    .map((raw) => raw.trim().replace(/^sudo\s+/, ""))
    .map(stripEnvAssignments)
    .map(stripPathPrefix);
  const found = new Set();
  for (const seg of segments) {
    if (/^ida(t|q)?(64)?(\.exe)?(\s|$)/.test(seg)) found.add("ida");
    else if (/^(ghidraRun|analyzeHeadless|ghidraSvr)(\s|$)/.test(seg)) found.add("ghidra");
    else if (/^(radare2|r2|rizin|rz-\w+|cutter)(\s|$)/.test(seg)) found.add("radare2");
    else if (/^(gdb|gdb-multiarch|cgdb|gdbserver|pwndbg)(\s|$)/.test(seg)) found.add("gdb");
    else if (
      /^(binaryninja|binja|hopperv?4?|x(64|32)dbg|windbg|cdb|ollydbg|immunitydebugger|dnspy|jadx(-gui)?|apktool|dex2jar|jd-gui|frida(-[\w-]+)?|objection|retdec-decompiler|binwalk|checksec|diaphora|bindiff|uncompyle6|decompyle3|pycdc)(\s|$)/.test(
        seg
      )
    )
      found.add("other");
    else {
      const appMatch = MACOS_OPEN_APP_RE.exec(seg);
      if (appMatch && /\b(ida|ghidra|hopper|binary\s*ninja)\b/i.test(appMatch[2])) {
        if (/\bida\b/i.test(appMatch[2])) found.add("ida");
        else if (/\bghidra\b/i.test(appMatch[2])) found.add("ghidra");
        else found.add("other");
      }
    }
  }
  for (const kind of REVERSE_ENG_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function reverseEngOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyReverseEngOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 进程管理/后台驻留分类——nohup/disown/setsid 按子命令开头识别，是同一套思路；
// "后台任务"（裸 `&`）不一样，它不是某个命令的名字，而是整条命令末尾的一个 shell
// 语法标记，没法按 splitShellSegments() 切出来的子命令开头去匹配（splitShellSegments
// 本身就会把单个 `&` 当成分隔符切开，切完就看不出原来是不是背景任务标记了）。改成
// 直接在原始命令文本上找"独立的 `&`"：前面不能紧跟 `&`/`>`（排除 `&&`、`2>&1`、`&>`
// 这些不是真正后台标记的写法），后面不能紧跟数字/`&`/`>`（同样排除 `2>&1`/`&>` 这种
// 文件描述符重定向），并且这个 `&` 后面（跳过空白）直接是命令末尾或者 `;`——只抓
// "命令在这里结束、后台丢出去了"这种最典型的写法，像 `task1 & task2`（后台之后紧接着
// 写下一条命令，中间没有 `;`）这种少见写法会漏掉，属于故意收窄换取不误伤形如
// `curl 'http://x.com/a&b=c'` 这类 URL 查询字符串里的 `&`。
const BG_JOB_RE = /[^&>]&(?![&>0-9])\s*(;|$)/m;
const PROCMGMT_OP_ORDER = ["nohup", "disown", "backgroundJob", "other"];
function classifyProcessBackground(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^nohup(\s|$)/.test(seg)) found.add("nohup");
    else if (/^disown(\s|$)/.test(seg)) found.add("disown");
    else if (/^setsid(\s|$)/.test(seg)) found.add("other");
  }
  if (!found.size && BG_JOB_RE.test(cmd)) found.add("backgroundJob");
  for (const kind of PROCMGMT_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function processBackgroundType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyProcessBackground(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 从命令文本里抠目标主机名——三种写法都要认，全部要求有明确、低误判风险的语法标记，
// 不认"看起来像域名的裸单词"：
//   1. URL 形式：协议://[user@]host[:port]/…（wget/curl/aria2/axel/lftp/http(s)）
//   2. user@host（ssh/sftp 的典型写法，@ 前缀是强信号，不会跟本地文件名搞混）
//   3. host:path（scp/rsync 的远程规格，不带 user@ 也行，但一定要紧跟冒号）
// 特意不认"裸主机名、没有 @ 也没有冒号"这种写法（比如 `ssh myserver`、或者
// `scp file.txt user@host:/path` 里的本地源文件 file.txt）——第一版曾经用一个更宽的
// 正则把 `-o out.tar.gz` 的输出文件名、scp 的本地源文件名都当成了"主机名"，因为
// 这些文件名本身也是带点的字符串、后面跟着空白，形状上跟目标主机没法用纯正则区分。
// 宁可漏掉内网短名这种真正的边缘情况，也不要把命令里随便一个带点的单词当成主机名。
const URL_HOST_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^\s@/]+@)?([^\s/:?#'"]+)/g;
const AT_HOST_RE = /@((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3})/g;
const COLON_HOST_RE = /(?:^|[\s])((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3}):(?=[\w~./]|$)/g;

function extractCommandHosts(text) {
  if (!text) return [];
  const hosts = new Set();
  let m;
  URL_HOST_RE.lastIndex = 0;
  while ((m = URL_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  AT_HOST_RE.lastIndex = 0;
  while ((m = AT_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  COLON_HOST_RE.lastIndex = 0;
  while ((m = COLON_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  return Array.from(hosts);
}

// 哪些子命令算"发起了网络请求"——比下载行为统计（DOWNLOAD_OP_ORDER）宽一些：那边
// 特意把不带 -o/-O 的裸 curl 排除在外（避免把纯 API 调用算成"下载"），但对 AI 轨迹
// 来说，裸 curl 调 API 本身也是一次真实的网络请求，理应体现在轨迹里，不该套用下载
// 统计那条更窄的口径。git 只算 clone/pull/fetch/push 这几个会真的发起网络连接的
// 子命令，commit 是纯本地操作不算。ssh 系列里 keyManagement（ssh-keygen 等）是本地
// 操作，同样不算。
function isNetworkTouchingSegment(seg) {
  return (
    /^(wget2?|curl|aria2c?|axel|lftp|ftp|https?)(\s|$)/.test(seg) ||
    /^git\s+(clone|pull|fetch|push)\b/.test(seg) ||
    /^(ssh|scp|sftp|autossh|sshpass)(\s|$)/.test(seg)
  );
}

// 由 Claude 通过 Bash 执行、涉及网络请求的命令——跟系统层探针（os_net，实测到的
// 真实 connect()）是两种不同性质的证据：这里只是"命令文本上看起来会联网"，不代表
// 真的连通了（可能失败/超时/被 policy 拦截），也没有字节数可言。用户明确要求：这类
// 命令没被探针捕捉到时，也要能在"AI 轨迹"里体现出来（很多人根本没有手动启动过
// system 层探针，之前完全没有这块可见性）。只看 Claude 自己触发的 hook_pre 事件，
// 用户在别的终端里手打的命令不会经过 Claude Code 的 hooks，天然不会出现在这里。
// WebFetch 请求的目标域名——跟 Bash 命令推断同一个道理，都是"看起来会联网"而
// 不是探针实测的真实连接，合到同一份 AI 轨迹数据里。WebFetch 的 url 字段本来
// 就是完整 URL，不用再套 extractCommandHosts() 那套给 shell 命令文本设计的、
// 专门避免把本地文件名误判成主机名的正则——直接用 URL() 解析主机名更准确。
// WebSearch 的 query 字段是搜索关键词，不是 URL，没有域名可提取，天然不在这里面。
function webFetchHostRows(db, limit) {
  const rows = db
    .prepare(
      `SELECT id, ts, session_id, cwd, detail FROM events
       WHERE source = 'hook_pre' AND tool_name = 'WebFetch'
       ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
  const out = [];
  for (const row of rows) {
    let detail;
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      continue;
    }
    const url = detail.url || "";
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (e) {
      continue;
    }
    if (!host) continue;
    out.push({ id: row.id, ts: row.ts, sessionId: row.session_id, cwd: row.cwd, command: `WebFetch: ${url}`, host });
  }
  return out;
}

function commandNetworkHosts(limit = 2000) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT id, ts, session_id, cwd, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
    const out = [];
    for (const row of rows) {
      let detail;
      try {
        detail = row.detail ? JSON.parse(row.detail) : {};
      } catch (e) {
        continue;
      }
      const cmd = detail.command || "";
      const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
      const hostsInCmd = new Set();
      for (const seg of segments) {
        if (!isNetworkTouchingSegment(seg)) continue;
        for (const host of extractCommandHosts(seg)) hostsInCmd.add(host);
      }
      for (const host of hostsInCmd) {
        out.push({ id: row.id, ts: row.ts, sessionId: row.session_id, cwd: row.cwd, command: cmd, host });
      }
    }
    return out.concat(webFetchHostRows(db, limit));
  }, []);
}

// 截屏审计——Claude Code 没有内置"截图"工具，实际观测到的截屏行为分三种路子，
// 判断方式各自独立、按"最可能"的信号来源分开看：
//   1. Bash 命令调用了截图类 CLI 工具——跟 commandDeletesFiles() 一个思路，按
//      splitShellSegments() 拆成子命令分别看开头，不对整条命令文本做子串匹配
//      （避免 "echo 截图完成" 这种输出内容被误判）。原来列表里还有 ImageMagick 的
//      import 命令，线上实测发现这是个坏主意——"import" 是 Python 极常用的关键字，
//      即使用了 splitShellSegments() 正确跳过引号/heredoc 内部的换行，只要用户
//      自己的 shell 脚本里有一行真的以裸 "import ..." 开头（比如反引号/未加引号的
//      command substitution 里），还是会被误判成在调用截图工具。ImageMagick 的
//      import 命令本身在现代 Linux 桌面上也已经边缘化（grim/flameshot/spectacle/
//      gnome-screenshot 这些更常见），删掉它换来的误判下降比丢的召回率划算得多。
//      Wayland 下常见的走法是通过 xdg-desktop-portal 发 D-Bus 请求（gdbus/dbus-send
//      调 org.freedesktop.portal.Screenshot 接口），命令行工具反而用不了，单独判断。
//   2. Read 工具打开的文件本身就是图片——不严格等于"截屏"（也可能是用户自己的照片/
//      设计稿），但从"Claude 看到了屏幕/图像内容"这个角度审计，用户明确要求把这种
//      情况也算进来，接受比纯粹截图判断更宽的召回率。
//   3. MCP/"computer use" 类工具的截图动作——工具名里带 "screenshot" 字样（常见于
//      Playwright/Puppeteer 这类浏览器自动化 MCP server 暴露出来的工具名，比如
//      mcp__playwright__browser_take_screenshot），或者 Anthropic Computer Use 的
//      "computer" 工具、action 字段等于 "screenshot"。
const SCREENSHOT_CLI_RE = /^(scrot|gnome-screenshot|spectacle|flameshot|maim|grim|xwd|deepin-screenshot|xfce4-screenshooter|screencapture)\b/;
const SCREENSHOT_PORTAL_RE = /^(gdbus|dbus-send)\b/;
const SCREENSHOT_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function commandTakesScreenshot(cmd) {
  if (!cmd) return false;
  const segments = splitShellSegments(cmd);
  for (const raw of segments) {
    const seg = raw.trim().replace(/^sudo\s+/, "");
    if (SCREENSHOT_CLI_RE.test(seg)) return true;
    if (SCREENSHOT_PORTAL_RE.test(seg) && /screenshot/i.test(seg)) return true;
  }
  return false;
}

function isScreenCaptureEvent(toolName, detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    if (toolName === "Bash") {
      return commandTakesScreenshot(detail.command || "") ? 1 : 0;
    }
    if (toolName === "Read") {
      const filePath = detail.file_path || detail.path || "";
      return SCREENSHOT_IMAGE_EXT_RE.test(filePath) ? 1 : 0;
    }
    if (toolName === "computer" && detail.action === "screenshot") return 1;
    if (toolName && toolName !== "Bash" && toolName !== "Read" && /screenshot/i.test(toolName)) return 1;
    return 0;
  } catch (e) {
    return 0;
  }
}

// 敏感操作统计——不像 SSH/下载/Docker 这些分类器那样从头识别命令文本，而是直接
// 复用 policy.py 已经算好的 matched_rule：sensitive_file_read（Read 工具）、
// sensitive_file_read_bash（cat/less/head 等 Bash 命令）、env_dump（env/printenv/
// export -p）、history_read（Bash 里以任何方式碰历史文件、裸 history/fc -l）、
// history_file_read（Read/Grep 工具直接读历史文件）这五条规则本来就是"读取
// 敏感信息"这个语义下的全部现有覆盖，没必要在 JS 这边另起一套重复的正则——两边
// 一旦哪天改了其中一处正则容易不同步。sensitive_file_read/sensitive_file_read_bash
// 命中时进一步按路径细分是不是 SSH 密钥（.ssh/、id_rsa、id_ed25519、known_hosts），
// 不是的话（.env/.aws/credentials/.pem/.p12）归到"凭据/Token"；env_dump 单独是
// "环境变量查找"；history_read/history_file_read 归到"其它敏感操作"。
// 这组 id 同时出现在下面 sensitiveOpsBreakdown/sensitiveOpsEvents 的 SQL 里
// （SENSITIVE_READ_RULES_SQL），加规则时两处一起改。
const SENSITIVE_OP_ORDER = ["sshKey", "credential", "envVar", "other"];
const SENSITIVE_SSH_KEY_RE = /\.ssh\/|id_rsa|id_ed25519|known_hosts/i;
const SENSITIVE_READ_RULES = new Set(["sensitive_file_read", "sensitive_file_read_bash", "env_dump", "history_read", "history_file_read"]);
const SENSITIVE_READ_RULES_SQL = [...SENSITIVE_READ_RULES].map((r) => `'${r}'`).join(", ");
function classifySensitiveOp(matchedRule, text) {
  if (matchedRule === "env_dump") return "envVar";
  if (matchedRule === "history_read" || matchedRule === "history_file_read") return "other";
  if (matchedRule === "sensitive_file_read" || matchedRule === "sensitive_file_read_bash") {
    return SENSITIVE_SSH_KEY_RE.test(text || "") ? "sshKey" : "credential";
  }
  return null;
}

function sensitiveOpType(toolName, matchedRule, detailJson) {
  if (!SENSITIVE_READ_RULES.has(matchedRule)) return null;
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    // Bash 看 command；Read 看 file_path；Grep 之类的用 path（跟 policy.py 的
    // FIELD_CANDIDATES 保持一致）。
    const text = toolName === "Bash" ? detail.command || "" : detail.file_path || detail.path || "";
    return classifySensitiveOp(matchedRule, text);
  } catch (e) {
    return null;
  }
}

// 敏感数据统计——跟上面的"敏感操作统计"同一个思路（复用 policy.py 已经算好的
// matched_rule，不在 JS 这边另起一套重复的正则），但覆盖的是另一半场景：上面那组
// 是"读取"敏感信息（读 SSH 密钥、dump 环境变量、翻历史指令），这一组是"敏感信息
// 本身长什么样"——写入内容里出现云厂商/代码托管平台的凭据格式、PII（身份证号/
// 手机号/邮箱）、VPN/云 CLI 配置文件的读写。
// secret_pattern_in_write 和 pii_pattern_in_write 两条规则匹配的是 content 字段
// （Write 用 content、Edit 用 new_string、NotebookEdit 用 new_source，取哪个看
// 具体是哪个工具触发的），cloud_vpn_config_write/read 两条匹配的是 file_path，
// 取字段前先看是哪条规则命中的，不能像 SSH 密钥那组一样固定用同一个字段。
const SENSITIVE_DATA_RULES = new Set(["secret_pattern_in_write", "pii_pattern_in_write", "cloud_vpn_config_write", "cloud_vpn_config_read"]);
const SENSITIVE_DATA_PATH_RULES = new Set(["cloud_vpn_config_write", "cloud_vpn_config_read"]);
const SENSITIVE_VPN_RE = /\.ovpn|wireguard|wg0\.conf|PrivateKey\s*=/i;
function classifySensitiveData(matchedRule, text) {
  if (matchedRule === "pii_pattern_in_write") return "pii";
  if (matchedRule === "cloud_vpn_config_write" || matchedRule === "cloud_vpn_config_read" || matchedRule === "secret_pattern_in_write") {
    return SENSITIVE_VPN_RE.test(text || "") ? "vpnConfig" : "credential";
  }
  return "other";
}

function sensitiveDataType(toolName, matchedRule, detailJson) {
  if (!SENSITIVE_DATA_RULES.has(matchedRule)) return null;
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    const text = SENSITIVE_DATA_PATH_RULES.has(matchedRule)
      ? detail.file_path || detail.path || ""
      : detail.content || detail.new_string || detail.new_source || "";
    return classifySensitiveData(matchedRule, text);
  } catch (e) {
    return null;
  }
}

// 高级威胁检测——跟上面两组同一个思路（复用 policy.py 已经算好的 matched_rule），
// 覆盖的是参考 al0ne/suricata-rules 目录分类新增的那批规则：挖矿矿池域名、MySQL
// 任意文件写入落地 webshell、webshell 一句话马代码特征、下载脚本再分步执行、
// 渗透测试/C2 框架工具调用、DNS/ICMP 隐蔽隧道工具调用。每个 matched_rule 固定归到
// 一个分类，不需要像敏感数据那组一样再检查字段内容消歧——加新规则时把 id 加进
// ADVANCED_THREAT_RULE_MAP 就行，同一个分类可以有多条规则（比如矿池域名的
// command/write 两条变体）。
const ADVANCED_THREAT_ORDER = ["cryptoMining", "dbFileWrite", "webshell", "reverseEscapeShell", "downloadExec", "c2Framework", "postExploitation", "suspiciousMcp", "pentestRecon", "covertTunnel"];
const ADVANCED_THREAT_RULE_MAP = {
  crypto_miner_pool_domain_command: "cryptoMining",
  crypto_miner_pool_domain_write: "cryptoMining",
  db_arbitrary_file_write: "dbFileWrite",
  db_arbitrary_file_write_content: "dbFileWrite",
  webshell_pattern_in_write: "webshell",
  reverse_shell_pattern: "reverseEscapeShell",
  shell_escape_via_utility: "reverseEscapeShell",
  curl_download_then_exec: "downloadExec",
  c2_framework_execution: "c2Framework",
  post_exploitation_tool_execution: "postExploitation",
  mcp_suspicious_tool_name: "suspiciousMcp",
  pentest_recon_tool_execution: "pentestRecon",
  covert_tunnel_tool_execution: "covertTunnel",
};
const ADVANCED_THREAT_RULES = new Set(Object.keys(ADVANCED_THREAT_RULE_MAP));
const ADVANCED_THREAT_RULES_SQL = [...ADVANCED_THREAT_RULES].map((r) => `'${r}'`).join(", ");
function advancedThreatType(matchedRule) {
  return ADVANCED_THREAT_RULE_MAP[matchedRule] || null;
}

// 跨工作目录操作——policy.py 里 match="workdir" 的四条规则（cc_monitor/workdir.py 按
// "路径相对 cwd 在哪 × 读/写"分档），这里同样只按 matched_rule 归类，不在 JS 里重算
// 路径。注意这组规则排在规则表靠后的位置兜底：读 ~/.ssh 这种被更具体的规则先命中的
// 事件算在那条规则里（敏感操作卡片），不会重复出现在这里。
const WORKDIR_ESCAPE_ORDER = ["writeSensitive", "writeOther", "readSensitive", "readOther"];
const WORKDIR_ESCAPE_RULE_MAP = {
  workdir_escape_write_sensitive: "writeSensitive",
  workdir_escape_write_other: "writeOther",
  workdir_escape_read_sensitive: "readSensitive",
  workdir_escape_read_other: "readOther",
};
const WORKDIR_ESCAPE_RULES_SQL = Object.keys(WORKDIR_ESCAPE_RULE_MAP).map((r) => `'${r}'`).join(", ");
function workdirEscapeType(matchedRule) {
  return WORKDIR_ESCAPE_RULE_MAP[matchedRule] || null;
}

function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    db.function("cc_is_delete", isDeleteEvent);
    db.function("cc_github_op", githubOpType);
    db.function("cc_is_screenshot", isScreenCaptureEvent);
    db.function("cc_ssh_op", sshOpType);
    db.function("cc_download_op", downloadOpType);
    db.function("cc_docker_op", dockerOpType);
    db.function("cc_archive_op", archiveOpType);
    db.function("cc_netdiag_op", netdiagOpType);
    db.function("cc_reverseeng_op", reverseEngOpType);
    db.function("cc_procbg_op", processBackgroundType);
    db.function("cc_sensitive_op", sensitiveOpType);
    db.function("cc_sensitive_data", sensitiveDataType);
    db.function("cc_advanced_threat", advancedThreatType);
    db.function("cc_workdir_escape", workdirEscapeType);
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

// `transcript_path` 列是 cc_monitor/storage.py 那边升级后才懒加载 ALTER TABLE 加上的
// （见 storage.py 的 `_connect()`），旧数据库在第一次跑新版 hook 之前还没有这一列。
// Node 这边是只读连接，不能自己补列，所以查询前先探测一下，没有就优雅降级。
function hasTranscriptColumn(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    return cols.some((c) => c.name === "transcript_path");
  } catch (e) {
    return false;
  }
}

function listSessions(limit = 200) {
  return withDb((db) => {
    const withTranscript = hasTranscriptColumn(db);
    return db
      .prepare(
        `SELECT session_id, cwd, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS event_count,
                SUM(CASE WHEN decision = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
                SUM(CASE WHEN matched_rule = 'hook_bypass_suspected' THEN 1 ELSE 0 END) AS bypass_count
                ${withTranscript ? ", MAX(transcript_path) AS transcript_path" : ""}
         FROM events
         WHERE session_id IS NOT NULL AND session_id != ''
         GROUP BY session_id
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(limit);
  }, []);
}

function getTranscriptPath(sessionId) {
  return withDb((db) => {
    if (!hasTranscriptColumn(db)) return null;
    const row = db
      .prepare(
        `SELECT transcript_path FROM events
         WHERE session_id = ? AND transcript_path IS NOT NULL AND transcript_path != ''
         ORDER BY id DESC LIMIT 1`
      )
      .get(sessionId);
    return row ? row.transcript_path : null;
  }, null);
}

function queryEvents({ sessionId, sinceId = 0, limit = 300 } = {}) {
  return withDb((db) => {
    let sql = `SELECT id, ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail
               FROM events WHERE id > ?`;
    const params = [sinceId];
    if (sessionId) {
      sql += ` AND session_id = ?`;
      params.push(sessionId);
    }
    sql += ` ORDER BY id ASC LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params);
  }, []);
}

function stats() {
  return withDb((db) => {
    const byRisk = db.prepare(`SELECT risk, COUNT(*) AS n FROM events GROUP BY risk`).all();
    const byDecision = db.prepare(`SELECT decision, COUNT(*) AS n FROM events GROUP BY decision`).all();
    const bySource = db.prepare(`SELECT source, COUNT(*) AS n FROM events GROUP BY source`).all();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const sessionCount = db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
      .get().n;
    const blockedTotal = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE decision = 'blocked'`).get().n;
    const bypassTotal = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE matched_rule = 'hook_bypass_suspected'`)
      .get().n;
    return { total, sessionCount, blockedTotal, bypassTotal, byRisk, byDecision, bySource };
  }, { total: 0, sessionCount: 0, blockedTotal: 0, bypassTotal: 0, byRisk: [], byDecision: [], bySource: [] });
}

// 文件读/写/编辑/删除次数——删除没有专门的工具（Claude Code 没有内置"删文件"工具），
// 靠解析 Bash 命令文本（只看 detail.command 字段本身，按 ; & | 拆成子命令再看开头是不是
// rm/rmdir/unlink/shred/git rm/find -delete 等）来识别，见上面 commandDeletesFiles()。
// 不是 100% 精确（比如 $() 命令替换里的删除识别不到），但比之前的整串 LIKE 子串匹配准确得多。
const DELETE_CLAUSE = `source = 'hook_pre' AND tool_name = 'Bash' AND cc_is_delete(detail) = 1`;

function fileOpsStats() {
  return withDb((db) => {
    const countTool = (names) => {
      const placeholders = names.map(() => "?").join(",");
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN (${placeholders})`
        )
        .get(...names).n;
    };
    const reads = countTool(["Read"]);
    const writes = countTool(["Write"]);
    const edits = countTool(["Edit", "MultiEdit", "NotebookEdit"]);
    const deletes = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${DELETE_CLAUSE}`).get().n;
    return { reads, writes, edits, deletes };
  }, { reads: 0, writes: 0, edits: 0, deletes: 0 });
}

const FILE_OP_TOOLS = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit", "MultiEdit", "NotebookEdit"],
};

// 首页文件操作卡片（读/写/编辑/删除）的下钻详情：具体是哪些事件。
function fileOpDetails(type, limit = 300) {
  return withDb((db) => {
    if (type === "delete") {
      return db
        .prepare(`SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events WHERE ${DELETE_CLAUSE} ORDER BY id DESC LIMIT ?`)
        .all(limit);
    }
    const tools = FILE_OP_TOOLS[type];
    if (!tools) return [];
    const placeholders = tools.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...tools, limit);
  }, []);
}

// 软件安装统计——不用另外写识别逻辑，直接复用 policy 规则引擎已经判过的 matched_rule
// 分组就行（pip/系统包管理器/npm/其它这几类规则本来就在 default_rules.json 里维护着，
// 识别逻辑只有一份，不会跟 policy 那边判断的标准不一致）。
const INSTALL_RULE_GROUPS = {
  pip: ["sudo_pip_install", "pip_install_venv_context", "pip_install_no_venv"],
  system: ["system_package_install"],
  // 本地/全局两条规则都算进"npm 安装"这一张卡片的总数，点开详情时前端按
  // matchedRule 再拆成"本地安装"/"全局安装"两组分别列出（见 app.js 的
  // install-op-npm 特判），不是简单平铺一份列表。
  npm: ["npm_global_install", "npm_local_install"],
  other: ["package_install_other"],
};

function installStats() {
  return withDb((db) => {
    const countRules = (rules) => {
      const placeholders = rules.map(() => "?").join(",");
      return db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})`)
        .get(...rules).n;
    };
    return {
      pip: countRules(INSTALL_RULE_GROUPS.pip),
      system: countRules(INSTALL_RULE_GROUPS.system),
      npm: countRules(INSTALL_RULE_GROUPS.npm),
      other: countRules(INSTALL_RULE_GROUPS.other),
    };
  }, { pip: 0, system: 0, npm: 0, other: 0 });
}

// 首页软件安装统计卡片（pip/系统包/npm/其它）的下钻详情：具体是哪些安装指令。
function installDetails(type, limit = 300) {
  const rules = INSTALL_RULE_GROUPS[type];
  if (!rules) return [];
  return withDb((db) => {
    const placeholders = rules.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...rules, limit);
  }, []);
}

// GitHub/SSH/下载/Docker/压缩/网络诊断/进程管理这七组操作统计——首页原来每组各
// 占一整排细分类卡片（合计 30+ 张），刷屏太厉害；改成每组只放一张汇总卡片，点开
// 才展示这套分类的小计表 + 事件明细，跟 MCP/Skill/子代理调用卡片同一个交互模式。
// 七组背后都是"按 cc_xxx_op() 自定义 SQL 函数分类、GROUP BY kind"这同一个查询
// 形状，抽成两个通用函数，各组只是传不同的函数名进去。
function opsBreakdown(sqlFn) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT ${sqlFn}(detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash' AND ${sqlFn}(detail) IS NOT NULL
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function opsEvents(sqlFn, limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, ${sqlFn}(detail) AS kind FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash' AND ${sqlFn}(detail) IS NOT NULL
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

function githubOpsBreakdown() {
  return opsBreakdown("cc_github_op");
}
function githubOpsEvents(limit = 300) {
  return opsEvents("cc_github_op", limit);
}
function sshOpsBreakdown() {
  return opsBreakdown("cc_ssh_op");
}
function sshOpsEvents(limit = 300) {
  return opsEvents("cc_ssh_op", limit);
}
function downloadOpsBreakdown() {
  return opsBreakdown("cc_download_op");
}
function downloadOpsEvents(limit = 300) {
  return opsEvents("cc_download_op", limit);
}
function dockerOpsBreakdown() {
  return opsBreakdown("cc_docker_op");
}
function dockerOpsEvents(limit = 300) {
  return opsEvents("cc_docker_op", limit);
}
function archiveOpsBreakdown() {
  return opsBreakdown("cc_archive_op");
}
function archiveOpsEvents(limit = 300) {
  return opsEvents("cc_archive_op", limit);
}
function netdiagOpsBreakdown() {
  return opsBreakdown("cc_netdiag_op");
}
function netdiagOpsEvents(limit = 300) {
  return opsEvents("cc_netdiag_op", limit);
}
function reverseEngOpsBreakdown() {
  return opsBreakdown("cc_reverseeng_op");
}
function reverseEngOpsEvents(limit = 300) {
  return opsEvents("cc_reverseeng_op", limit);
}
function procbgOpsBreakdown() {
  return opsBreakdown("cc_procbg_op");
}
function procbgOpsEvents(limit = 300) {
  return opsEvents("cc_procbg_op", limit);
}

// 敏感操作统计（SSH 密钥/凭据、Token、环境变量查找、其它敏感读取）——跟上面几组
// 不一样，不是按 tool_name='Bash' 过滤后再看单个 detail 字段分类，而是直接按
// 已经命中的 matched_rule 筛出 SENSITIVE_READ_RULES 那几条规则的事件（横跨
// Read/Grep 和 Bash 几种工具），所以没法
// 复用上面的通用 opsBreakdown()/opsEvents()，单独写。
function sensitiveOpsBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_sensitive_op(tool_name, matched_rule, detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${SENSITIVE_READ_RULES_SQL})
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function sensitiveOpsEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_sensitive_op(tool_name, matched_rule, detail) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${SENSITIVE_READ_RULES_SQL})
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 敏感数据统计——查询形状跟上面 sensitiveOpsBreakdown/sensitiveOpsEvents 一样，
// 只是筛的 matched_rule 集合不同（见 sensitiveDataType 上面的注释）。
function sensitiveDataBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_sensitive_data(tool_name, matched_rule, detail) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN ('secret_pattern_in_write', 'pii_pattern_in_write', 'cloud_vpn_config_write', 'cloud_vpn_config_read')
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function sensitiveDataEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_sensitive_data(tool_name, matched_rule, detail) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN ('secret_pattern_in_write', 'pii_pattern_in_write', 'cloud_vpn_config_write', 'cloud_vpn_config_read')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 高级威胁检测——查询形状跟上面 sensitiveOpsBreakdown/sensitiveDataBreakdown 一样，
// 只是分类函数只需要 matched_rule 一个参数（见 advancedThreatType 上面的注释，
// 不需要再检查字段内容消歧）。
function advancedThreatBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_advanced_threat(matched_rule) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${ADVANCED_THREAT_RULES_SQL})
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function advancedThreatEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_advanced_threat(matched_rule) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${ADVANCED_THREAT_RULES_SQL})
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 跨工作目录操作——查询形状跟 advancedThreatBreakdown/advancedThreatEvents 一样。
function workdirEscapeBreakdown() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT cc_workdir_escape(matched_rule) AS kind, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${WORKDIR_ESCAPE_RULES_SQL})
         GROUP BY kind ORDER BY n DESC`
      )
      .all();
  }, []);
}

function workdirEscapeEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail, cc_workdir_escape(matched_rule) AS kind FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${WORKDIR_ESCAPE_RULES_SQL})
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 首页"截屏审计"卡片：单一计数，不像软件安装/GitHub 操作那样拆细分类——截屏本来
// 就不常发生，没必要再按来源（Bash/Read/MCP）拆成好几张卡片，下钻列表里每一行的
// 工具名本身就能看出是哪种来源。
function screenshotStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND cc_is_screenshot(tool_name, detail) = 1`).get().n;
    return { total };
  }, { total: 0 });
}

function screenshotDetails(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND cc_is_screenshot(tool_name, detail) = 1
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 工具调用统计——"审计事件总数"是 hook_pre + hook_post + os_net 全部加一起的，
// 同一次工具调用至少算两条（pre 一条、post 一条），这里只数 hook_pre，对应的是
// "Claude Code 真的发起过多少次工具调用"这个更直观的数字。
function toolCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre'`).get().n;
    return { total };
  }, { total: 0 });
}

// 首页"工具调用"卡片下钻：按工具名分组的次数明细（不是每条事件平铺列出来——
// 光是"调用过多少次 Bash"这种数字，比翻一屏事件列表更有信息量）。
function toolCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre'
         GROUP BY tool_name ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// MCP 工具调用——Claude Code 给 MCP server 提供的工具统一命名成
// `mcp__<server>__<tool>` 这个格式，不用另外维护一份 MCP server 列表，直接按
// tool_name 前缀识别就行。
const MCP_TOOL_PATTERN = "mcp\\_\\_%";

function mcpCallStats() {
  return withDb((db) => {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'`)
      .get(MCP_TOOL_PATTERN).n;
    return { total };
  }, { total: 0 });
}

// 首页"MCP 调用"卡片下钻：按 MCP server 分组（从 tool_name 里 mcp__<server>__<tool>
// 这个约定格式解析出 server 名字），而不是按具体工具名——同一个 server 底下可能有
// 十几个工具，按 server 汇总更容易看出"到底在跟哪个 MCP 服务打交道"。
function mcpCallBreakdown(limit = 100) {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT tool_name, COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\' GROUP BY tool_name`)
      .all(MCP_TOOL_PATTERN);
    const byServer = new Map();
    for (const r of rows) {
      const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(r.tool_name);
      const server = m ? m[1] : r.tool_name;
      byServer.set(server, (byServer.get(server) || 0) + r.n);
    }
    return [...byServer.entries()]
      .map(([server, n]) => ({ server, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit);
  }, []);
}

// Skill 调用——跟 MCP 调用同一个思路，只是分组用的不是 tool_name 前缀，而是
// tool_input 里的 skill 字段本身（`Skill` 这个工具名固定不变，具体调用的是哪个
// skill 全在 detail.skill 里）。SQLite 自带的 json_extract 直接在 SQL 里取，
// 不用先把每一行 detail 都读出来在 JS 里 JSON.parse 一遍。
function skillCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'`).get().n;
    return { total };
  }, { total: 0 });
}

function skillCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT COALESCE(json_extract(detail, '$.skill'), '?') AS skill, COUNT(*) AS n
         FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'
         GROUP BY skill ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// Glob/Grep 调用统计——纯搜索类工具，本来就已经算在"工具调用"总数和它的按工具名
// 分组下钻里，这里单独拉出来是因为搜索操作本身是个值得单独一瞥的行为模式（翻了
// 多少次代码库），跟 MCP/Skill 调用同一个思路，只是分组字段用 tool_name 本身
// （Glob vs Grep），不需要 json_extract 从 detail 里再挑一层。
function searchCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN ('Glob', 'Grep')`).get().n;
    return { total };
  }, { total: 0 });
}

function searchCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre' AND tool_name IN ('Glob', 'Grep')
         GROUP BY tool_name ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

function searchCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name FROM events
         WHERE source = 'hook_pre' AND tool_name IN ('Glob', 'Grep')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// TodoWrite 使用频率——纯统计，没有安全含义，只看调用了多少次；下钻的事件明细额外
// 带上每次调用时任务列表的条数（json_array_length 直接在 SQL 里算，不用先把每行
// detail 都读出来在 JS 里 JSON.parse 一遍），不展示任务的具体文字内容——跟其它
// 下钻卡片一样，只给"发生过什么规模的操作"这类基本信息。
function todoCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'TodoWrite'`).get().n;
    return { total };
  }, { total: 0 });
}

function todoCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_array_length(detail, '$.todos'), 0) AS todoCount
         FROM events WHERE source = 'hook_pre' AND tool_name = 'TodoWrite'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 工具调用/MCP 调用/Skill 调用这三张卡片下钻的"事件明细"部分——按工具名分组的次数
// 只能看出"用得多不多"，看不出"具体是哪个 session、哪个目录、什么时候调用的"，
// 这三个函数专门补这块：平铺列出最近的事件，带 Session ID/cwd/时间戳。
function toolCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(`SELECT id, ts, session_id, cwd, tool_name FROM events WHERE source = 'hook_pre' ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }, []);
}

function mcpCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name FROM events
         WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT ?`
      )
      .all(MCP_TOOL_PATTERN, limit);
  }, []);
}

function skillCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_extract(detail, '$.skill'), '?') AS skill FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Skill'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 子代理（Task/Agent）派生统计——跟 MCP/Skill 调用完全同一个思路，只是分组字段
// 换成 tool_input 里的 subagent_type（"用的是哪个子代理类型"，比如
// general-purpose/Explore/Plan/fork，或者用户自定义的子代理名字）。Claude Code
// 不同版本这个工具名叫 "Task" 还是 "Agent" 不完全一致，两个都认。子代理本身会
// 消耗独立的资源、有自己的一整套操作轨迹，值得单独拉出来看，而不是混在笼统的
// "工具调用"计数里。
function subagentCallStats() {
  return withDb((db) => {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN ('Task', 'Agent')`)
      .get().n;
    return { total };
  }, { total: 0 });
}

function subagentCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT COALESCE(json_extract(detail, '$.subagent_type'), '?') AS subagentType, COUNT(*) AS n
         FROM events WHERE source = 'hook_pre' AND tool_name IN ('Task', 'Agent')
         GROUP BY subagentType ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

function subagentCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_extract(detail, '$.subagent_type'), '?') AS subagentType,
                COALESCE(json_extract(detail, '$.description'), '') AS description
         FROM events WHERE source = 'hook_pre' AND tool_name IN ('Task', 'Agent')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// AI 轨迹卡片下钻的事件明细部分——两种不同性质的证据拼在一起，靠 inferred 字段
// 区分：
//   - 探针实测（source='os_net'，inferred=false）：探针只在内核层面看到 pid/uid，
//     天生不知道"这属于 Claude Code 的哪个 session"，所以 sessionId/cwd 在这些行
//     里永远是空的，不是查询漏了字段——前端要如实显示"不可用"，不能编一个假的
//     出来。能给的是时间戳和 pid（探针观测到的进程号，勉强算是"哪个进程"的线索）。
//   - 命令文本推断（inferred=true）：来自 commandNetworkHosts()，有 sessionId/cwd/
//     具体命令，但没有 pid（这条命令有没有真的连通、连的是不是文本里那个 host，
//     都只是"看起来像"，不是探针那种内核级别的确认）。
function networkConnectEvents(limit = 300) {
  const observed = withDb((db) => {
    const rows = db
      .prepare(`SELECT id, ts, tool_name, detail FROM events WHERE source = 'os_net' ORDER BY id DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => {
      let detail = {};
      try {
        detail = r.detail ? JSON.parse(r.detail) : {};
      } catch (e) {
        detail = {};
      }
      return {
        id: r.id,
        ts: r.ts,
        comm: r.tool_name,
        pid: detail.pid,
        ip: detail.ip,
        port: detail.port,
        host: detail.host,
        inferred: false,
      };
    });
  }, []);
  const inferred = commandNetworkHosts(limit).map((e) => ({
    id: "cmd-" + e.id + "-" + e.host,
    ts: e.ts,
    comm: e.command,
    pid: null,
    ip: null,
    port: null,
    host: e.host,
    sessionId: e.sessionId,
    cwd: e.cwd,
    inferred: true,
  }));
  return observed
    .concat(inferred)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, limit);
}

// "审计事件总数"下钻：按 工具/来源 分组，并且列出每个分组具体是哪些 session 产生的。
function eventTypeBreakdown(limit = 500) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT source, tool_name, session_id, COUNT(*) AS n
         FROM events
         GROUP BY source, tool_name, session_id
         ORDER BY n DESC`
      )
      .all();
    const byType = new Map();
    for (const r of rows) {
      const key = `${r.source}::${r.tool_name || ""}`;
      if (!byType.has(key)) {
        byType.set(key, { source: r.source, toolName: r.tool_name, total: 0, sessions: [] });
      }
      const entry = byType.get(key);
      entry.total += r.n;
      if (r.session_id) entry.sessions.push({ sessionId: r.session_id, count: r.n });
    }
    return [...byType.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  }, []);
}

// "拦截的高危操作"下钻：具体是哪些命令/操作被挡下来的。
function blockedDetails(limit = 200) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail
         FROM events WHERE decision = 'blocked'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

module.exports = {
  listSessions,
  queryEvents,
  stats,
  dbPath,
  getTranscriptPath,
  fileOpsStats,
  fileOpDetails,
  installStats,
  installDetails,
  githubOpsBreakdown,
  githubOpsEvents,
  sshOpsBreakdown,
  sshOpsEvents,
  downloadOpsBreakdown,
  downloadOpsEvents,
  dockerOpsBreakdown,
  dockerOpsEvents,
  archiveOpsBreakdown,
  archiveOpsEvents,
  netdiagOpsBreakdown,
  netdiagOpsEvents,
  reverseEngOpsBreakdown,
  reverseEngOpsEvents,
  procbgOpsBreakdown,
  procbgOpsEvents,
  sensitiveOpsBreakdown,
  sensitiveOpsEvents,
  sensitiveDataBreakdown,
  sensitiveDataEvents,
  advancedThreatBreakdown,
  advancedThreatEvents,
  workdirEscapeBreakdown,
  workdirEscapeEvents,
  screenshotStats,
  screenshotDetails,
  commandNetworkHosts,
  toolCallStats,
  toolCallBreakdown,
  mcpCallStats,
  mcpCallBreakdown,
  skillCallStats,
  skillCallBreakdown,
  subagentCallStats,
  subagentCallBreakdown,
  searchCallStats,
  searchCallBreakdown,
  todoCallStats,
  toolCallEvents,
  mcpCallEvents,
  skillCallEvents,
  subagentCallEvents,
  searchCallEvents,
  todoCallEvents,
  networkConnectEvents,
  eventTypeBreakdown,
  blockedDetails,
};
