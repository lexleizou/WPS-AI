# 灵犀AI Writer Format Guard

独立、可回滚的 WPS 文字最小格式修改补丁（`LINGXI_WRITER_FORMAT_GUARD_V1`）。

## 行为

当用户要求统一字体、字号、行距、缩进、对齐或段前段后时，模型应遵循：

1. `wps_audit_paragraph_format`：只读审计真实格式，返回不符合项的连续锚点组；
2. 若 `mismatchCount=0`：报告“无需修改”，不调用任何写工具；
3. `wps_apply_paragraph_format_mismatches`：只能使用审计返回的 `auditId`，写前再读取，并只给实际不符合的属性赋值；
4. 再次审计，确认无剩余不符合项。

该写工具会被既有 History/备份/修订模式记录。符合要求的段落和字段不会被重新赋值，避免产生无意义的修订。

原 `wps_format_paragraph` 的 `scope=document` 已被安全拦截；局部 `scope=selection` 行为保持不变。

## 管理

```bash
python3 ~/.lingxi-ai/fixes/writer-format-guard/apply-writer-format-guard.py --apply
python3 ~/.lingxi-ai/fixes/writer-format-guard/apply-writer-format-guard.py --check
python3 ~/.lingxi-ai/fixes/writer-format-guard/apply-writer-format-guard.py --remove
node ~/.lingxi-ai/fixes/writer-format-guard/test-writer-format-guard.js
```

`--apply` / `--remove` 均在操作前创建时间戳备份。它只管理 Phase 2 的两条 `main.js` 加载标记和两份新资产；不会覆盖 `app.js`、原 `writer.js`、原 `hosts/writer.js` 或 `style.css`。
