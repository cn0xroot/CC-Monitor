"use strict";
// 轻量的"状态信息"数据源：不追求跟 ccstatusline 完全一致（那个是靠 Claude Code
// 自己喂的 transcript 元数据算 token/花费，hooks 拿不到这些），只汇总我们确实
//能拿到的东西：cwd、git 分支/是否有未提交改动、活跃时长、审计事件计数。
const { execFileSync } = require("child_process");

function git(cwd, args) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      timeout: 800,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim();
  } catch (e) {
    return null;
  }
}

function gitInfo(cwd) {
  if (!cwd) return { branch: null, dirty: null };
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return { branch: null, dirty: null };
  const status = git(cwd, ["status", "--porcelain"]);
  return { branch, dirty: status === null ? null : status.length > 0 };
}

module.exports = { gitInfo };
