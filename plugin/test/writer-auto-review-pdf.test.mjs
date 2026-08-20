import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIife } from "./helpers/load-iife.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autoReviewFile = path.resolve(here, "../js/auto-review.js");

test("visual review waits for the PDF file and uses the exporter returned path", async () => {
  const calls = [];
  let loadAttempts = 0;
  const actualPath = "/tmp/review/wps-normalized.pdf";
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith("/review/dir")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, dir: "/tmp/review" }) };
    }
    const body = JSON.parse(options.body || "{}");
    assert.equal(body.path, actualPath);
    loadAttempts += 1;
    if (loadAttempts === 1) {
      return { ok: false, status: 404, json: async () => ({ error: `文件不存在: ${actualPath}` }) };
    }
    if (loadAttempts === 2) {
      return { ok: true, status: 200, json: async () => ({ ok: true, size: 0, base64: "" }) };
    }
    const pdf = "%PDF-1.7\n%%EOF\n";
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, size: Buffer.byteLength(pdf), base64: Buffer.from(pdf).toString("base64") })
    };
  };
  const context = loadIife(autoReviewFile, {
    fetch,
    Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890" }
  });
  const writer = { exportToPdf: async () => ({ path: actualPath, applied: true }) };
  const bytes = await context.WpsAiAutoReview._internal.exportAndLoadPdf(writer);
  assert.equal(Buffer.from(bytes).toString(), "%PDF-1.7\n%%EOF\n");
  assert.equal(loadAttempts, 4);
  assert.equal(calls.length, 5);
});
