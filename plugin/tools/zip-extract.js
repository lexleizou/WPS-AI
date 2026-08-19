// 极小 ZIP 解压实现（仅 deflate / store 两种 method，覆盖 PowerShell Compress-Archive 和 zip -r 生成的所有产物）。
// 用 Node 内置 zlib，没有外部依赖；替代 /update/apply 里 PowerShell Expand-Archive 链路 ——
// 后者在中文 Windows 上常见编码 / PATH / 转义问题，定位到「解压失败: unknown」就走不下去了。
//
// 不支持 ZIP64（>2GB）/ 加密 / 多卷 —— 热更新包 1MB 级别用不到。

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// 找 EOCD（End Of Central Directory）签名 0x06054b50。一般在文件末尾 22 字节处，
// 但允许 ZIP 注释 → 实际可能往前 65535 字节内
function findEocd(buf) {
  const SIG = 0x06054b50;
  const maxBack = Math.min(buf.length, 65557); // EOCD 固定 22 字节 + 最多 65535 注释
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  throw new Error("EOCD 未找到，文件不是合法 ZIP（或被截断）");
}

// 读 central directory，返回 [{name, method, compressedSize, uncompressedSize, localHeaderOffset, isDir}]
function readCentralDirectory(buf) {
  const eocdOff = findEocd(buf);
  const numEntries = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOffset = buf.readUInt32LE(eocdOff + 16);
  const entries = [];
  let p = cdOffset;
  const SIG_CD = 0x02014b50;
  for (let i = 0; i < numEntries; i++) {
    if (buf.readUInt32LE(p) !== SIG_CD) throw new Error(`central directory 第 ${i} 项签名错`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDir: name.endsWith("/") || name.endsWith("\\")
    });
    p += 46 + nameLen + extraLen + commentLen;
    if (p > eocdOff) throw new Error("central directory 越界");
  }
  return entries;
}

// 从 local header 位置算出真正的数据起点（要跳过 local header 的 name/extra）
function dataStart(buf, localOff) {
  const SIG_LF = 0x04034b50;
  if (buf.readUInt32LE(localOff) !== SIG_LF) throw new Error("local file header 签名错");
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  return localOff + 30 + nameLen + extraLen;
}

// 防 zip-slip：解出来的相对路径不能逃出 destRoot
function safeJoin(destRoot, name) {
  // 兼容 windows / unix 分隔符
  const normalized = name.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.includes("..")) throw new Error(`非法路径(含 ..): ${name}`);
  const out = path.resolve(destRoot, normalized);
  if (!out.startsWith(path.resolve(destRoot) + path.sep) && out !== path.resolve(destRoot)) {
    throw new Error(`路径越界: ${name}`);
  }
  return out;
}

function extractZip(zipPath, destRoot) {
  const buf = fs.readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  let fileCount = 0;
  for (const e of entries) {
    const outPath = safeJoin(destRoot, e.name);
    if (e.isDir) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const start = dataStart(buf, e.localHeaderOffset);
    const raw = buf.slice(start, start + e.compressedSize);
    let data;
    if (e.method === 0) {
      data = raw;
    } else if (e.method === 8) {
      // 修 T8：用中央目录里的 uncompressedSize 作为 maxOutputLength 上限，防 zip bomb（小压缩流
      // 膨胀成几百 MB/GB 直接 OOM）。之前是先全量 inflate 再检查大小，太晚了。
      const cap = Number(e.uncompressedSize) || 0;
      data = zlib.inflateRawSync(raw, { maxOutputLength: cap > 0 ? cap : 1 });
    } else {
      throw new Error(`不支持的压缩方法 ${e.method}（仅 store / deflate）: ${e.name}`);
    }
    if (data.length !== e.uncompressedSize) {
      throw new Error(`解压后大小不符: ${e.name} expected=${e.uncompressedSize} actual=${data.length}`);
    }
    fs.writeFileSync(outPath, data);
    fileCount += 1;
  }
  return { fileCount, entryCount: entries.length };
}

module.exports = { extractZip };
