#!/usr/bin/env node
/**
 * 下载 portable Node.js 二进制到 plugin/runtime/<platform>/
 * 给 GUI 安装器（Inno Setup）打包 / 用户机器没装 Node 也能跑。
 *
 * 用法：
 *   node tools/bundle-node.js           # 默认下当前平台 (NODE_PLATFORM=auto)
 *   node tools/bundle-node.js --all     # win-x64 + darwin-x64 + darwin-arm64 三平台全下
 *   node tools/bundle-node.js --version v22.11.0
 *
 * 输出目录：
 *   plugin/runtime/node-win-x64/node.exe
 *   plugin/runtime/node-darwin-x64/bin/node
 *   plugin/runtime/node-darwin-arm64/bin/node
 *   plugin/runtime/node-linux-x64/bin/node
 *   plugin/runtime/node-linux-arm64/bin/node
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const DEFAULT_VERSION = "v22.11.0";   // LTS 时刻；可用 --version 覆盖
const MIRROR = "https://nodejs.org/dist";
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.join(ROOT, "runtime");

function parseArgs() {
  const args = process.argv.slice(2);
  let version = DEFAULT_VERSION;
  let all = false;
  const platforms = []; // 指定一个或多个 --platform 后该数组非空，覆盖默认行为
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--all") all = true;
    else if (args[i] === "--version" && args[i + 1]) { version = args[i + 1]; i += 1; }
    else if (args[i] === "--platform" && args[i + 1]) { platforms.push(args[i + 1]); i += 1; }
  }
  // 修 T1：严格校验版本号格式。version 会被拼进下载 URL、临时文件路径，以及（Win）
  // PowerShell 的 -Command 单引号字符串。不校验的话 `--version "v22'; calc; '"` 可注入命令、
  // `..` 可路径穿越。Node 版本号只可能是 vX.Y.Z。
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    console.error(`[bundle-node] 非法的版本号：${version}（应形如 v22.11.0）`);
    process.exit(1);
  }
  return { version, all, platforms };
}

// 平台 → { fileSuffix, archiveExt, outDir }
const PLATFORM_MAP = {
  "win-x64":      { archive: "win-x64.zip",         outDir: "node-win-x64" },
  "darwin-x64":   { archive: "darwin-x64.tar.gz",   outDir: "node-darwin-x64" },
  "darwin-arm64": { archive: "darwin-arm64.tar.gz", outDir: "node-darwin-arm64" },
  "linux-x64":    { archive: "linux-x64.tar.xz",    outDir: "node-linux-x64" },
  "linux-arm64":  { archive: "linux-arm64.tar.xz",  outDir: "node-linux-arm64" }
};

function detectPlatform() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32") return "win-x64";
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (p === "linux")  return a === "arm64" ? "linux-arm64"  : "linux-x64";
  throw new Error(`不支持的平台 ${p}/${a}，请用 --all 或显式指定`);
}

function download(url, destFile, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    // 只允许 https，挡住重定向被降级到 http。
    if (!/^https:\/\//i.test(url)) {
      return reject(new Error(`拒绝非 https 下载地址：${url}`));
    }
    const file = fs.createWriteStream(destFile);
    const fail = (err) => {
      try { file.close(); } catch (_) {}
      try { fs.unlinkSync(destFile); } catch (_) {}
      reject(err);
    };
    file.on("error", fail); // 修 #5：写盘错误（磁盘满等）也要处理，否则 unhandled error 崩进程
    let receivedBytes = 0;
    let totalBytes = 0;
    let lastReported = 0;
    const handle = (res) => {
      // 修 #4：处理 301/302/303/307/308，且限制重定向次数，重定向目标也校验 https。
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume(); // 排空响应体，避免 socket 挂起
        try { file.close(); } catch (_) {}
        try { fs.unlinkSync(destFile); } catch (_) {}
        if (redirectsLeft <= 0) return reject(new Error(`重定向次数过多：${url}`));
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`重定向缺少 Location：${url}`));
        const next = new URL(loc, url).toString();
        return download(next, destFile, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      res.on("error", fail); // 修 #5：mid-stream socket reset
      totalBytes = parseInt(res.headers["content-length"] || "0", 10);
      res.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (totalBytes && receivedBytes - lastReported > totalBytes / 20) {
          lastReported = receivedBytes;
          const pct = Math.round((receivedBytes / totalBytes) * 100);
          process.stdout.write(`\r  下载中... ${pct}% (${(receivedBytes/1024/1024).toFixed(1)}MB / ${(totalBytes/1024/1024).toFixed(1)}MB)`);
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        // 修 #5：短读（Content-Length 与实际收到不符）视为失败，不当成"下载完成"。
        if (totalBytes && receivedBytes !== totalBytes) {
          return fail(new Error(`下载不完整：${receivedBytes}/${totalBytes} 字节`));
        }
        process.stdout.write("\r  下载完成: " + (receivedBytes/1024/1024).toFixed(1) + " MB                          \n");
        file.close(() => resolve());
      });
    };
    https.get(url, handle).on("error", fail);
  });
}

// 拉一个小文本（SHASUMS256.txt），跟着重定向。
function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) return reject(new Error(`拒绝非 https：${url}`));
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("重定向次数过多"));
        const next = new URL(res.headers.location, url).toString();
        return fetchText(next, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${url}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function sha256File(p) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

// 从 SHASUMS256.txt 里查某个文件名对应的期望 sha256。
function expectedHashFromShasums(shasums, filename) {
  for (const line of shasums.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return null;
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

// 用系统 tar 解 .tar.gz / .tar.xz（Win10+ / Mac / Linux 都自带 tar; xz 在 Linux/Mac 普遍内置,Win10+ 也支持）
function extractTar(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // tar 会按文件名自动检测压缩格式(--auto-compress),所以不用区分 -z/-J
  execFileSync("tar", ["-xf", archive, "-C", outDir, "--strip-components=1"], { stdio: "inherit" });
}

// 解 zip：用 PowerShell Expand-Archive（Win）或 unzip（Mac/Linux 退路）
function extractZip(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // 解到临时目录再把内层（node-vXX-win-x64/）的内容移到 outDir
  const tmp = path.join(os.tmpdir(), "lingxi-node-extract-" + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`], { stdio: "inherit" });
    } else {
      execFileSync("unzip", ["-q", archive, "-d", tmp], { stdio: "inherit" });
    }
    // 找到那个唯一的子目录 node-vXX-win-x64
    const subs = fs.readdirSync(tmp).filter((n) => fs.statSync(path.join(tmp, n)).isDirectory());
    if (subs.length === 0) throw new Error("zip 解压结果异常，没有子目录");
    const inner = path.join(tmp, subs[0]);
    // 把内层目录"提升"到 outDir。跨盘符不能 rename,用复制
    for (const name of fs.readdirSync(inner)) {
      const src = path.join(inner, name);
      const dst = path.join(outDir, name);
      try {
        fs.renameSync(src, dst);
      } catch (e) {
        if (e.code === "EXDEV") {
          // 跨设备：递归 cpSync（Node >= 16.7）
          fs.cpSync(src, dst, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
        } else { throw e; }
      }
    }
  } finally {
    rmrf(tmp);
  }
}

function pruneBundledNode(platform, outDir) {
  const keep = new Set(platform.startsWith("win-")
    ? ["node.exe", "LICENSE"]
    : [path.join("bin", "node"), "LICENSE"]);

  function walk(dir, rel = "") {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const childRel = rel ? path.join(rel, name) : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        walk(abs, childRel);
        try {
          if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
        } catch (_) {}
        continue;
      }
      if (!keep.has(childRel)) fs.rmSync(abs, { force: true });
    }
  }

  walk(outDir);
}

async function bundleOne(platform, version) {
  const spec = PLATFORM_MAP[platform];
  if (!spec) throw new Error("未知平台: " + platform);

  const filename = `node-${version}-${spec.archive}`;
  const url = `${MIRROR}/${version}/${filename}`;
  const outDir = path.join(RUNTIME_ROOT, spec.outDir);
  const cacheArchive = path.join(os.tmpdir(), filename);

  console.log(`\n[bundle-node] 平台: ${platform}, 版本: ${version}`);
  console.log(`              输出: ${outDir}`);

  // 如果 outDir 已经有 node 二进制，跳过
  const nodeBinPath = platform.startsWith("win-")
    ? path.join(outDir, "node.exe")
    : path.join(outDir, "bin", "node");
  if (fs.existsSync(nodeBinPath)) {
    pruneBundledNode(platform, outDir);
    console.log(`  已存在,跳过: ${nodeBinPath}`);
    return;
  }

  // 修 T1：先取该版本的 SHASUMS256.txt，用来校验归档完整性（供应链防护）。
  const expectedHash = expectedHashFromShasums(
    await fetchText(`${MIRROR}/${version}/SHASUMS256.txt`),
    filename
  );
  if (!expectedHash) {
    throw new Error(`SHASUMS256.txt 里找不到 ${filename} 的校验值，拒绝继续`);
  }

  // 下载
  if (!fs.existsSync(cacheArchive)) {
    console.log(`  下载: ${url}`);
    await download(url, cacheArchive);
  } else {
    console.log(`  用缓存: ${cacheArchive}`);
  }

  // 修 T1/#2：无论新下的还是命中缓存，都校验 sha256。缓存目录 os.tmpdir() 可能被同机其他
  // 用户预植入同名恶意文件；校验不过就删掉重下一次，仍不过则失败退出，绝不打包未验证的二进制。
  let actualHash = sha256File(cacheArchive);
  if (actualHash !== expectedHash) {
    console.warn(`  [WARN] 缓存/下载校验不通过（期望 ${expectedHash.slice(0, 12)}… 实得 ${actualHash.slice(0, 12)}…），删除重下`);
    try { fs.unlinkSync(cacheArchive); } catch (_) {}
    await download(url, cacheArchive);
    actualHash = sha256File(cacheArchive);
    if (actualHash !== expectedHash) {
      try { fs.unlinkSync(cacheArchive); } catch (_) {}
      throw new Error(`SHA256 校验失败：${filename}（期望 ${expectedHash}，实得 ${actualHash}）`);
    }
  }
  console.log(`  校验通过 sha256=${actualHash.slice(0, 16)}…`);

  // 清旧 outDir 然后解压
  rmrf(outDir);
  if (spec.archive.endsWith(".zip")) extractZip(cacheArchive, outDir);
  else extractTar(cacheArchive, outDir);

  if (!fs.existsSync(nodeBinPath)) {
    throw new Error("解压完没找到 node 二进制: " + nodeBinPath);
  }
  pruneBundledNode(platform, outDir);
  const size = fs.statSync(nodeBinPath).size;
  console.log(`  完成: ${nodeBinPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  const { version, all, platforms } = parseArgs();
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  let targets;
  if (platforms.length > 0) {
    const unknown = platforms.filter((p) => !PLATFORM_MAP[p]);
    if (unknown.length > 0) {
      console.error(`[bundle-node] 不支持的平台 key：${unknown.join(', ')}`);
      console.error(`  可选：${Object.keys(PLATFORM_MAP).join(' / ')}`);
      process.exit(1);
    }
    targets = platforms;
  } else {
    targets = all ? Object.keys(PLATFORM_MAP) : [detectPlatform()];
  }
  for (const p of targets) {
    try {
      await bundleOne(p, version);
    } catch (e) {
      console.error(`[bundle-node] 平台 ${p} 失败: ${e.message}`);
    }
  }
  console.log("\n[bundle-node] 全部处理完毕");
}

main().catch((e) => { console.error(e); process.exit(1); });
