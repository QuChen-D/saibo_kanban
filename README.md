# 赛博看板 / Saibo Kanban

一个给 DeepSeek Harness 用的**活看板**：AI 负责起草，人负责分拣，每次改动都有修订记录。

> 当前版本 0.2.0：六个积木级工具已经可用（记录 / 修改 / 取代 / 合并 / 检索 / 简报）。
> 界面（收件箱 / 看板 / 表格）在 0.3.0 接入。

## 为什么做这个

- AI 写东西准确率 80–90%，会漏、会改口。看板要能用，错的地方必须**一眼看见、一秒改掉、随时能回滚**。
- 人没有填表的意愿，但有改和删的意愿。所以：**AI 写草稿 → 收件箱 → 人做接受/退回/合并/删除**，全程本地动作，不经过模型，不花 token。
- Excel 的问题不是「表格」，是没有行身份、字段约束和变更历史。看板就是一张**有状态的智能表格**。

## 设计（三视图、三入口）

- **收件箱**：AI 写的草稿都在这，人只做分拣。
- **看板**：拖拽换列 = 改状态；虚线卡 = 待确认。
- **表格**：点单元格直接改；改一个字段不需要打开表单。
- **详情抽屉**：全字段 + 修订历史 + 来源（哪次会话、哪条消息）。
- 表单只出现在两个地方：新建（一行快加）和导入映射。没有全字段录入弹窗。

数据模型：条目带稳定 ID，每次写入都是**新修订**（字段级 diff、作者、来源），不是覆盖。
AI 只能字段级 patch，不能整条覆盖、不能标完成、不能物理删除——这些是代码闸，不是提示词约定。

## 安装

**npm（发布后）**

```bash
dsh plugin --profile web add saibo_kanban
```

**GitHub 源码**

```bash
dsh plugin --profile web add github:QuChen-D/saibo_kanban
```

**本地开发**

```bash
dsh plugin --profile web add /absolute/path/to/saibo_kanban
```

## 数据

存放在 `$DSH_HOME/saibo_kanban/records.jsonl`（只追加），可用 `config.dataDir` 改。
卸载插件不删除数据。

## 静态原型

[`demo/index.html`](demo/index.html) 是产品手感的单文件原型：表格 / 看板 / 收件箱三视图、
就地编辑、拖拽、修订历史、5 秒撤销。不依赖任何构建，双击即开；数据只存在浏览器 localStorage。

它验证的是 0.3.0 要搬进 DSH 的交互，不是最终实现。

## 怎么用（现在就能用）

**1. 在对话里让 agent 记**

```
记一条：把导入改成列映射 + 预览
看看板简报
找一下关于表单的条目
```

agent 会调 `board_*` 工具。注意：AI 写进去的是**待确认草稿**，要在收件箱里由人接受。

**2. 用 CLI（人的入口，0 token）**

```bash
node bin/board.mjs inbox            # 看待确认
node bin/board.mjs accept <id>      # 接受
node bin/board.mjs add "标题" --kind decision --scope 存储
node bin/board.mjs list             # 全部条目
node bin/board.mjs show <id>        # 详情 + 修订历史
node bin/board.mjs brief            # 简报（只读已确认）
```

数据默认在 `$DSH_HOME/saibo_kanban/records.jsonl`，可用 `--data-dir` 或环境变量 `SAIBO_DATA_DIR` 指定。

**3. 页面（0.3.0 接入）**

收件箱 / 看板 / 表格三视图，行为与 `demo/index.html` 一致。

## 工具

| 工具 | 作用 |
|---|---|
| `board_brief` | 读简报：按状态列出已确认条目，附待确认草稿数 |
| `board_record` | 写入一条草稿（默认待确认），进收件箱 |
| `board_update` | 按字段改一条，必须带 `expectedRev` |
| `board_supersede` | 用新条目取代旧条目，旧条目保留并指向新条目 |
| `board_merge` | 合并两条以上，来源归档并指向新条目 |
| `board_search` | 按关键词 / 状态 / 类型 / 范围检索 |

## 路线图

- [x] 0.1.0 骨架：manifest、patch、locale、图标、文档
- [x] 0.2.0 `core.js` + `store.js` + 六个工具
- [ ] 0.3.0 DSH 内 React 页面（表格/看板/收件箱）
- [ ] 0.4.0 xlsx 导入（列映射 + 预览 + 冲突报告）
- [ ] 0.5.0 brief 注入与复用统计

## 开发

```bash
npm run check   # 语法检查
npm test        # 12 项自测（不依赖 DSH）
```

## License

MIT
