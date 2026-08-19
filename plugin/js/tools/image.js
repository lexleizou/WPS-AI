(function attachImageTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  async function cacheGeneratedImageResults(results) {
    const out = [];
    for (const item of (Array.isArray(results) ? results : [])) {
      const url = String(item?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        out.push(item);
        continue;
      }
      try {
        const local = await global.WpsAiImageAssets?.ensureLocalImagePath?.(url);
        if (local && local !== url) {
          out.push(Object.assign({}, item, { url: local, sourceUrl: item.sourceUrl || url }));
          continue;
        }
      } catch (e) {
        console.warn("[image] ToAPI 图片本地缓存失败:", e?.message || e);
      }
      out.push(item);
    }
    return out;
  }

  registry.registerTool({
    name: "generate_image",
    hosts: ["*"],
    description: "调用当前启用的图像渠道生成图片（toapis 异步任务 / OpenAI 官方 / OpenRouter / sub2api 同步 / Boogu 本地），返回图片 URL。需要先在「设置 → 图像生成」中启用并配置渠道。生成后通常配合 wps_insert_image 把图片插入到 Word 文档。调用前请基于提示词与插入位置的语境自行决定合适的 size（宽高比），用户未显式指定尺寸时不要省略 size；各渠道会自动把比例折算成自己支持的尺寸参数。",
    parameters: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "图像描述，越具体效果越好（≤4000 字符）" },
        size: {
          type: "string",
          description: "宽高比例（不是像素）。**默认必须根据提示词和插入语境自行判断**：封面/横幅/海报/PPT 主图/章节配图用 16:9 或 21:9；正文小插画/竖向人物/手机海报用 9:16 或 2:3；表情包/头像/方形海报/Logo 用 1:1；A4 文档插图横向 3:2、纵向 2:3；4K 只支持 16:9/9:16/2:1/1:2/21:9/9:21。只有用户提示词里明确给了像素或比例时才直接遵从用户值；其它情况都自行结合上下文决策，不要省略。",
          enum: ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"]
        },
        resolution: {
          type: "string",
          description: "分辨率档位：1K 最便宜最快，4K 最贵最慢。省略走默认。",
          enum: ["1K", "2K", "4K"]
        },
        n: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "生成几张" },
        model: { type: "string", description: "覆盖默认模型（如不传使用设置中的默认 gpt-image-2）" }
      }
    },
    handler: async ({ prompt, size, resolution, n, model } = {}) => {
      // 生图进度走专用面板（WpsAiImageUI），原文提示词不再被塞进 chat-progress 单行省略号里——
      // 那里只能塞下 20~30 字，多行提示词完全看不清。专用面板里 3 行 line-clamp，正常可读。
      const imageUI = global.WpsAiImageUI;
      // 尺寸优先级：本次调用显式 size（来自生图弹窗/AI 判断）> 设置里的默认比例 > provider 默认。
      const sizeOverride = (global.WpsAiProviderRegistry?.loadSettings?.() || {}).imageSizeOverride;
      let effectiveSize = size;
      if ((!effectiveSize || !String(effectiveSize).trim()) && typeof sizeOverride === "string" && sizeOverride.trim()) {
        effectiveSize = sizeOverride.trim();
      }
      try { imageUI?.start?.({ prompt }); } catch (e) {}
      let succeeded = false;
      try {
        const results = await global.WpsAiImage.generateImage({
          prompt, size: effectiveSize, resolution, n: n || 1, model,
          onProgress: (info) => {
            try { imageUI?.update?.(info || {}); } catch (e) {}
          }
        });
        const cachedResults = await cacheGeneratedImageResults(results);
        succeeded = true;
        try {
          const imageConfig = global.WpsAiProviderRegistry?.getImageConfig?.() || {};
          const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
          // 先确保本对话已有 AI 总结的项目名（一对话一次），首张图也能带上项目标签
          try { await global.WpsAiProject?.ensure?.(); } catch (e) {}
          const added = global.WpsAiMaterialLibrary?.addMany?.(cachedResults, {
            prompt,
            size: effectiveSize || imageConfig.defaultSize || "",
            resolution: resolution || imageConfig.defaultResolution || "",
            model: model || imageConfig.model || "",
            providerType: imageConfig.type || "",
            project: settings.currentProject || "",
            source: "generated"
          }) || [];
          // 自动打内容标签（best-effort，不阻塞返回）：用 prompt 走文本模型。
          added.forEach((entry) => {
            global.WpsAiMaterialTagger?.tagImage?.({ prompt })
              .then((tags) => { if (tags && tags.length) global.WpsAiMaterialLibrary?.update?.(entry.id, { tags }); })
              .catch(() => {});
          });
        } catch (e) {
          console.warn("[image] 写入素材库失败:", e?.message || e);
        }
        return {
          count: cachedResults.length,
          images: cachedResults.map((r) => ({ url: r.url, revisedPrompt: r.revisedPrompt }))
        };
      } catch (err) {
        try { imageUI?.fail?.(err?.message || String(err)); } catch (e) {}
        throw err;
      } finally {
        if (succeeded) {
          try { imageUI?.done?.(); } catch (e) {}
        }
      }
    }
  });
})(window);
