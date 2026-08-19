const fs = require("fs");
const path = require("path");
const os = require("os");

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getMacJsaddonsDirs(home = os.homedir()) {
  return [
    path.join(home, "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons"),
    path.join(home, "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons")
  ];
}

function getMacPublishPaths(home = os.homedir()) {
  return getMacJsaddonsDirs(home).map((dir) => path.join(dir, "publish.xml"));
}

function getMacAuthAddinPaths(home = os.homedir()) {
  return getMacJsaddonsDirs(home).map((dir) => path.join(dir, "authaddin.json"));
}

function normalizePathPrefix(pathPrefix) {
  const raw = String(pathPrefix || "").trim();
  if (!raw || raw === "/") return "/";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return `${prefixed.replace(/\/+$/, "")}/`;
}

function buildDevPublishXml(existingXml, options) {
  const addonType = options.addonType || "wps";
  const name = options.name || "lingxi-ai";
  const port = options.port || 3889;
  const urlPath = normalizePathPrefix(options.pathPrefix);
  const entry = `  <jspluginonline name="${escapeXml(name)}" type="${escapeXml(addonType)}" url="http://127.0.0.1:${escapeXml(port)}${escapeXml(urlPath)}" debug="" enable="enable_dev" install="null"/>`;
  const others = getNonLingxiPublishLines(existingXml);

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<jsplugins>',
    ...others,
    entry,
    '</jsplugins>',
    ''
  ].join("\n");
}

function getNonLingxiPublishLines(existingXml) {
  // 保留除 dev 自己条目外的所有 jspluginonline 行——含安装版 lingxi-ai-{wps,et,wpp,pdf} 与其它厂商插件。
  // 之前用 !/lingxi-ai/ 会把安装版四条一起删掉：mac dev 启动(buildDevPublishXml)时删、退出
  // (pruneLingxiPublishXml)时也删 → 「dev 期间/退出后本机安装版消失」。改成只删精确 dev 名。
  return String(existingXml || "")
    .split(/\r?\n/)
    .filter((line) => /jspluginonline/i.test(line) && !isDevPublishLine(line));
}

function pruneLingxiPublishXml(existingXml) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<jsplugins>',
    ...getNonLingxiPublishLines(existingXml),
    '</jsplugins>',
    ''
  ].join("\n");
}

function writeMacDevPublish(options) {
  const paths = options.paths || getMacPublishPaths(options.home);
  let count = 0;
  for (const target of paths) {
    try {
      let existingXml = "";
      if (fs.existsSync(target)) existingXml = fs.readFileSync(target, "utf8");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buildDevPublishXml(existingXml, options), "utf8");
      count += 1;
    } catch (error) {
      // Some WPS containers may not exist or may be temporarily locked.
    }
  }
  return count;
}

function getWindowsPublishPath(appData = process.env.APPDATA) {
  if (!appData) return "";
  return path.join(appData, "kingsoft", "wps", "jsaddons", "publish.xml");
}

function windowsPublishHasPluginEntries(xml) {
  // 有任意子节点 <jspluginonline .../> 或离线 <jsplugin .../> → 非空壳。
  // 注意只认子节点，别把容器根标签 <jsplugins> 误判成条目（它就是 jsplugin + "s>"）。
  return /<jspluginonline|<jsplugin[\s/]/i.test(String(xml || ""));
}

function isDevPublishLine(line) {
  // dev 自己写的 online 条目名：wpsjs debug 用 name="lingxi-ai"（package.json name，四宿主都一样），
  // Windows 静态兜底用 "lingxi-ai-dev"，mac 用带随机后缀的 "lingxi-ai-dev-<suffix>"。这些是 dev
  // 才需要退出时清掉的。
  //
  // 关键：永久安装版注册的是带宿主后缀的 name="lingxi-ai-wps"/"lingxi-ai-et"/"lingxi-ai-wpp"/"lingxi-ai-pdf"
  // （见 tools/post-install-{windows.bat,mac.sh}），必须精确区分、绝不能误删——否则 dev 启动/退出会把
  // 安装版一起清掉，导致「dev 期间/退出后本机安装版不再显示」。所以只匹配精确的 dev 名，
  // 不能用宽泛的 /lingxi-ai/：lingxi-ai 或 lingxi-ai-dev*，但不含 lingxi-ai-{wps,et,wpp,pdf}。
  return /<jspluginonline/i.test(line) && /name="lingxi-ai(-dev[A-Za-z0-9_-]*)?"/i.test(line);
}

function getKeptWindowsPublishLines(xml) {
  // 保留除 dev 自己条目外的所有行：安装版 lingxi-ai-{wps,et,wpp,pdf}、其它厂商插件、
  // 离线 <jsplugin>、xml 声明与 <jsplugins> 容器标签都原样留下（保持原格式，不重排）。
  return String(xml || "").split(/\r?\n/).filter((line) => !isDevPublishLine(line));
}

function removeWindowsDevPublish(options = {}) {
  // 退出 dev 时只清掉 dev 自己的 online 条目（wps/et/wpp/pdf 共用同一个 publish.xml，
  // dev 名恒为 lingxi-ai 或 lingxi-ai-dev），精确保留安装版及其它插件条目。
  const target = options.path || getWindowsPublishPath(options.appData);
  if (!target) return 0;
  try {
    if (!fs.existsSync(target)) return 0;
    const existingXml = fs.readFileSync(target, "utf8");
    const lines = existingXml.split(/\r?\n/);
    if (!lines.some(isDevPublishLine)) return 0; // 没有 dev 条目 → 不动（安装版独占时的常态）

    const kept = getKeptWindowsPublishLines(existingXml).join("\n");
    if (!windowsPublishHasPluginEntries(kept)) {
      // 删完没有任何插件条目：直接删掉文件，绝不写 <jsplugins></jsplugins> 空壳。
      // wpsjs debug 用 xml2js 解析「带空白的空 <jsplugins>」时会把节点当成字符串，它的
      // 判空 `=== ''` 漏掉这种情况 → 往字符串挂属性静默失败 → 每次启动都把 publish.xml
      // 写空、丢失注册（自我循环，杀进程/换端口都救不回）。文件不存在时 wpsjs 用内部默认
      // '<jsplugins></jsplugins>'（无空白）能正确解析并写入条目，所以「删文件」才是安全收尾。
      fs.rmSync(target, { force: true });
    } else {
      fs.writeFileSync(target, kept, "utf8");
    }
    return 1;
  } catch (error) {
    // publish.xml 是 WPS 共享文件；退出 dev 时尽力清理，失败不阻塞进程退出。
    return 0;
  }
}

function sanitizeWindowsPublish(options = {}) {
  // dev 启动前兜底：清掉历史遗留的「空壳 publish.xml」。只要文件里一个 <jsplugin 子节点都没有
  // （<jsplugins></jsplugins> 或带空白的空），就删掉它，让 wpsjs debug 从干净默认起，避免上面
  // 描述的 wpsjs 写空自我循环。有任何条目则原样保留（wpsjs 能正常解析非空 jsplugins）。
  const target = options.path || getWindowsPublishPath(options.appData);
  if (!target) return false;
  try {
    if (!fs.existsSync(target)) return false;
    const xml = fs.readFileSync(target, "utf8");
    if (windowsPublishHasPluginEntries(xml)) return false;
    fs.rmSync(target, { force: true });
    return true;
  } catch (error) {
    return false;
  }
}

function removeMacDevPublish(options = {}) {
  const paths = options.paths || getMacPublishPaths(options.home);
  let count = 0;
  for (const target of paths) {
    try {
      if (!fs.existsSync(target)) continue;
      const existingXml = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, pruneLingxiPublishXml(existingXml), "utf8");
      count += 1;
    } catch (error) {
      // publish.xml 是 WPS 共享文件；退出 dev 时尽力清理，失败不阻塞进程退出。
    }
  }
  return count;
}

function isLingxiAuthEntry(entry, options) {
  if (!entry || typeof entry !== "object") return false;
  const entryName = String(entry.name || "");
  if (/^lingxi-ai(?:-|$)/.test(entryName)) return true;

  const name = options.name || "";
  return Boolean(name && (entryName === name || entryName.startsWith(`${name}-`)));
}

function pruneLingxiAuthAddinState(state, options = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;

  const cleaned = {};
  for (const [host, hostState] of Object.entries(state)) {
    if (!hostState || typeof hostState !== "object" || Array.isArray(hostState)) {
      cleaned[host] = hostState;
      continue;
    }

    const nextHostState = {};
    const removedIds = new Set();
    for (const [id, value] of Object.entries(hostState)) {
      if (id === "namelist") continue;
      if (isLingxiAuthEntry(value, options)) {
        removedIds.add(id);
        continue;
      }
      nextHostState[id] = value;
    }

    if (Object.prototype.hasOwnProperty.call(hostState, "namelist")) {
      nextHostState.namelist = String(hostState.namelist || "")
        .split(";")
        .filter((id) => id && !removedIds.has(id) && Object.prototype.hasOwnProperty.call(nextHostState, id))
        .join(";");
    }
    cleaned[host] = nextHostState;
  }
  return cleaned;
}

function countLingxiAuthEntries(state, options) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return 0;
  let count = 0;
  for (const hostState of Object.values(state)) {
    if (!hostState || typeof hostState !== "object" || Array.isArray(hostState)) continue;
    for (const [id, value] of Object.entries(hostState)) {
      if (id !== "namelist" && isLingxiAuthEntry(value, options)) count += 1;
    }
  }
  return count;
}

function writeBackupOnce(target, raw) {
  const backup = `${target}.bak.lingxi-dev`;
  if (fs.existsSync(backup)) return;
  fs.writeFileSync(backup, raw, "utf8");
}

function cleanMacAuthCache(options = {}) {
  const paths = options.paths || getMacAuthAddinPaths(options.home);
  let files = 0;
  let entries = 0;

  for (const target of paths) {
    try {
      if (!fs.existsSync(target)) continue;
      const raw = fs.readFileSync(target, "utf8");
      const state = JSON.parse(raw);
      const removed = countLingxiAuthEntries(state, options);
      if (!removed) continue;
      const cleaned = pruneLingxiAuthAddinState(state, options);
      writeBackupOnce(target, raw);
      fs.writeFileSync(target, `${JSON.stringify(cleaned, null, 4)}\n`, "utf8");
      files += 1;
      entries += removed;
    } catch (error) {
      // authaddin.json 是 WPS 自己维护的缓存；解析失败或被锁定时跳过，避免影响 dev 启动。
    }
  }

  return { files, entries };
}

module.exports = {
  buildDevPublishXml,
  cleanMacAuthCache,
  getMacAuthAddinPaths,
  getMacPublishPaths,
  getKeptWindowsPublishLines,
  getWindowsPublishPath,
  isDevPublishLine,
  pruneLingxiPublishXml,
  pruneLingxiAuthAddinState,
  removeMacDevPublish,
  removeWindowsDevPublish,
  sanitizeWindowsPublish,
  windowsPublishHasPluginEntries,
  writeMacDevPublish
};
