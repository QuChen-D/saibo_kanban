# Changelog

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
