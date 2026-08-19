"use strict";

const http = require("http");
const https = require("https");

const SEARCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function normalizeSiteFilter(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const asUrl = /^https?:\/\//i.test(raw) ? new URL(raw) : null;
    if (asUrl) {
      return asUrl.hostname.toLowerCase().replace(/^www\./, "");
    }
  } catch (e) {}
  const cleaned = raw
    .replace(/^site:/i, "")
    .replace(/^https?:\/\//i, "")
    .split(/[/?#\s]/)[0]
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.+$/, "");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(cleaned)) return "";
  return cleaned;
}

function inferSiteFilter(query) {
  const raw = String(query || "");
  const explicit = raw.match(/\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/i);
  if (explicit) return normalizeSiteFilter(explicit[1]);
  const urlMatch = raw.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch) return normalizeSiteFilter(urlMatch[0]);
  const domain = raw.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  return domain ? normalizeSiteFilter(domain[1]) : "";
}

function hostMatchesSite(host, site) {
  const h = String(host || "").toLowerCase().replace(/\.+$/, "");
  const s = normalizeSiteFilter(site);
  if (!h || !s) return false;
  return h === s || h.endsWith("." + s);
}

function urlMatchesSite(value, site) {
  try {
    return hostMatchesSite(new URL(String(value || "")).hostname, site);
  } catch (e) {
    return false;
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeImageResult(item) {
  const url = String(item?.murl || item?.image || item?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    thumbnail: String(item?.turl || item?.thumbnail || "").trim(),
    title: String(item?.t || item?.title || "").trim(),
    source: String(item?.purl || item?.source || "").trim(),
    width: Number(item?.mw || item?.width) || undefined,
    height: Number(item?.mh || item?.height) || undefined
  };
}

function filterResultsBySite(results, site) {
  const cleanSite = normalizeSiteFilter(site);
  if (!cleanSite) return Array.isArray(results) ? results : [];
  return (Array.isArray(results) ? results : []).filter((item) => urlMatchesSite(item?.url, cleanSite));
}

function parseBingImageResults(html, limit = 8) {
  const out = [];
  const raw = String(html || "");
  const re = /<a\b[^>]*\bclass=(["'])[^"']*\biusc\b[^"']*\1[^>]*\bm=(["'])([\s\S]*?)\2[^>]*>/gi;
  let m;
  while ((m = re.exec(raw)) && out.length < limit) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(m[3]));
      const item = normalizeImageResult(parsed);
      if (item) out.push(item);
    } catch (e) {}
  }
  return out;
}

function parseAttrs(tag) {
  const attrs = {};
  String(tag || "").replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, key, dq, sq, bare) => {
    attrs[key.toLowerCase()] = decodeHtmlEntities(dq ?? sq ?? bare ?? "");
    return "";
  });
  return attrs;
}

function firstSrcsetUrl(value) {
  const first = String(value || "").split(",")[0] || "";
  return first.trim().split(/\s+/)[0] || "";
}

function absolutizeImageUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return "";
  try {
    return new URL(raw, baseUrl).toString();
  } catch (e) {
    return "";
  }
}

function parseSiteImageResults(html, baseUrl, site, limit = 8) {
  const raw = String(html || "");
  const cleanSite = normalizeSiteFilter(site) || normalizeSiteFilter(baseUrl);
  const out = [];
  const seen = new Set();
  const add = (url, title = "") => {
    const absolute = absolutizeImageUrl(url, baseUrl);
    if (!absolute || seen.has(absolute) || !urlMatchesSite(absolute, cleanSite)) return;
    seen.add(absolute);
    out.push({ url: absolute, thumbnail: absolute, title: String(title || "").trim(), source: baseUrl });
  };

  raw.replace(/<meta\b[^>]*>/gi, (tag) => {
    const attrs = parseAttrs(tag);
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if (/^(og:image|twitter:image|twitter:image:src)$/.test(key)) add(attrs.content, key);
    return "";
  });
  raw.replace(/<(?:img|source)\b[^>]*>/gi, (tag) => {
    const attrs = parseAttrs(tag);
    add(attrs.src || attrs["data-src"] || firstSrcsetUrl(attrs.srcset || attrs["data-srcset"]), attrs.alt || attrs.title || "");
    return "";
  });
  return out.slice(0, limit);
}

function shouldUseImageSearchFallback(error) {
  const msg = String(error?.message || error || "");
  if (/\bHTTP\s+(401|403|406|429|451|503)\b/i.test(msg)) return true;
  if (/timeout|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|TLS|SSL|forbidden|access denied/i.test(msg)) return true;
  if (/vqd|图源接口可能已变更|搜索令牌/i.test(msg)) return true;
  return false;
}

function getText(target, headers = {}, redirectsLeft = 1, guardHost) {
  return new Promise((resolve, reject) => {
    const lib = target.startsWith("https:") ? https : http;
    const r = lib.get(target, {
      timeout: 15000,
      headers: Object.assign({ "User-Agent": SEARCH_UA }, headers || {})
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirectsLeft > 0) {
        resp.resume();
        let next;
        try { next = new URL(resp.headers.location, target).toString(); } catch (e) { reject(new Error("重定向地址非法")); return; }
        try {
          if (guardHost && guardHost(new URL(next).hostname)) {
            reject(new Error("重定向到禁止地址"));
            return;
          }
        } catch (e) {
          reject(new Error("重定向地址非法"));
          return;
        }
        getText(next, headers, redirectsLeft - 1, guardHost).then(resolve, reject);
        return;
      }
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        reject(new Error(`HTTP ${resp.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      resp.on("data", (c) => {
        total += c.length;
        if (total > 4 * 1024 * 1024) {
          try { r.destroy(); } catch (e) {}
          reject(new Error("响应过大"));
          return;
        }
        chunks.push(c);
      });
      resp.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      resp.on("error", reject);
    });
    r.on("error", reject);
    r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("timeout")); });
  });
}

function pageUrlCandidates(query, site) {
  const raw = String(query || "");
  const urlMatch = raw.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch) {
    try { return [new URL(urlMatch[0]).toString()]; } catch (e) {}
  }
  const cleanSite = normalizeSiteFilter(site) || inferSiteFilter(query);
  if (!cleanSite) return [];
  const labels = cleanSite.split(".");
  if (labels.length === 2) return [`https://www.${cleanSite}/`, `https://${cleanSite}/`];
  return [`https://${cleanSite}/`];
}

function providerQuery(query, site) {
  const cleanSite = normalizeSiteFilter(site);
  let q = String(query || "").trim()
    .replace(/https?:\/\/[^\s"'<>]+/ig, "")
    .replace(/\bsite:[a-z0-9.-]+\.[a-z]{2,}\b/ig, "")
    .trim();
  if (cleanSite) {
    q = q.replace(new RegExp(`\\b${cleanSite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), "").trim();
    return `${q || cleanSite} site:${cleanSite}`;
  }
  return q;
}

async function searchSitePageImages(query, limit, options = {}) {
  const site = normalizeSiteFilter(options.site) || inferSiteFilter(query);
  const candidates = pageUrlCandidates(query, site);
  if (!site || !candidates.length) return [];
  let lastError = null;
  for (const pageUrl of candidates) {
    try {
      if (options.guardHost && options.guardHost(new URL(pageUrl).hostname)) {
        throw new Error("禁止访问该地址（内网/环回/元数据）");
      }
      const html = await getText(pageUrl, { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }, 1, options.guardHost);
      const results = parseSiteImageResults(html, pageUrl, site, limit);
      if (results.length) return results;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function searchDuckDuckGoImages(query, limit, options = {}) {
  const enc = encodeURIComponent(query);
  const home = await getText("https://duckduckgo.com/?q=" + enc + "&iax=images&ia=images", {}, 1, options.guardHost);
  const m = home.match(/vqd=["']?([\d-]+)["']?/);
  if (!m) throw new Error("未取得搜索令牌(vqd)，图源接口可能已变更");
  const api = "https://duckduckgo.com/i.js?l=us-en&o=json&q=" + enc + "&vqd=" + encodeURIComponent(m[1]) + "&f=,,,&p=1";
  const jsonText = await getText(api, { Referer: "https://duckduckgo.com/", "X-Requested-With": "XMLHttpRequest" }, 1, options.guardHost);
  let data = {};
  try { data = JSON.parse(jsonText); } catch (e) {}
  return (Array.isArray(data.results) ? data.results : [])
    .map((it) => normalizeImageResult(it))
    .filter(Boolean)
    .slice(0, limit);
}

async function searchBingImages(query, limit, options = {}) {
  const enc = encodeURIComponent(query);
  const html = await getText("https://www.bing.com/images/search?q=" + enc + "&form=HDRSC2&first=1", {
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  }, 1, options.guardHost);
  return parseBingImageResults(html, limit);
}

async function searchImages(query, limit, options = {}) {
  const site = normalizeSiteFilter(options.site) || inferSiteFilter(query);
  if (site) {
    try {
      const siteResults = await searchSitePageImages(query, limit, { site, guardHost: options.guardHost });
      if (siteResults.length) return { results: siteResults, source: "site-page", site };
    } catch (e) {
      if (process.env.DEBUG) console.warn(`[image-search] 站点图片解析失败: ${e.message || e}`);
    }
  }

  const q = providerQuery(query, site);
  let source = "duckduckgo";
  let results = [];
  try {
    results = await searchDuckDuckGoImages(q, limit, options);
  } catch (searchErr) {
    if (!shouldUseImageSearchFallback(searchErr)) throw searchErr;
    source = "bing";
    results = await searchBingImages(q, limit, options);
  }
  if (site) results = filterResultsBySite(results, site);
  return { results: results.slice(0, limit), source, site };
}

module.exports = {
  filterResultsBySite,
  inferSiteFilter,
  pageUrlCandidates,
  parseSiteImageResults,
  parseBingImageResults,
  searchImages,
  searchBingImages,
  searchDuckDuckGoImages,
  shouldUseImageSearchFallback
};
