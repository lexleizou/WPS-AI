"use strict";

// SSRF 守卫。纯函数，可 require 单测。入参是 new URL(x).hostname（可能带方括号的 IPv6）。

function isMetadataSsrfHost(host) {
  if (!host) return true;
  if (host === "metadata.google.internal" || host === "metadata") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m && +m[1] === 169 && +m[2] === 254) return true; // AWS/GCP/Azure/阿里/腾讯 元数据
  if (host.startsWith("fe80") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true; // IPv6 link-local
  if (host === "[fe80::a9fe:a9fe]" || host === "fd00:ec2::254") return true;
  return false;
}

// 判 IPv4 前两段是否落在环回/私有/link-local/0.0.0.0。
function isBlockedIPv4(a, b) {
  if (a === 0 || a === 127) return true;             // 0.0.0.0/8, 环回
  if (a === 10) return true;                         // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 192 && b === 168) return true;           // 192.168/16
  if (a === 169 && b === 254) return true;           // link-local
  return false;
}

// 比 isMetadataSsrfHost 更严：额外拦环回 / 私有 / IPv6 ULA / IPv6 映射 IPv4 / 尾点 localhost。
// 用于 AI 可控的服务端抓取（/fetch-web、/image-search 的初始 URL 与每个重定向 hop）。
// 注意：仅按主机名/字面 IP 判断，DNS-rebinding（域名解析到内网）不在覆盖范围内。
function isBlockedFetchHost(host) {
  if (isMetadataSsrfHost(host)) return true;
  let h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""); // 去方括号 + 尾点 FQDN
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::" || h === "::1" || h === "0.0.0.0") return true;
  // IPv6 ULA fc00::/7（fc.. / fd..）
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
  // IPv6 link-local fe80::/10（isMetadataSsrfHost 的同名判断因带方括号失效，这里对去括号后的 h 补判）
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
  // IPv6 映射 IPv4（十进制）：::ffff:127.0.0.1
  let mm = h.match(/::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i);
  if (mm && isBlockedIPv4(+mm[1], +mm[2])) return true;
  // IPv6 映射 IPv4（十六进制两段）：::ffff:7f00:0001 / ::ffff:a9fe:a9fe（URL 会把点分形式规范成这个）
  mm = h.match(/::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/i);
  if (mm) {
    const w = parseInt(mm[1], 16);
    if (isBlockedIPv4((w >> 8) & 0xff, w & 0xff)) return true;
  }
  // 纯 IPv4
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return isBlockedIPv4(+m[1], +m[2]);
  return false;
}

module.exports = { isMetadataSsrfHost, isBlockedFetchHost, isBlockedIPv4 };
