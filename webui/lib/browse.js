"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// 给"新建终端会话"弹窗里的文件夹浏览器用——只列子目录，不列文件（选的是 cwd，
// 不是某个具体文件）。这台机器上本来就允许直接在 cwd 输入框里打任意路径去开
// 一个 shell，浏览目录本身不会比这个开放更多权限，就不额外加白名单限制了。
function listDir(dirPath) {
  const target = path.resolve(dirPath || os.homedir());
  let names;
  try {
    names = fs.readdirSync(target, { withFileTypes: true });
  } catch (e) {
    return { error: `打不开这个目录：${e.message}` };
  }
  const dirs = names
    .filter((d) => {
      if (!d.isDirectory() && !d.isSymbolicLink()) return false;
      if (d.isSymbolicLink()) {
        // 符号链接要实际 stat 一下确认指向的是目录，不然点进去会直接 500。
        try {
          return fs.statSync(path.join(target, d.name)).isDirectory();
        } catch (e) {
          return false;
        }
      }
      return true;
    })
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    dirs,
  };
}

module.exports = { listDir };
