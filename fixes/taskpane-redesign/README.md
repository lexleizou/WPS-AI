# 灵犀AI Graphite TaskPane 补丁

独立、可回滚的 Ant Design v6 × macOS Graphite 主 TaskPane 布局补丁。

- 不修改 `js/app.js` 或 `css/style.css`。
- 保留现有业务节点 ID 和事件。
- 只在主 TaskPane 运行；设置、预览、素材库等独立 Dialog 模式不重排。
- 系统浅色/深色自动跟随。
- 保留主模型、思考强度、附件、发送/停止、修订模式、历史、生图和更多菜单入口；原临时模型入口改为提示词预置。
- 不添加语音输入。
- Writer Inspector 的地图、锚点精读、格式审计会聚合成三阶段检查卡，显示状态、范围、耗时和完成数。
- 检查运行时在 Composer 上方显示只读状态条；“停止”复用原 `chatStopBtn`，不创建第二套请求控制。
- 实时会话与历史回放使用同一聚合卡；普通工具继续使用原时间轴。
- “服务状态”增加可展开的 LiteLLM 模型目录：可拉取本机可用模型并控制其在灵犀模型选择器中的可见性；该开关不修改 LiteLLM 路由或影响 Sally / Proma。模型目录经本地 `:3890` 代理读取，LiteLLM 凭据不进入 WebView。
- 聊天模型中现有授权入口明确标示为 `Codex OAuth（ChatGPT 帐号）`，复用已有 PKCE 登录流。
- 每个聊天 Provider 卡新增“已拉取模型管理”：显式“拉取模型”会复用该 Provider 原有认证/代理路径；对已拉取的非默认模型可以“关闭”（从下拉隐藏）或“删除”（从本地模型缓存移除）。默认模型需先更换默认值后再删除，以避免配置悬空。

## 文档检查进度

仅以下三个只读工具进入聚合卡：

- `wps_get_document_map` → 建立文档地图
- `wps_read_by_anchor` → 读取锚点范围
- `wps_read_paragraph_format` → 核对段落格式

聚合层只镜像原 Timeline 的调用与结果。原 `addToolStep`、`finishToolStep`、工具参数、历史事件、停止逻辑和 Writer 工具实现保持不变；纯 Inspector 的原工具组仅在视觉上隐藏，混合工具组保留原始时间轴以避免信息丢失。

检查卡会按真实调用路径显示：地图 + 格式审计显示“格式检查完成（2 / 2）”，锚点精读行显示“无需执行（纯格式检查）”；地图 + 锚点精读显示“内容精读完成（2 / 2）”；三项都完成才显示“文档检查完成（3 / 3）”。只有已开始却中断的阶段才会显示“未执行/已停止”，不会把不适用的路径误写为检查未完成。

上下文圆环的 token 提示使用挂载在 `body` 下的单一 fixed tooltip，按 WebView 四边留 8px 钳制；不再同时显示 CSS 伪元素和原生 `title` 两份提示。

## Proma 式任务进度

现有 `todo_replace_all` / `todo_patch` 仍是唯一持久化事实源；Graphite 只订阅其状态并渲染，不写入任务、对话或文档。

- 仅 `completed` 推进“完成数 / 总数”；`skipped`、失败、停止都不会伪装成成功完成。
- 折叠态显示紧凑的当前步骤与真实状态，点击展开完整清单；展开偏好独立保存为 `lingxi_graphite_task_progress_expanded`。
- `failed` 或用户停止后，后续未开始步骤显示“被阻塞”；新一次 `todo_replace_all` 会清除上一轮运行态。
- 点击停止仍只触发原 `chatStopBtn.click()`；停止状态是显示投影，不会擅自篡改持久化 todo。
- 所有状态同时以图标、文字和数据属性表达；卡片最大 176px，任务清单内部滚动，适配窄窗与深色模式。

## 提示词预置

Composer 原“单次临时模型”按钮已改为提示词预置入口；右侧主模型选择器保持不变。

- 首次使用提供“桓科 URS 检查”“文档只读体检”“专业润色”三套预置；URS 预置会按任务类型选择检查路径：内容风险用地图 + 锚点精读，格式要求用先审计、只改不符合项、再复核，不再强制无关的锚点精读。
- 支持选择填入、新建、编辑、复制和删除；数据保存在同源 `localStorage`，补丁升级不会覆盖用户内容。
- 若输入框已有草稿，选择预置会保留草稿并放到“本次补充”段落。
- “生成经验总结”只把复盘请求填入输入框，不自动发送。
- “收录最近回复”把最新 AI 正文带入编辑器；用户审阅、删改并点击保存后，才会按日期追加到当前预置的“已沉淀经验”。
- 再次使用该预置时，基础提示词与已沉淀经验一起填入。

卸载 Graphite 补丁不会主动删除已保存的预置；这可避免误删用户内容。若要彻底清除，可在浏览器/WPS WebView 的站点数据中删除 `lingxi.graphite.prompt-presets.*`。

## 管理

```bash
python3 ~/.lingxi-ai/fixes/taskpane-redesign/apply-taskpane-redesign.py --apply
python3 ~/.lingxi-ai/fixes/taskpane-redesign/apply-taskpane-redesign.py --check
python3 ~/.lingxi-ai/fixes/taskpane-redesign/apply-taskpane-redesign.py --remove
```

`--remove` 仅删除本补丁的受管 HTML 标记和两份资产，不整体覆盖插件文件。每次应用/卸载前的备份位于 `backups/`。

## 测试

```bash
python3 ~/.lingxi-ai/fixes/taskpane-redesign/test-taskpane-redesign.py
```
