# Changelog

## 0.2.3

- ���� bundle patch ��������saibo-kanban��������װ�� loader ��ȥ import �����ڵ� saibo_kanban��

## 0.2.2

- 修正 `bin` 路径（去�?`./`），npm 不再丢弃 CLI 入口�?- 首个 npm 版本�?.2.1 因暂存发布流程被撤回）�?
## 0.2.1

- 新增 CLI `saibo-board`（`bin/board.mjs`）：`list / inbox / add / show / accept / unaccept /
  archive / restore / update / search / brief`。人的操作走本地直写，不经过模型�?- `store.history(id)`：读取单条目的完整修订历史�?
## 0.2.0

- `core.js`：条目模型、类�?状态校验、状态机、字段级 diff、简报、检索�?- `store.js`：`$DSH_HOME/saibo_kanban/records.jsonl` 只追加台账；乐观锁（`expectedRev`）；归档/恢复�?  合并与取代语义；重新加载按修订重放�?- `tools.js`：六个工�?`board_brief / board_record / board_update / board_supersede / board_merge / board_search`�?  AI 只能字段�?patch、不能写 done、不能改确认状态�?- `test/run.mjs`�?2 项自测，覆盖记录、冲突、状态机、接受、取代、合并、归档过滤、重放�?
## 0.1.0

- 骨架：`package.json`（bundle patch、exports、files、engines）、`cordis.patch.yml`�?  中英�?locale、图标、README、DETAIL、LICENSE、CHANGELOG�?- 尚未注册工具或界面，安装后不可用�?