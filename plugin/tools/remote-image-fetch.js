"use strict";

const BROWSER_IMAGE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function normalizeReferer(value, imageUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const ref = new URL(raw);
    if (ref.protocol !== "http:" && ref.protocol !== "https:") return "";
    const img = new URL(imageUrl);
    if (img.protocol === "https:" && ref.protocol !== "https:") return "";
    return ref.toString();
  } catch (e) {
    return "";
  }
}

function defaultRefererForImage(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.protocol}//${u.host}/`;
  } catch (e) {
    return "";
  }
}

function buildRemoteImageHeaders(imageUrl, options = {}) {
  const referer = normalizeReferer(options.referer || options.pageUrl || "", imageUrl) || defaultRefererForImage(imageUrl);
  const headers = {
    "User-Agent": BROWSER_IMAGE_USER_AGENT,
    "Accept": "image/webp,image/apng,image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site"
  };
  if (referer) headers.Referer = referer;
  return headers;
}

function shouldUseChromiumFallback(error) {
  const msg = String(error?.message || error || "");
  if (/禁止访问该地址|内网|环回|元数据|URL 非法|重定向地址非法|重定向到禁止地址/.test(msg)) return false;
  if (/\bHTTP\s+(401|403|406|429|451|503)\b/i.test(msg)) return true;
  if (/timeout|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|TLS|SSL|forbidden|access denied/i.test(msg)) return true;
  return false;
}

module.exports = {
  BROWSER_IMAGE_USER_AGENT,
  buildRemoteImageHeaders,
  defaultRefererForImage,
  normalizeReferer,
  shouldUseChromiumFallback
};
