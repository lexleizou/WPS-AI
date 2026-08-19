(function attachModelsCatalog(global) {
  "use strict";

  // 远程能力目录（models.dev）——让「新模型能力」不再靠名字正则硬猜。
  //
  // models.dev 维护了各家模型的结构化元数据。启动时经本地代理 /models-catalog 拉取
  // （代理侧按天缓存到磁盘），把其中的能力映射成 WpsAiCapabilities 的全局 override。
  // 优先级：用户/供应商专属 override > 本目录（全局）> 名字正则兜底。目录没覆盖到的
  // 模型仍回退正则，所以这是「叠加更可靠数据源」，不改原有行为。
  //
  // models.dev 每个模型的字段：
  //   modalities.input: ["text","image","video","audio","pdf"]  → image / pdf
  //   tool_call: boolean                                          → tools
  //   reasoning: boolean                                          → thinking
  // 顶层按 provider 分组，provider.models 按模型 id 索引。

  function proxyBase() {
    return (global.WpsAiRuntime && global.WpsAiRuntime.proxyBase && global.WpsAiRuntime.proxyBase())
      || "http://127.0.0.1:3890";
  }

  // 单个 models.dev 模型对象 → 能力覆盖对象（只放我们用得到的四个键）。
  // image/tools/thinking 做正负断言（可纠正正则的误判）；pdf 只正断言——
  // 插件对 pdf 有更严的协议级白名单，不让目录把它判负。
  function capsFromModel(m) {
    const caps = {};
    const input = (m && m.modalities && Array.isArray(m.modalities.input))
      ? m.modalities.input.map((x) => String(x).toLowerCase())
      : null;
    if (input) {
      caps.image = input.includes("image");
      if (input.includes("pdf")) caps.pdf = true;
    }
    if (m && typeof m.tool_call === "boolean") caps.tools = m.tool_call;
    if (m && typeof m.reasoning === "boolean") caps.thinking = m.reasoning;
    return caps;
  }

  // 整个 catalog → setCapabilityOverrides 需要的 records（{modelId, capabilities}）。
  // 同时按「完整 id」和「去掉 provider 前缀的裸 id」各索引一条——因为有的渠道模型 id
  // 带前缀（openrouter 的 "moonshotai/kimi-k3"），有的是裸的（"kimi-k3"）。
  function buildOverrideRecords(catalog) {
    const records = [];
    if (!catalog || typeof catalog !== "object") return records;
    for (const providerId of Object.keys(catalog)) {
      const prov = catalog[providerId];
      const models = prov && prov.models;
      if (!models || typeof models !== "object") continue;
      for (const key of Object.keys(models)) {
        const m = models[key] || {};
        const id = m.id || key;
        const caps = capsFromModel(m);
        if (!Object.keys(caps).length) continue;
        records.push({ modelId: id, capabilities: caps });
        const bare = String(id).split("/").pop();
        if (bare && bare !== id) records.push({ modelId: bare, capabilities: caps });
      }
    }
    return records;
  }

  let _loaded = false;
  let _loadingPromise = null;

  // 拉取 + 注入。best-effort：任何失败都静默回退名字正则，不影响聊天。
  async function ensureLoaded(force) {
    if (_loaded && !force) return true;
    if (_loadingPromise && !force) return _loadingPromise;
    _loadingPromise = (async () => {
      try {
        const resp = await fetch(proxyBase() + "/models-catalog", { cache: "no-store" });
        if (!resp || !resp.ok) return false;
        const catalog = await resp.json();
        const records = buildOverrideRecords(catalog);
        if (records.length && global.WpsAiCapabilities && global.WpsAiCapabilities.setCapabilityOverrides) {
          global.WpsAiCapabilities.setCapabilityOverrides("", records);
          _loaded = true;
          return true;
        }
        return false;
      } catch (e) {
        return false;
      } finally {
        _loadingPromise = null;
      }
    })();
    return _loadingPromise;
  }

  global.WpsAiModelsCatalog = { ensureLoaded, buildOverrideRecords, capsFromModel };
})(window);
