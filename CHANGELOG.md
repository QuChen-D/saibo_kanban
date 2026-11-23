# Changelog

## 0.5.6

- 快加条目继承当前筛选：范围取当前范围筛选值，状态取当前状态筛选值（未筛选时默认待办），内容留空。

## 0.5.5

- 取消状态流转限制：任意状态可以互转（例如 todo 直接改 done），只校验状态值本身；改错可回滚。

## 0.5.4

- 表格列宽重排：标题固定宽度、内容占剩余空间，行高收紧。
- 「详情」按钮不再折行。
- 内容列显示真正的说明文字（自动跳过「编号 / 优先级 / 来源」等元数据行）。
- 导入时把说明放在正文第一行，元数据放后面。

## 0.5.3

- 表格新增「内容」列（标题与类型之间）：正文首行直接可见，点击打开详情。
- 看板卡片悬停显示详情浮层：标题 / 正文 / 状态 / 类型 / 范围。

## 0.5.2

- 移除归档功能：页面、接口、CLI 都不再有归档/恢复；done 条目直接可见。
- 导入不再把主表归档，done 原样进入列表。
- 表头与筛选合并为一行（类型 / 状态 / 范围 直接放在表头格子里）。
- 删除导入时生成的「节点说明」条目；导入默认不再包含它。

## 0.5.1

- 表格去掉「编号」列（原始 id 不再展示）。
- 表头下加筛选行：类型 / 状态 / 范围；范围选项从现有数据生成。
- 列表改为滚动加载（每次 100 条，滚到底自动加载，另有「加载更多」兜底），显示总数。
- 列表上限从 200 提到 2000，已归档不再被截断。
- 导入默认跳过「节点说明」（CLI 加 `--include-notes` 才导入）。

## 0.5.0

- 表格加表头（# / 编号 / 标题 / 类型 / 状态 / 范围 / 修订）和行序号。
- 归档条目默认隐藏，新增「显示归档 / 隐藏归档」切换；归档行淡化并带「已归档」徽标。
- 详情抽屉对归档条目显示「恢复」而不是「归档」。

## 0.4.1

- 导入改为页面操作：看板面板 → 「导入 xlsx」→ 选文件 → 预览数量 → 确认导入。
- 导入映射抽到 `lib/import-map.js`，页面与 CLI 共用；导入按「范围 + 标题」去重。

## 0.4.0

- 新增 xlsx 导入：`node bin/import.mjs --xlsx <文件> [--dry-run]`。
  - 任务主表 → 归档历史条目（done）
  - 长期滚动项 → 活跃条目（TODO→待办、PARTIAL/FIX→进行中、BLOCKED→受阻、暂缓→待规划）
  - 节点说明 → 一条 design 资产
- 零依赖 XLSX 读取器（`lib/xlsx.js`，只读 ZIP + sharedStrings，不装任何包）。
- 看板 Tab 调到「对话」左边（order -10）。

## 0.3.1

- 入口改到顶部视图导航（`conversation.view`），像记忆插件的「记忆 / 技能 / 待办」那样以 Tab 出现，不再占左侧导航。

## 0.3.0

- 新增页面：左侧「看板」入口 + 中央面板（收件箱 / 看板 / 表格三视图）。
- host 新增 `/saibo-kanban/api`：list / get / create / update / archive / restore / rollback / brief。
- 权限对等：AI 与人同一套规则；新增 `board_rollback`，回滚本身也记一条修订。
- 移除 `verified` 确认机制（回滚兜底），简报改为列出全部条目。

## 0.2.3

- 修正 bundle patch 的行名（`saibo-kanban`），否则安装后 loader 会去 import 不存在的 `saibo_kanban`。

## 0.2.2

- 修正 `bin` 路径（去掉 `./`），npm 不再丢弃 CLI 入口。

## 0.2.1

- 新增 CLI `saibo-board`：list / inbox / add / show / accept / unaccept / archive / restore / update / search / brief。
- `store.history(id)`：读取单条目的完整修订历史。

## 0.2.0

- `core.js`：条目模型、类型/状态校验、状态机、字段级 diff、简报、检索。
- `store.js`：`$DSH_HOME/saibo_kanban/records.jsonl` 只追加台账；乐观锁（`expectedRev`）；
  归档 / 恢复；合并与取代语义；重新加载按修订重放。
- `tools.js`：六个工具 `board_brief / record / update / supersede / merge / search`。

## 0.1.0

- 骨架：`package.json`（bundle patch、exports、files、engines）、`cordis.patch.yml`、
  中英文 locale、图标、README、DETAIL、LICENSE、CHANGELOG。
