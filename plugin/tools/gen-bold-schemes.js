// 一次性脚本：把 frontend-slides 的 34 套 bold 模板生成三段 JS/HTML 片段
// 用法：node tools/gen-bold-schemes.js
// 输出：
//   - tools/.gen/registry-block.txt    （插入 registry.js 的 COLOR_SCHEMES 末尾）
//   - tools/.gen/app-mirror-block.txt  （插入 app.js 的本地 COLOR_SCHEMES 末尾）
//   - tools/.gen/html-options.txt      （插入 taskpane.html 的 <select id="styleScheme">）

const fs = require("fs");
const path = require("path");

// 34 套设计——颜色/字体/签名元素/版式提示来自 frontend-slides 仓库的 preview.md。
// description 由 mood + 用途短语手工归纳；group 决定在 <select> 里属于哪个 optgroup。
const SCHEMES = [
  { slug: "8-bit-orbit", label: "8-Bit Orbit", description: "复古科技 · CRT 像素霓虹", group: "tech",
    design: "深空蓝底 + 粉青黄霓虹三色 + CRT 扫描线 + 像素字体；80s 街机迷幻感。",
    signature: "霓虹 CRT 扫描线叠加星空，蚀刻栅格上堆叠硬阴影发光",
    hints: "封面用 wpp_apply_template:cover-band；章节用 v-cover-gradient；数据强爆 v-stat-bigtype。",
    darkMode: true, primary: "#5EDCF4", secondary: "#F0A6CA", accent: "#F4D03F",
    background: "#0A0E27", surface: "#0F1B3D", titleColor: "#FFFFFF", bodyColor: "#E2D5F2",
    titleFont: "Tektur", bodyFont: "Chakra Petch" },
  { slug: "biennale-yellow", label: "Biennale Yellow", description: "双年展海报 · 暖纸明黄", group: "editorial",
    design: "羊皮纸底 + 太阳明黄 + 深墨蓝衬线；像艺术双年展海报的氛围渐变。",
    signature: "羊皮纸底上的明黄径向光晕，1px 深墨细线分割",
    hints: "封面用 cover-split；章节用 v-section-modern；金句页用 quote-block。",
    darkMode: false, primary: "#F1EE2E", secondary: "#E26B4A", accent: "#F0DA7C",
    background: "#E9E5DB", surface: "#DCD6C4", titleColor: "#1B2566", bodyColor: "#1B2566",
    titleFont: "Instrument Serif", bodyFont: "Archivo" },
  { slug: "block-frame", label: "Block Frame", description: "新野兽派 · 粗黑边糖果色块", group: "minimal",
    design: "白底 + 粉/黄糖果色卡 + 4px 纯黑粗边 + 硬偏移阴影；倾斜堆叠。",
    signature: "4px 纯黑粗边框 + 8px 硬偏移阴影，倾斜糖果色卡片堆叠",
    hints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
    darkMode: false, primary: "#000000", secondary: "#FE90E8", accent: "#F7CB46",
    background: "#FFFFFF", surface: "#FFFDF5", titleColor: "#000000", bodyColor: "#000000",
    titleFont: "Inter", bodyFont: "Space Grotesk" },
  { slug: "blue-professional", label: "Blue Professional", description: "清爽专业 · 暖白底钴蓝点缀", group: "bold-pro",
    design: "暖奶油画布 + 唯一钴蓝高亮重点；干净不冷的现代专业感。",
    signature: "暖奶油画布上唯一钴蓝高亮所有重点元素",
    hints: "封面用 cover-split；内容页 v-content-modern；指标页 v-stat-bigtype。",
    darkMode: false, primary: "#1E2BFA", secondary: "#111111", accent: "#1E2BFA",
    background: "#FDFAE7", surface: "#FDFAE7", titleColor: "#111111", bodyColor: "#6B6B6B",
    titleFont: "Space Grotesk", bodyFont: "Inter" },
  { slug: "bold-poster", label: "Bold Poster", description: "杂志封面 · 戏剧大字", group: "bold-pro",
    design: "Shrikhand 巨型大字 + 一抹消防红 + 白纸；像可被引用的海报。",
    signature: "Shrikhand 大字旋转 -6°，红色重墨边栏与黑色粗框交替",
    hints: "封面用 cover-band；章节用 section-fullbleed；金句用 quote-block。",
    darkMode: false, primary: "#D8000F", secondary: "#1C1410", accent: "#D8000F",
    background: "#FFFFFF", surface: "#F5F2EF", titleColor: "#1C1410", bodyColor: "#1C1410",
    titleFont: "Shrikhand", bodyFont: "Libre Baskerville" },
  { slug: "broadside", label: "Broadside", description: "新闻头条 · 暗调火橙双语", group: "bold-pro",
    design: "墨黑大幕 + 唯一火橙作头条；超大 Barlow 黑字作图形。中英文双语友好。",
    signature: "超大 Barlow 900 小写黑字作图形，墨黑与火橙双寄存器切换",
    hints: "章节用 section-fullbleed；封面用 v-cover-gradient；金句用 quote-block。",
    darkMode: true, primary: "#E85D26", secondary: "#F0ECE5", accent: "#E85D26",
    background: "#111111", surface: "#1A1A18", titleColor: "#F0ECE5", bodyColor: "#888880",
    titleFont: "Barlow", bodyFont: "IBM Plex Mono" },
  { slug: "capsule", label: "Capsule", description: "胶囊几何 · Y2K 粉彩", group: "warm",
    design: "暖骨白底 + 胶囊形状卡 + 2px 描边 + 硬阴影；孟菲斯/编辑混搭。",
    signature: "全局 pill 胶囊几何，2px 描边 + 硬阴影的孟菲斯编辑混搭",
    hints: "封面用 cover-split；内容页 v-content-modern；数据页 stat-hero。",
    darkMode: false, primary: "#E85D4E", secondary: "#1E1E1E", accent: "#C4D94E",
    background: "#F5F5F0", surface: "#FFFFFF", titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
    titleFont: "Bodoni Moda", bodyFont: "Space Grotesk" },
  { slug: "cartesian", label: "Cartesian", description: "经典安静 · 暖中性 Playfair", group: "elegant",
    design: "暖砂岩底 + Playfair 衬线 + 1px 灰褐细线；不慌不忙的成熟感。",
    signature: "暖砂岩底上 1px 灰褐细线分割，背景漂浮制图圆环",
    hints: "封面用 cover-split；章节用 v-section-modern；对比页用 two-column。",
    darkMode: false, primary: "#1A1A1A", secondary: "#8A8178", accent: "#B8B0A4",
    background: "#EDE8E0", surface: "#E2DBD1", titleColor: "#1A1A1A", bodyColor: "#5A5A5A",
    titleFont: "Playfair Display", bodyFont: "Inter" },
  { slug: "cobalt-grid", label: "Cobalt Grid", description: "钴蓝衬线 · 网格出版物", group: "editorial",
    design: "米白纸面 + 透明坐标方格 + 钴蓝衬线大字；像设计研究公报。",
    signature: "米白纸面上常驻 10% 透明坐标方格，右缘像素故障扫描列",
    hints: "封面用 cover-split；内容页 v-content-modern；数据页 v-stat-bigtype。",
    darkMode: false, primary: "#1F2BE0", secondary: "#5560E5", accent: "#1F2BE0",
    background: "#F0EBDE", surface: "#E6E0CE", titleColor: "#1F2BE0", bodyColor: "#1F2BE0",
    titleFont: "Newsreader", bodyFont: "Hanken Grotesk" },
  { slug: "coral", label: "Coral", description: "珊瑚墨黑 · Bebas 杂志", group: "bold-pro",
    design: "近黑底 + 奶油 + 珊瑚红三色硬边相接；超大 Bebas Neue 作背景图形。",
    signature: "珊瑚/墨/奶油三色块硬边相接，超大数字与引号作背景",
    hints: "章节用 section-fullbleed；封面用 v-cover-gradient；金句用 quote-block。",
    darkMode: true, primary: "#E85D5D", secondary: "#F5F0E8", accent: "#E85D5D",
    background: "#1A1A1A", surface: "#F5F0E8", titleColor: "#F5F0E8", bodyColor: "#B0B0B0",
    titleFont: "Bebas Neue", bodyFont: "Inter" },
  { slug: "creative-mode", label: "Creative Mode", description: "丝网拼贴 · 多彩自信", group: "minimal",
    design: "奶油纸底 + 绿/粉/橙/黄多色 + Archivo Black 重字；4px 黑框 + 24px 硬阴影。",
    signature: "4px 墨黑粗框 + 24px 硬偏移阴影的丝网印刷拼贴美学",
    hints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
    darkMode: false, primary: "#0F0F0F", secondary: "#1F8A4C", accent: "#F06CA8",
    background: "#EFE9D9", surface: "#E4DCC4", titleColor: "#0F0F0F", bodyColor: "#2A2A2A",
    titleFont: "Archivo Black", bodyFont: "Space Grotesk" },
  { slug: "daisy-days", label: "Daisy Days", description: "手绘雏菊 · 粉彩暖友好", group: "warm",
    design: "燕麦底 + 粉/薄荷/黄柔配色 + 手绘雏菊星星装饰；柔软温和。",
    signature: "手绘雏菊星云装饰角落，3px 炭笔描边 + 大圆角卡片",
    hints: "封面用 cover-band；内容页 v-content-modern；对比页用 two-column。",
    darkMode: false, primary: "#F7C8D4", secondary: "#FDE68A", accent: "#D4A5E8",
    background: "#F5F0E6", surface: "#7ECDC0", titleColor: "#3A2A1A", bodyColor: "#3A2A1A",
    titleFont: "Fredoka One", bodyFont: "Quicksand" },
  { slug: "editorial-forest", label: "Editorial Forest", description: "森绿 + 玫瑰粉 · 安静编辑", group: "editorial",
    design: "燕麦奶油底 + 森林绿 + 玫瑰粉点缀 + Source Serif 大字。",
    signature: "森林绿、玫瑰粉、燕麦奶油三色编辑配色，220px 衬线大字",
    hints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
    darkMode: false, primary: "#2E4A2A", secondary: "#E89CB1", accent: "#E89CB1",
    background: "#EFE7D4", surface: "#E6DCC4", titleColor: "#2E4A2A", bodyColor: "#1A1A17",
    titleFont: "Source Serif 4", bodyFont: "Source Serif 4" },
  { slug: "editorial-tri-tone", label: "Editorial Tri-Tone", description: "粉/奶油/酒红 · 时装编辑", group: "editorial",
    design: "三色编辑系统：奶油黄、玫瑰粉、深酒红；衬线 + 无衬线对比强。",
    signature: "粉/奶油/酒红三色严格语义化，标题中 em 触发衬线斜体切换",
    hints: "封面用 cover-band；章节用 v-section-modern；金句用 quote-block。",
    darkMode: false, primary: "#7A1F35", secondary: "#F2B6C6", accent: "#F2D86A",
    background: "#F2D86A", surface: "#F2B6C6", titleColor: "#7A1F35", bodyColor: "#7A1F35",
    titleFont: "Bricolage Grotesque", bodyFont: "Bricolage Grotesque" },
  { slug: "emerald-editorial", label: "Emerald Editorial", description: "翡翠海军 · 杂志封面式商业", group: "editorial",
    design: "翡翠绿满铺 + 海军蓝 + 奶油纸；Bodoni 装饰双线饰带。",
    signature: "双线饰带夹中央衬线词，19 世纪戏剧海报式装饰",
    hints: "封面用 cover-band；章节用 v-cover-gradient；金句用 quote-block。",
    darkMode: true, primary: "#3CD896", secondary: "#0F1A5C", accent: "#F1E9D6",
    background: "#3CD896", surface: "#2DC684", titleColor: "#0F1A5C", bodyColor: "#0F1A5C",
    titleFont: "Bodoni Moda", bodyFont: "Manrope" },
  { slug: "grove", label: "Grove", description: "森林绿 + 锈红 · Playfair 古典", group: "elegant",
    design: "深林绿底 + 奶油字 + 锈红 Playfair 斜体；缓慢古典。",
    signature: "深林绿底上下细线框，赤陶珊瑚色斜体 Playfair 标题",
    hints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
    darkMode: true, primary: "#C8524A", secondary: "#E8E4D6", accent: "#C8524A",
    background: "#192B1B", surface: "#1E3221", titleColor: "#E8E4D6", bodyColor: "#D4CFBF",
    titleFont: "Playfair Display", bodyFont: "Jost" },
  { slug: "long-table", label: "Long Table", description: "锈红奶油 · 温暖社交", group: "warm",
    design: "奶油纸 + 锈红径向点纹 + Fraunces 衬线；像小店招贴。",
    signature: "奶油纸面 4px 径向点阵纹理，单一锈红墨色多透明度分层",
    hints: "封面用 cover-split；内容页 v-content-modern；对比页用 two-column。",
    darkMode: false, primary: "#B53D2A", secondary: "#8E2D1F", accent: "#B53D2A",
    background: "#FAF1E2", surface: "#F2E5CF", titleColor: "#B53D2A", bodyColor: "#B53D2A",
    titleFont: "Bricolage Grotesque", bodyFont: "Fraunces" },
  { slug: "mat", label: "Mat", description: "深沙绿 + 橙 · 中世纪现代", group: "elegant",
    design: "深沙绿画布 + 奶油纸卡 + 烧橙点缀；木质温暖的中世纪感。",
    signature: "深林绿画布右下角木棕径向光晕，奶油信息卡如纸张漂浮",
    hints: "封面用 cover-split；章节用 v-cover-gradient；内容页 content-sidebar。",
    darkMode: true, primary: "#C07030", secondary: "#EDE6D0", accent: "#C07030",
    background: "#232E26", surface: "#EDE6D0", titleColor: "#F0E8D2", bodyColor: "#F0E8D2",
    titleFont: "Bricolage Grotesque", bodyFont: "DM Sans" },
  { slug: "monochrome", label: "Monochrome", description: "纯黑白 · Lora 学术", group: "editorial",
    design: "象牙账本纸 + 纯黑字 + Lora 衬线；零彩色的考古级安静。",
    signature: "纯奶油纸面无任何彩色，黑墨与石墨灰单色调研究报告感",
    hints: "封面用 cover-split；内容页 v-content-modern；金句用 quote-block。",
    darkMode: false, primary: "#1A1A16", secondary: "#5E5E54", accent: "#8A8A80",
    background: "#FAFADF", surface: "#F2F2D2", titleColor: "#1A1A16", bodyColor: "#1A1A16",
    titleFont: "Lora", bodyFont: "Jost" },
  { slug: "neo-grid-bold", label: "Neo-Grid Bold", description: "霓虹黄信号 · 新野兽派", group: "bold-pro",
    design: "燕麦纸底 + 单一霓虹黄 + Space Grotesk 重字；编辑性强。",
    signature: "12×8 栅格内嵌 40px，柠檬黄信号高亮 + 2×2 角标块印章",
    hints: "封面用 cover-band；内容页 v-content-modern；数据页 v-stat-bigtype。",
    darkMode: false, primary: "#0A0A0A", secondary: "#8A8A85", accent: "#E6FF3D",
    background: "#F5F4EF", surface: "#ECECE8", titleColor: "#0A0A0A", bodyColor: "#0A0A0A",
    titleFont: "Space Grotesk", bodyFont: "JetBrains Mono" },
  { slug: "peoples-platform", label: "People's Platform", description: "活动家海报 · 蓝橙红丝印", group: "warm",
    design: "奶油纸 + 蓝/橙/红三色 + Alfa Slab 平板字 + 颗粒纹理。",
    signature: "红色双层堆叠字符投影 + 6px 墨边 + 颗粒纹理的丝网印刷质感",
    hints: "封面用 cover-band；章节用 v-section-modern；数据页 stat-hero。",
    darkMode: false, primary: "#2C2CDC", secondary: "#F2A03A", accent: "#E83A2A",
    background: "#F5F2EA", surface: "#F4E9D6", titleColor: "#2C2CDC", bodyColor: "#1A1A1A",
    titleFont: "Alfa Slab One", bodyFont: "DM Mono" },
  { slug: "pin-and-paper", label: "Pin & Paper", description: "安全别针 · 黄纸手作感", group: "warm",
    design: "亮黄便笺纸 + 手绘安全别针 + 蓝墨字 + Caveat 手写注脚。",
    signature: "手绘安全别针 SVG 将奶油卡片别在黄色便笺纸纹理背景上",
    hints: "封面用 cover-split；内容页 v-content-modern；对比页用 two-column。",
    darkMode: false, primary: "#1F3A8A", secondary: "#2D4FB8", accent: "#C9A66B",
    background: "#EFE56A", surface: "#F8F1D6", titleColor: "#1F3A8A", bodyColor: "#1F3A8A",
    titleFont: "Space Grotesk", bodyFont: "DM Mono" },
  { slug: "pink-script", label: "Pink Script", description: "黑底霓虹粉 · 夜场奢华", group: "elegant",
    design: "暖黑漆面 + 霓虹粉光晕 + DM Serif 衬线；午夜编辑奢华感。",
    signature: "暖黑漆面左上角径向光晕，胶片颗粒 + 1px 细框内嵌 36px",
    hints: "封面用 cover-split；章节用 v-cover-gradient；金句用 quote-block。",
    darkMode: true, primary: "#ED3D8C", secondary: "#FF66A8", accent: "#ED3D8C",
    background: "#060507", surface: "#0F0D11", titleColor: "#F5EDF1", bodyColor: "#F5EDF1",
    titleFont: "DM Serif Display", bodyFont: "Inter" },
  { slug: "playful", label: "Playful", description: "桃陶土暖底 · 独立友好", group: "warm",
    design: "桃陶土暖底 + Syne 字体 + 不对称 blob 形状；indie 友好。",
    signature: "桃陶土底色上双描边偏移卡片 + 不对称圆角 blob 形状轻微旋转",
    hints: "封面用 cover-band；内容页 v-content-modern；对比页用 two-column。",
    darkMode: false, primary: "#1A1A1A", secondary: "#E8B88E", accent: "#1A1A1A",
    background: "#F0C8A0", surface: "#F7DEC6", titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
    titleFont: "Syne", bodyFont: "Space Grotesk" },
  { slug: "raw-grid", label: "Raw Grid", description: "粗黑边 · 新野兽派直接", group: "bold-pro",
    design: "白底 + 粉/灰绿 + 3px 黑边 + 6px 黑阴影；scrappy confident。",
    signature: "3px 纯黑粗边即布局，6px 硬黑阴影 + 黑底白字胶囊标签",
    hints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
    darkMode: false, primary: "#0A0A0A", secondary: "#F2D4CF", accent: "#E5EDD6",
    background: "#FFFFFF", surface: "#F5F5F5", titleColor: "#0A0A0A", bodyColor: "#333333",
    titleFont: "Segoe UI", bodyFont: "Segoe UI" },
  { slug: "retro-windows", label: "Retro Windows", description: "Win95 复古 · 像素游戏感", group: "tech",
    design: "Win98 灰底 + 海军蓝标题栏 + Press Start 像素字；纯粹复古道具。",
    signature: "每页一个 Win98 窗口斜面 + 海军蓝渐变标题栏与系统按钮",
    hints: "封面用 cover-split；内容页 v-content-modern；对比页用 two-column。",
    darkMode: false, primary: "#000080", secondary: "#808080", accent: "#0000A0",
    background: "#C0C0C0", surface: "#D4D0C8", titleColor: "#000000", bodyColor: "#222222",
    titleFont: "Press Start 2P", bodyFont: "MS Sans Serif" },
  { slug: "retro-zine", label: "Retro Zine", description: "Riso 印刷 · 绿色色块独立刊", group: "warm",
    design: "米色纸 + 绿色偏移色块 + Bebas Neue + Caveat 手写；DIY zine 感。",
    signature: "SVG 颗粒覆盖 + 绿色色块偏移 12px 垫底白卡，旋转图章拼贴",
    hints: "封面用 cover-band；章节用 v-section-modern；数据页 stat-hero。",
    darkMode: false, primary: "#008F4D", secondary: "#1A1A1A", accent: "#00A85D",
    background: "#C8B99A", surface: "#F4EFE6", titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
    titleFont: "Bebas Neue", bodyFont: "Space Grotesk" },
  { slug: "sakura-chroma", label: "Sakura Chroma", description: "日式磁带包装 · 彩带条码", group: "tech",
    design: "奶油纸 + 红/粉/橙日系三色 + 斜彩带 + 印章；磁带包装感。",
    signature: "花瓣形 blob + 22° 斜彩带 + 12 芒星章 + 红方印的日式编辑感",
    hints: "封面用 cover-band；章节用 v-section-modern；数据页 stat-hero。",
    darkMode: false, primary: "#E5392A", secondary: "#E54489", accent: "#F09131",
    background: "#F1E6CB", surface: "#E5D6B0", titleColor: "#3A2516", bodyColor: "#3A2516",
    titleFont: "Big Shoulders Display", bodyFont: "Albert Sans" },
  { slug: "scatterbrain", label: "Scatterbrain", description: "便利贴拼贴 · 工作坊感", group: "warm",
    design: "亮黄底 + 蓝/粉/绿便利贴卡 + Shrikhand + Caveat 手写感。",
    signature: "软木板上彩色便利贴拼贴，红蓝绿金图钉与美纹胶带",
    hints: "封面用 cover-band；内容页 v-content-modern；对比页用 two-column。",
    darkMode: false, primary: "#FFE066", secondary: "#FFC9C9", accent: "#B2F2BB",
    background: "#FFE066", surface: "#A5D8FF", titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
    titleFont: "Shrikhand", bodyFont: "Zilla Slab" },
  { slug: "signal", label: "Signal", description: "海军蓝 + 古金 · 机构权威", group: "bold-pro",
    design: "深编辑海军蓝 + 暖奶油纸 + 古金色衬线斜体；安静的机构权威感。",
    signature: "深编辑海军蓝与暖奶油纸双面交替，古金色衬线斜体混排",
    hints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
    darkMode: true, primary: "#1C2644", secondary: "#F0ECE3", accent: "#C8A870",
    background: "#1C2644", surface: "#F0ECE3", titleColor: "#E2DCD0", bodyColor: "#8A96A8",
    titleFont: "Source Serif 4", bodyFont: "DM Sans" },
  { slug: "soft-editorial", label: "Soft Editorial", description: "Cormorant 衬线 · 暖纸文学", group: "editorial",
    design: "奶油底 + 罗马/斜体混排 + Cormorant Garamond；周日副刊的优雅。",
    signature: "奶油底上 24-36px 圆角半透明白卡漂浮，标题罗马 + 斜体混排",
    hints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
    darkMode: false, primary: "#2A241B", secondary: "#E1A4C2", accent: "#D6DD63",
    background: "#F2EEDF", surface: "#ECE6D2", titleColor: "#2A241B", bodyColor: "#5C5345",
    titleFont: "Cormorant Garamond", bodyFont: "Work Sans" },
  { slug: "stencil-tablet", label: "Stencil & Tablet", description: "石碑模板字 · 大地色考古", group: "minimal",
    design: "骨白纸 + 6 色大地调 + 模板镂空字；像考古手册。",
    signature: "Stardos 油墨断裂模板字 + 22-26px 圆角彩色药片卡片",
    hints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
    darkMode: false, primary: "#0A0A0A", secondary: "#A06A3C", accent: "#C73B7A",
    background: "#E2DCC9", surface: "#F4EFE0", titleColor: "#0A0A0A", bodyColor: "#0A0A0A",
    titleFont: "Stardos Stencil", bodyFont: "Inter" },
  { slug: "studio", label: "Studio", description: "电黄 + 近黑 · 高压设计感", group: "bold-pro",
    design: "近黑底 + 酸黄巨字；二元配色，无第三色。是库里最大声的。",
    signature: "近黑底上 12vw 酸黄巨字作为唯一设计元素，二元配色无第三色",
    hints: "章节用 section-fullbleed；封面用 v-cover-gradient；数据页 v-stat-bigtype。",
    darkMode: true, primary: "#F5D200", secondary: "#F0CC00", accent: "#F5D200",
    background: "#1C1C1C", surface: "#242422", titleColor: "#F5D200", bodyColor: "#F5D200",
    titleFont: "Barlow", bodyFont: "Barlow" },
  { slug: "vellum", label: "Vellum", description: "深海军 + 暖鹅黄衬线 · 学者", group: "elegant",
    design: "深长春花海军蓝单色场 + 暖鹅黄居中衬线斜体；学者气质。",
    signature: "深长春花海军蓝单色场 + 暖鹅黄居中斜体衬线，左下角打字注脚",
    hints: "封面用 cover-split；章节用 v-cover-gradient；金句用 quote-block。",
    darkMode: true, primary: "#E8D85C", secondary: "#F5E168", accent: "#3A7878",
    background: "#2A3870", surface: "#343F80", titleColor: "#E8D85C", bodyColor: "#E8D85C",
    titleFont: "Cormorant Garamond", bodyFont: "DM Sans" }
];

// ---------- 三段输出 ----------

const js = (s) => JSON.stringify(s);

// 1. registry.js 完整 entry 块
function genRegistryBlock() {
  let out = "";
  for (const s of SCHEMES) {
    out += `      "${s.slug}": Object.freeze({\n`;
    out += `        label: ${js(s.label)}, description: ${js(s.description)},\n`;
    out += `        design: ${js(s.design)},\n`;
    out += `        signatureElement: ${js(s.signature)},\n`;
    out += `        layoutHints: ${js(s.hints)},\n`;
    out += `        darkMode: ${s.darkMode},\n`;
    out += `        primaryColor: ${js(s.primary)}, secondaryColor: ${js(s.secondary)}, accentColor: ${js(s.accent)},\n`;
    out += `        backgroundColor: ${js(s.background)}, surfaceColor: ${js(s.surface)},\n`;
    out += `        titleColor: ${js(s.titleColor)}, bodyColor: ${js(s.bodyColor)},\n`;
    out += `        titleFont: ${js(s.titleFont)}, bodyFont: ${js(s.bodyFont)}\n`;
    out += `      }),\n`;
  }
  return out;
}

// 2. app.js 镜像（colors + fonts only）
function genAppMirrorBlock() {
  let out = "";
  for (const s of SCHEMES) {
    const pad = " ".repeat(Math.max(1, 22 - s.slug.length));
    out += `    "${s.slug}":${pad}{ darkMode: ${s.darkMode}, primaryColor: ${js(s.primary)}, secondaryColor: ${js(s.secondary)}, accentColor: ${js(s.accent)}, backgroundColor: ${js(s.background)}, surfaceColor: ${js(s.surface)}, titleColor: ${js(s.titleColor)}, bodyColor: ${js(s.bodyColor)}, titleFont: ${js(s.titleFont)}, bodyFont: ${js(s.bodyFont)} },\n`;
  }
  return out;
}

// 3. HTML <option> grouped
function genHtmlOptions() {
  const groups = {
    "bold-pro": "高冲击 / 专业（bold pack）",
    "editorial": "编辑 / 出版（bold pack）",
    "warm": "暖系 / 手作（bold pack）",
    "elegant": "优雅 / 沉静（bold pack）",
    "tech": "科技 / 复古（bold pack）",
    "minimal": "极简 / 装饰（bold pack）"
  };
  let out = "";
  for (const [key, label] of Object.entries(groups)) {
    const items = SCHEMES.filter((s) => s.group === key);
    if (!items.length) continue;
    out += `              <optgroup label="${label}">\n`;
    for (const s of items) {
      out += `                <option value="${s.slug}">${s.label} · ${s.description.split(" · ")[1] || s.description}</option>\n`;
    }
    out += `              </optgroup>\n`;
  }
  return out;
}

// ---------- 写文件 ----------

const outDir = path.join(__dirname, ".gen");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "registry-block.txt"), genRegistryBlock(), "utf8");
fs.writeFileSync(path.join(outDir, "app-mirror-block.txt"), genAppMirrorBlock(), "utf8");
fs.writeFileSync(path.join(outDir, "html-options.txt"), genHtmlOptions(), "utf8");

console.log("schemes:", SCHEMES.length);
console.log("slugs:", SCHEMES.map((s) => s.slug).join(", "));
console.log("output dir:", outDir);
