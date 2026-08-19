const { spawnSync } = require("child_process");

function clipboardImageType(mimeOrPath = "") {
  const raw = String(mimeOrPath || "").toLowerCase();
  if (raw.includes("png") || raw.endsWith(".png")) return "PNGf";
  if (raw.includes("jpeg") || raw.includes("jpg") || raw.endsWith(".jpeg") || raw.endsWith(".jpg")) return "JPEG";
  return "";
}

// pbpaste/pbcopy 按 LC_CTYPE/LANG 决定文本编码，未设置时回落到非 UTF-8 的系统默认
// （Mac Roman/US-ASCII）→ 中文往返变乱码。而我们的代理是 launchd（LaunchAgent）拉起的，
// 不继承登录 shell 的 locale，plist 里也只设了端口变量，所以线上必然没有 LC_CTYPE。
// 这里显式钉死 UTF-8（等价于 Windows 分支的 windowsUtf8ConsolePreamble）。
// 只覆盖 LC_CTYPE：它只管字符编码，不影响 messages/collation。
const MAC_UTF8_ENV = { LC_CTYPE: "en_US.UTF-8" };

function buildClipboardReadCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") return { cmd: "/usr/bin/pbpaste", args: [], env: MAC_UTF8_ENV };
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      // 用 [Console]::Out.Write 直接写出，避免 PowerShell 默认输出给字符串补一个尾随 \r\n
      // ——那个尾随换行会让"同一行粘贴"莫名多出一行。[string] 转换保证空剪贴板写出空串不报错。
      args: ["-NoProfile", "-NonInteractive", "-Command", `${windowsUtf8ConsolePreamble()} [Console]::Out.Write([string](Get-Clipboard -Raw))`]
    };
  }
  if (env.WAYLAND_DISPLAY) return { cmd: "wl-paste", args: ["--no-newline"] };
  if (env.DISPLAY) return { cmd: "xclip", args: ["-selection", "clipboard", "-out"] };
  return null;
}

function buildClipboardWriteCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") return { cmd: "/usr/bin/pbcopy", args: [], env: MAC_UTF8_ENV };
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `${windowsUtf8ConsolePreamble()} $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text`]
    };
  }
  if (env.WAYLAND_DISPLAY) return { cmd: "wl-copy", args: [] };
  if (env.DISPLAY) return { cmd: "xclip", args: ["-selection", "clipboard", "-in"] };
  return null;
}

function windowsUtf8ConsolePreamble() {
  return "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false;";
}

function buildClipboardImageWriteCommand(filePath, mimeOrPath = "", platform = process.platform) {
  if (platform !== "darwin") return null;
  const type = clipboardImageType(mimeOrPath || filePath);
  if (!type) return null;
  return {
    cmd: "/usr/bin/osascript",
    args: [
      "-e",
      "on run argv",
      "-e",
      "set imagePath to POSIX file (item 1 of argv)",
      "-e",
      `set the clipboard to (read imagePath as «class ${type}»)`,
      "-e",
      "end run",
      String(filePath || "")
    ]
  };
}

function normalizeClipboardText(text) {
  return String(text || "").replace(/\0+$/g, "");
}

// 命令自带的 env 覆盖（如 mac 的 LC_CTYPE）叠加到真实进程环境上。
// 注意基底固定用 process.env：options.env 只用于平台探测（WAYLAND_DISPLAY/DISPLAY），
// 拿它当子进程环境会丢掉 PATH，xclip/wl-paste 就找不到了。
function spawnEnv(command) {
  if (!command || !command.env) return process.env;
  return Object.assign({}, process.env, command.env);
}

function readSystemClipboardText(options = {}) {
  const command = buildClipboardReadCommand(options.platform, options.env);
  if (!command) return { ok: false, text: "", error: "当前平台没有可用的系统剪贴板读取命令" };
  const result = spawnSync(command.cmd, command.args, {
    encoding: "utf8",
    env: spawnEnv(command),
    timeout: options.timeoutMs || 3000,
    windowsHide: true
  });
  if (result.error) return { ok: false, text: "", error: result.error.message || String(result.error) };
  if (result.status !== 0) {
    return { ok: false, text: "", error: String(result.stderr || `exit ${result.status}`).trim() };
  }
  return { ok: true, text: normalizeClipboardText(result.stdout || "") };
}

function writeSystemClipboardText(text, options = {}) {
  const command = buildClipboardWriteCommand(options.platform, options.env);
  if (!command) return { ok: false, error: "当前平台没有可用的系统剪贴板写入命令" };
  const result = spawnSync(command.cmd, command.args, {
    input: Buffer.from(String(text || ""), "utf8"), // 显式 UTF-8 字节，配合 LC_CTYPE 让 pbcopy 正确解读
    encoding: "utf8",
    env: spawnEnv(command),
    timeout: options.timeoutMs || 3000,
    windowsHide: true
  });
  if (result.error) return { ok: false, error: result.error.message || String(result.error) };
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || `exit ${result.status}`).trim() };
  }
  return { ok: true };
}

function writeSystemClipboardImage(filePath, mimeOrPath = "", options = {}) {
  const command = buildClipboardImageWriteCommand(filePath, mimeOrPath, options.platform);
  if (!command) return { ok: false, error: "当前平台或图片格式没有可用的系统剪贴板图片写入命令" };
  const result = spawnSync(command.cmd, command.args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 5000,
    windowsHide: true
  });
  if (result.error) return { ok: false, error: result.error.message || String(result.error) };
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || `exit ${result.status}`).trim() };
  }
  return { ok: true };
}

module.exports = {
  buildClipboardReadCommand,
  buildClipboardWriteCommand,
  buildClipboardImageWriteCommand,
  clipboardImageType,
  normalizeClipboardText,
  readSystemClipboardText,
  writeSystemClipboardText,
  writeSystemClipboardImage
};
