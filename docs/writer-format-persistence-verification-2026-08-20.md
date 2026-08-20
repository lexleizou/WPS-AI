# Writer 格式持久化修复验收（2026-08-20）

## 结论

macOS WPS Writer 中的目录段落缩进与目录样式修改已通过真实文档副本验收。修改在保存后的 DOCX OOXML 中保持，不再只是 COM 即时读回成功。

对应修复提交：`a0e3690 fix(writer): persist paragraph and style formatting`

## 根因

WPS 在 TOC 域结果上返回的 `Range.ParagraphFormat` / `Selection.ParagraphFormat` 可能是瞬时格式代理：

- 属性赋值和即时回读均显示成功；
- 文档重绘或保存后，修改不会写入 DOCX；
- 保存前后 OOXML 可以完全不变。

可持久化路径是逐段写入 `Paragraph.Format`。部分 WPS 版本还会把 `Style.ParagraphFormat` 作为可写副本返回，因此样式修改完成后必须将整个格式对象赋回样式，再重新读取验证。

## 修复

- 选区格式写入改为逐段使用 `Paragraph.Format`，不再依赖选区级瞬时代理。
- Format Guard 的审计、写入和最终回读统一使用 `Paragraph.Format`。
- 写点值缩进前清零 `CharacterUnitLeftIndent`、`CharacterUnitFirstLineIndent` 和 `CharacterUnitRightIndent`。
- 样式格式修改后整体赋回 `Style.ParagraphFormat`，并从样式重新读取缩进与制表位。
- 新增持久化路径回归测试；完整测试为 27/27 通过。

## 真实 WPS 验收证据

验收时间：2026-08-20 10:18–10:19（GMT+8）。

执行链路：

1. 审计 18 条二级目录段落；
2. 统一应用不匹配项；
3. 再次审计，结果为 `matchedCount=18`、`mismatchCount=0`；
4. 同步“目录 2”样式；
5. 同步“目录 1/2”页码制表位；
6. 保存文档。

保存后的 DOCX OOXML 检查结果：

- 18 条 TOC2 段落：`w:left="283"`，即 `14.15 pt`；`w:firstLine="0"`；字符单位首行缩进为 `0`。
- TOC2 样式：`w:left="283"`、`w:firstLine="0"`。
- TOC1 与 TOC2 样式制表位：`w:pos="8306"`，即 `415.30 pt`；右对齐、点状前导符。
- 本轮无失败、无事务回滚。
- 未调用目录更新或重建工具。

## 运行时状态

修复已从 canonical plugin 原子同步到四个宿主运行时：WPS、ET、WPP、PDF。真实 WPS 复测前执行了完整退出并重启。

## macOS 剪贴板入口说明

当前 macOS WPS 版本仍可能在 WebView 之前抢占标准 `⌘C` / `⌘V`。可靠入口是任务窗格中的“安全复制”和“安全粘贴”按钮；实现不会通过盲目 Undo 处理重复粘贴。
