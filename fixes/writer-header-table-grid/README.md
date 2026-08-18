# 页眉表格安全恢复（V2）

## 强制流程

1. `wps_get_header_table_recovery_profile`：读取当前文档身份、目标页眉、实际所有者节、链接关系、网格、Logo 与文本指纹。
2. 将用户任务中的公司名、标题或文件编号传入 `expectedHeaderText`；不得从当前文档反推目标。
3. 只有档案显示为可规范化时，才能调用 `wps_normalize_header_table_row_to_three_columns`。
4. 结构写入后必须重新读取恢复档案；未通过 Logo、文本、参考行和网格验证时停止。

## 硬边界

- `LinkToPrevious=true` 的从属页眉不允许写入；需定位实际所有者节后重新审计。
- 页眉裸列宽、跨节列宽复制、整表宽度与自动调整写入均已暂停。
- `0`、`9999999`、空值或超过 `1440pt` 的列宽是异常状态，不能用于计算或写入。
- 不得把“底层三列”误认为“视觉结构已恢复”；必须同时验证 Logo 首列、前两行横向合并及第三行右侧独立单元格。

## 验证

```bash
node test-writer-header-table-grid.js
python3 apply-writer-header-table-grid.py --apply
python3 apply-writer-header-table-grid.py --check
```
