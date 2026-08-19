// 技能（Skills）模块：
// - 内置技能（hardcoded）：针对 WPS 各宿主调好的指令模板（PPT 设计师 / Word 润色 / Excel 数据助手 / PDF 阅读）
// - 用户导入技能：从 .md / .txt 文件读，存 localStorage
// - 启用的技能在 chat 时拼到 system prompt 后面
//
// 数据形状：
//   skill = { id, name, description, content, builtin?: boolean }
//   localStorage:
//     - lingxi_skills_user_v1: { entries: [skill, ...], savedAt }
//     - lingxi_skills_enabled_v1: { ids: [skillId, ...] }
(function attachSkills(global) {
  "use strict";

  const USER_KEY = "lingxi_skills_user_v1";
  const ENABLED_KEY = "lingxi_skills_enabled_v1";
  const CLOUD_KEY = "lingxi_skills_cloud_v1"; // 缓存从 OSS 拉到的云端技能元数据（离线也能列出）
  // 云端技能目录索引（OSS）：{ skills: [{ id, name, description, url|content|contentPath, hostFilter? }] }
  const DEFAULT_CLOUD_SKILLS_URL = "https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/skills/index.json";

  // 经本地 proxy 的 /forward/ 转发拉 OSS（避开 WebView 跨域）。返回原始响应体。
  function proxyForward(url) {
    const pre = global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/";
    return pre + encodeURIComponent(url);
  }

  // ===== 内置技能（开箱即用，针对 WPS 各宿主场景）=====
  const BUILTIN = [
    {
      id: "builtin-ppt-designer",
      name: "PPT 视觉设计师",
      description: "做 PPT 时遵循专业视觉设计原则：强对比、留白、层级、配色。AI 生成或修改 PPT 时启用。",
      builtin: true,
      content: [
        "你做 PPT 时严格遵循以下视觉设计原则：",
        "1. **强对比**：标题用大字号 + 加粗，正文 18-22pt，标题至少 40pt；标题颜色用 primaryColor，正文用 bodyColor（自动跟着 stylePreset 来）。",
        "2. **充足留白**：四边 margin ≥ 80px（1920×1080 画布下），元素之间 gap 至少 40px。绝对避免内容贴边或挤成一坨。",
        "3. **清晰层级**：一页最多 3 个视觉层级；用 size + weight + color 三种手段拉开；每页只有一个视觉重点。",
        "4. **配色克制**：每页用色板里的 2-3 个颜色，**绝对不超过 5 种**；accentColor 只用于关键数字/重点；surfaceColor 用于卡片底色。",
        "5. **字号映射**：1pt = 2px（1920×1080 画布）。封面巨标题 120-192px / H1 80-108px / H2 56-72px / 正文 36-44px / 卡片 32-40px / 脚注 22-28px。**绝对不要 < 20px**。",
        "6. **数据可视化优先**：有数字/趋势/占比/多维比较时用 ECharts，比纯文字描述强 10 倍。",
        "7. **避免反模式**：项目符号铺满整页、大段正文、4 色以上配色、3 种以上字体、装饰元素抢戏、贴边不留白。"
      ].join("\n")
    },
    {
      id: "builtin-word-polish",
      name: "Word 中文润色",
      description: "改 Word 文档时按中文写作规范润色：简练、主动语态、去口语化、专业措辞。",
      builtin: true,
      content: [
        "你处理 Word 文档时遵循中文写作规范：",
        "1. **简练**：删冗余词（「进行」「一些」「的话」「其实」「然后」「那么」等填充词）、合并短句。",
        "2. **主动语态优先**：把「被 X 所 Y」改成「X Y」；少用「被」。",
        "3. **去口语化**：「我觉得」→「显然」或直接陈述；「挺好的」→ 具体描述；不用「嗯」「啊」「呢」等语气词。",
        "4. **术语统一**：同一个概念在全文里用一致的术语，第一次出现给定义或英文原文。",
        "5. **段落结构**：每段一个核心论点，首句点题；段落之间用逻辑词承接（「因此」「然而」「相比之下」）。",
        "6. **数字规范**：正文 0-10 用汉字，11+ 用阿拉伯数字；百分比、年份、版本号一律阿拉伯数字。",
        "7. **标点严谨**：中文标点（，。：；？！「」）；不用中英文混标。",
        "8. **保留原意**：润色不是改写，保持作者原意和事实，只调表达方式。"
      ].join("\n")
    },
    {
      id: "builtin-excel-data",
      name: "Excel 数据助手",
      description: "处理 Excel 时按数据分析最佳实践：表头清晰、公式规范、命名区域、不破坏原数据。",
      builtin: true,
      content: [
        "你处理 Excel 表格时遵循以下规范：",
        "1. **保留原数据**：原始数据 sheet 不动；新增公式/汇总放新 sheet 或新区域。",
        "2. **公式规范**：用绝对引用锁定区域（$A$1:$A$100），命名区域代替 magic range（用「销售额」代替 D2:D100）。",
        "3. **避免硬编码**：阈值/系数放单独单元格做参数，公式引用它，方便用户调参。",
        "4. **错误处理**：用 IFERROR / IFNA 包住可能出错的公式，避免满屏 #N/A。",
        "5. **表头**：第一行始终是表头（加粗 + 浅底色）；下面不要插空行。",
        "6. **数据类型**：日期统一格式（YYYY-MM-DD），数字保留必要小数位，文本不要混数字。",
        "7. **汇总优先用 SUMIFS/COUNTIFS/AVERAGEIFS**：可读性 > VLOOKUP 嵌套；XLOOKUP 在新版 Excel 里替代 VLOOKUP。",
        "8. **透视表 / Power Query**：复杂聚合用透视表；数据清洗用 Power Query 步骤，记得告诉用户怎么 refresh。"
      ].join("\n")
    },
    {
      id: "builtin-pdf-reader",
      name: "PDF 阅读助手",
      description: "处理 PDF 文档时按知识工作者节奏：先抓结构、再概要、再深挖；引用具体页码。",
      builtin: true,
      content: [
        "你处理 PDF 文档时按这套节奏：",
        "1. **先看目录/章节结构**：用户问之前，先扫一遍 outline 或前几页，建立全文骨架。",
        "2. **概要回答**：用户问问题先用 1-2 句回答核心，再展开细节，避免直接铺长答案。",
        "3. **引用页码**：所有论断都标注来源页（如「第 5 页提到...」「图 3 显示...」），便于用户回查。",
        "4. **量化优先**：PDF 里出现数字、表格、图表时优先引用具体数字，比抽象描述更有信息量。",
        "5. **术语保留**：专业术语用原文（中文 PDF 保留中文，英文 PDF 保留英文），不强行翻译让用户产生歧义。",
        "6. **结构化输出**：列表 / 表格 / 时间线等结构化内容用 markdown 还原，不要全段落叙述。",
        "7. **不知道就说不知道**：PDF 没覆盖的问题直接讲「原文未提及」，不要瞎编。"
      ].join("\n")
    },
    {
      // UI/UX Pro Max 设计智能 —— 引入 nextlevelbuilder/ui-ux-pro-max-skill 的设计知识库。
      // content 大（44KB SKILL.md），用 contentPath 懒加载，第一次用到才 fetch + 缓存。
      // 这条 skill 用于「用 HTML 生成 PPT」自由设计场景：当用户在 prompt 里明确风格时
      // (cyberpunk / 极简 / 玻璃拟态 / 暗黑等), 用户的样式预设让位给这套设计自由度。
      id: "builtin-ui-ux-pro-max",
      name: "UI/UX Pro Max 设计智能",
      description: "50+ 风格 / 161 色板 / 57 字体配对 / 99 UX 准则 / 25 图表类型。AI 用 HTML 生成 PPT 时按需引用，让幻灯片不再千篇一律。来自 nextlevelbuilder/ui-ux-pro-max-skill（MIT）。",
      builtin: true,
      contentPath: "skills/ui-ux-pro-max/SKILL.md",
      // 只在 PPT 宿主注入；其他宿主聊天不浪费 ~10K 个 token
      hostFilter: ["wpp"]
    }
  ];

  // 懒加载缓存：内容来源(url/contentPath) → 已 fetch 的 content
  const _contentCache = new Map();
  async function loadContent(skill) {
    if (skill.content) return skill.content;
    const src = skill.url || skill.contentPath;
    if (!src) return "";
    if (_contentCache.has(src)) return _contentCache.get(src);
    try {
      // 绝对 http(s)（云端技能）走 proxy 转发避跨域；相对路径（内置随包）直接取
      const fetchUrl = /^https?:\/\//i.test(src) ? proxyForward(src) : src;
      const resp = await fetch(fetchUrl, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      _contentCache.set(src, text);
      return text;
    } catch (e) {
      console.warn(`[skills] 加载 ${src} 失败:`, e?.message || e);
      return "";
    }
  }

  // ===== 云端技能（从 OSS 目录加载）=====
  // 把一条云端技能原始条目规整成内部 skill 形态；无有效内容来源则返回 null。
  function normalizeCloudSkill(raw) {
    if (!raw) return null;
    const rid = String(raw.id || raw.name || "").trim();
    if (!rid) return null;
    const id = rid.indexOf("cloud-") === 0 ? rid : "cloud-" + rid;
    const out = {
      id,
      name: String(raw.name || rid).trim(),
      description: String(raw.description || "").trim(),
      builtin: false,
      source: "cloud"
    };
    if (typeof raw.content === "string" && raw.content.trim()) out.content = raw.content.trim();
    else if (raw.url) out.url = String(raw.url).trim();
    else if (raw.contentPath) out.contentPath = String(raw.contentPath).trim();
    else return null;
    if (Array.isArray(raw.hostFilter) && raw.hostFilter.length) out.hostFilter = raw.hostFilter.map(String);
    return out;
  }

  // 解析云端索引：接受 { skills: [...] } 或直接数组。纯函数。
  function parseCloudIndex(data) {
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.skills) ? data.skills : []);
    const seen = new Set();
    const out = [];
    arr.map(normalizeCloudSkill).forEach((s) => {
      if (!s || seen.has(s.id)) return;
      seen.add(s.id);
      out.push(s);
    });
    return out;
  }

  function readCloudSkills() {
    try {
      const raw = global.WpsAiStore.getItem(CLOUD_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (e) { return []; }
  }

  function writeCloudSkills(entries) {
    try { global.WpsAiStore.setItem(CLOUD_KEY, JSON.stringify({ entries, savedAt: Date.now() })); } catch (e) {}
  }

  // 从 OSS 拉云端技能目录，刷新本地缓存。失败回退到缓存（离线可用）。best-effort。
  async function loadCloud(opts) {
    const url = (opts && opts.url)
      || global.WpsAiProviderRegistry?.loadSettings?.().cloudSkillsUrl
      || DEFAULT_CLOUD_SKILLS_URL;
    try {
      const resp = await fetch(proxyForward(url), { cache: "no-cache" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const skills = parseCloudIndex(data);
      writeCloudSkills(skills);
      // 刷新时清掉云端（绝对 URL）的内容缓存，让下次注入拿最新正文，
      // 避免 OSS 同 URL 更新内容后本会话仍用旧缓存。内置的相对 contentPath 缓存不动。
      for (const k of Array.from(_contentCache.keys())) {
        if (/^https?:/i.test(k)) _contentCache.delete(k);
      }
      return skills;
    } catch (e) {
      console.warn("[skills] 云端技能加载失败，用缓存兜底:", e?.message || e);
      return readCloudSkills();
    }
  }

  function readUserSkills() {
    try {
      const raw = global.WpsAiStore.getItem(USER_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (e) {
      console.warn("[skills] 读取用户技能失败：", e?.message || e);
      return [];
    }
  }

  function writeUserSkills(entries) {
    try {
      global.WpsAiStore.setItem(USER_KEY, JSON.stringify({ entries, savedAt: Date.now() }));
    } catch (e) {
      console.error("[skills] 写入用户技能失败（localStorage 可能已满）:", e?.message || e);
    }
  }

  // 内置技能默认全部启用 —— 用户装完插件开箱即用，少一步「为什么 AI 不按 PPT 设计师那套来？」
  // 用户不需要的可以在设置 → 技能里逐条关掉。BUILTIN 数组变化时这里也要跟。
  const DEFAULT_ENABLED = BUILTIN.map((s) => s.id);

  function readEnabledIds() {
    try {
      const raw = global.WpsAiStore.getItem(ENABLED_KEY);
      if (!raw) return new Set(DEFAULT_ENABLED);
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed?.ids) ? parsed.ids : []);
    } catch (e) { return new Set(DEFAULT_ENABLED); }
  }

  function writeEnabledIds(set) {
    try {
      global.WpsAiStore.setItem(ENABLED_KEY, JSON.stringify({ ids: Array.from(set), savedAt: Date.now() }));
    } catch (e) {}
  }

  // 列出全部（内置 → 云端 → 用户自定义）
  function list() {
    return BUILTIN.concat(readCloudSkills()).concat(readUserSkills());
  }

  function get(id) {
    return list().find((s) => s.id === id) || null;
  }

  function isEnabled(id) {
    return readEnabledIds().has(id);
  }

  function setEnabled(id, on) {
    const set = readEnabledIds();
    if (on) set.add(id);
    else set.delete(id);
    writeEnabledIds(set);
  }

  function getEnabledSkills() {
    const set = readEnabledIds();
    return list().filter((s) => set.has(s.id));
  }

  function genId() {
    return "sk-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // 导入用户技能。skill 可以来源于 .md/.txt 解析或直接 JS object。
  // skill: { name (必填), description?, content (必填) }
  function addUser(skill) {
    if (!skill?.name) throw new Error("name 必填");
    if (typeof skill.content !== "string" || !skill.content.trim()) {
      throw new Error("content 必填且非空");
    }
    const entries = readUserSkills();
    const saved = {
      id: genId(),
      name: String(skill.name).trim(),
      description: String(skill.description || "").trim(),
      content: String(skill.content).trim(),
      builtin: false,
      ts: Date.now()
    };
    entries.push(saved);
    writeUserSkills(entries);
    return saved;
  }

  function removeUser(id) {
    const entries = readUserSkills();
    const filtered = entries.filter((e) => e.id !== id);
    writeUserSkills(filtered);
    // 同步清掉 enabled
    const set = readEnabledIds();
    if (set.delete(id)) writeEnabledIds(set);
  }

  // 更新一条用户技能（AI 用 save_skill 持续优化技能时走这里）。id 不在用户技能里 → 返回 null。
  function updateUser(id, patch) {
    const entries = readUserSkills();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const cur = entries[idx];
    if (patch && patch.name != null && String(patch.name).trim()) cur.name = String(patch.name).trim();
    if (patch && patch.description != null) cur.description = String(patch.description).trim();
    if (patch && patch.content != null && String(patch.content).trim()) cur.content = String(patch.content).trim();
    cur.ts = Date.now();
    writeUserSkills(entries);
    return cur;
  }

  // markdown 解析：支持开头 frontmatter（--- name: ... description: ... ---）+ 剩余内容
  // 不带 frontmatter 时整篇当 content，name 用 # 标题或文件名
  function parseMarkdownSkill(text, filename) {
    const s = String(text || "");
    const fmMatch = s.match(/^---\s*\n([\s\S]+?)\n---\s*\n([\s\S]*)$/);
    let name = "";
    let description = "";
    let content = s;
    if (fmMatch) {
      const front = fmMatch[1];
      content = fmMatch[2];
      front.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^([A-Za-z_-]+)\s*:\s*(.+)$/);
        if (!m) return;
        const k = m[1].toLowerCase();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (k === "name") name = v;
        else if (k === "description") description = v;
      });
    }
    if (!name) {
      // 找第一个 # 标题
      const h1 = content.match(/^#\s+(.+)$/m);
      if (h1) name = h1[1].trim();
    }
    if (!name && filename) {
      name = filename.replace(/\.(md|txt|markdown)$/i, "");
    }
    if (!name) name = "未命名技能";
    return { name, description, content: content.trim() };
  }

  // 拿"启用的技能"并把每条的真实 content 解析出来（contentPath 形式的会 fetch）。
  // 给 chat 路径用——它的 system prompt 是 async 构造的，所以这里 async 直接拿全文。
  // opts.host: 当前宿主名（wps/wpp/et/pdf）。skill.hostFilter 设了且不包含此 host → 跳过
  async function getEnabledSkillsWithContent(opts) {
    const host = opts?.host;
    const skills = getEnabledSkills().filter((s) => {
      if (!Array.isArray(s.hostFilter) || !s.hostFilter.length) return true;
      return !host || s.hostFilter.includes(host);
    });
    const out = [];
    for (const s of skills) {
      const content = await loadContent(s);
      if (!content) continue;
      out.push({ id: s.id, name: s.name, description: s.description, content });
    }
    return out;
  }

  global.WpsAiSkills = {
    list,
    get,
    isEnabled,
    setEnabled,
    getEnabledSkills,
    getEnabledSkillsWithContent,
    addUser,
    updateUser,
    removeUser,
    parseMarkdownSkill,
    loadContent,
    loadCloud,
    parseCloudIndex,
    readCloudSkills,
    _builtinIds: BUILTIN.map((b) => b.id)
  };
})(window);
