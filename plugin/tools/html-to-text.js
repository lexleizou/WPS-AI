"use strict";

// 把 HTML 抽成纯文本 + 标题，供 /fetch-web 抓网页素材用。纯函数，可 require 单测。

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return " "; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return " "; } })
    .replace(/&amp;/g, "&"); // 最后解 &，避免二次解码
}

// 线性剥离 script/style/noscript/template/svg 块（含内容）。
// 用 regex.lastIndex 单遍前进，避免懒惰正则 /<tag>[\s\S]*?<\/tag>/ 在大量未闭合标签下的 O(n²) 回溯（DoS）。
// 未闭合处理：
//   - 自闭合 <svg .../> → 只去开标签；
//   - svg/template 未闭合 → 只去开标签、保留后文（这些是视觉/惰性元素，误吞后文会丢正文，见 bug M2）；
//   - script/style/noscript 未闭合 → 去到结尾（避免脚本/样式正文当可见文本泄漏）。
const KEEP_TAIL_ON_UNCLOSED = new Set(["svg", "template"]);
function stripTagBlocks(html) {
  const open = /<(script|style|noscript|template|svg)\b[^>]*>/gi;
  let out = "";
  let last = 0;
  let m;
  while ((m = open.exec(html))) {
    out += html.slice(last, m.index) + " ";
    const tagName = m[1].toLowerCase();
    const openEnd = m.index + m[0].length;
    if (/\/>\s*$/.test(m[0])) { last = openEnd; open.lastIndex = openEnd; continue; } // 自闭合
    const closeRe = new RegExp("</" + tagName + "\\s*>", "gi");
    closeRe.lastIndex = openEnd;
    const cm = closeRe.exec(html);
    if (!cm) {
      if (KEEP_TAIL_ON_UNCLOSED.has(tagName)) { last = openEnd; open.lastIndex = openEnd; continue; }
      last = html.length; break; // script/style/noscript 未闭合 → 丢到结尾
    }
    last = cm.index + cm[0].length;
    open.lastIndex = last;
  }
  out += html.slice(last);
  return out;
}

function htmlToText(html, maxLen) {
  const max = Number(maxLen) > 0 ? Number(maxLen) : 8000;
  let s = String(html || "");
  // 输入上限：正文最终只截到 max 字符，256KB HTML 足够；同时封住注释/标签正则的 O(n²) 最坏情况。
  if (s.length > 262144) s = s.slice(0, 262144);
  // 先去注释 + 脚本/样式/内联资源块（含内容），再取 title，避免注释/脚本里的 <title> 被误取
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = stripTagBlocks(s);
  const titleM = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, " ").trim() : "";
  // 块级结束标签 / 换行标签 → 换行
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|ul|ol|table)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // 去掉剩余所有标签
  s = s.replace(/<[^>]+>/g, " ");
  // 解实体（在去标签之后，避免文本里的 &lt; 被当标签）
  s = decodeEntities(s);
  // 压空白
  s = s.replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let truncated = false;
  if (s.length > max) { s = s.slice(0, max).trim(); truncated = true; }
  return { title, text: s, truncated };
}

// 取标签里某属性值（大小写不敏感，容忍单/双引号/裸值）。best-effort。
function getAttr(tag, name) {
  const re = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const m = String(tag).match(re);
  if (!m) return "";
  return decodeEntities(m[2] || m[3] || m[4] || "").trim();
}

function stripTagsInline(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// 抽页面内 <a href> 链接（去重、解析为绝对地址、跳过锚点/js/mailto）。供 web_fetch includeLinks。
function extractLinks(html, baseUrl, limit) {
  let s = String(html || "");
  if (s.length > 262144) s = s.slice(0, 262144);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  const cap = limit && limit > 0 ? Math.floor(limit) : 100;
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(s)) && out.length < cap) {
    const href = (m[2] || m[3] || m[4] || "").trim();
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    let abs = href;
    if (baseUrl) { try { abs = new URL(href, baseUrl).toString(); } catch (e) { continue; } }
    if (!/^https?:/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, text: stripTagsInline(m[5]).slice(0, 200) });
  }
  return out;
}

// 抽页面元信息（title/description/author/published/siteName）。供 web_fetch includeMeta。
function extractMeta(html) {
  let s = String(html || "");
  if (s.length > 262144) s = s.slice(0, 262144);
  const meta = {};
  const titleM = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) { const t = decodeEntities(titleM[1]).replace(/\s+/g, " ").trim(); if (t) meta.title = t; }
  const tags = s.match(/<meta\b[^>]*>/gi) || [];
  const pick = {};
  for (const tag of tags) {
    const key = (getAttr(tag, "name") || getAttr(tag, "property")).toLowerCase();
    if (!key) continue;
    const content = getAttr(tag, "content");
    if (content && !(key in pick)) pick[key] = content;
  }
  const first = (...keys) => { for (const k of keys) if (pick[k]) return pick[k]; return ""; };
  const desc = first("description", "og:description", "twitter:description");
  if (desc) meta.description = desc;
  const author = first("author", "article:author");
  if (author) meta.author = author;
  const published = first("article:published_time", "date", "pubdate", "og:updated_time");
  if (published) meta.published = published;
  const siteName = first("og:site_name");
  if (siteName) meta.siteName = siteName;
  return meta;
}

module.exports = { htmlToText, decodeEntities, extractLinks, extractMeta };
