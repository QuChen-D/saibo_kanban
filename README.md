# 赛博看板 / Saibo Kanban

一个给 DeepSeek Harness 用的**活看板**：AI 负责起草，人负责调整，每次改动都能回滚。

> 当前版本 0.3.0：左侧出现「看板」入口，中央面板有收件箱 / 看板 / 表格三视图；
> 七个工具（含回滚）。AI 与人权限对等，出错就回滚。

## 为什么做这个

- AI 写东西准确率 80–90%，会漏、会改口。所以每条改动都留修订，**错了一键回滚**。
- 人没有填表的意愿，但有改和删的意愿。页面以表格为主界面，点单元格就能改。
- Excel 的问题不是「表格」，是没有行身份、字段约束和变更历史。看板就是一张**有状态的智能表格**。

## 设计

- **收件箱**：最近变更的条目，用来快速扫一眼。
- **看板**：按状态分列，拖拽换列。
- **表格**：主界面，点标题直接改，类型/状态/范围用下拉。
- **详情抽屉**：全字段 + 修订历史，每一版都有「回滚」。

数据模型：条目带稳定 ID，每次写入都是**新修订**（字段级 diff、作者、来源），不是覆盖。
权限对等：AI 可以标完成、可以归档；人通过页面做同样的事。防跑偏靠状态机校验、必填校验、乐观锁（带错修订号就拒绝）和回滚。

## 安装

**npm**

```bash
dsh plugin --profile web add saibo-kanban
```

**GitHub 源码**

```bash
dsh plugin --profile web add github:QuChen-D/saibo_kanban
```

**在 DSH 里操作**：左侧「插件」→ 添加插件 → 安装第三方插件 → 输入 `saibo-kanban`。

## 数据

存放在 `$DSH_HOME/saibo_kanban/records.jsonl`（只追加），可用 `config.dataDir` 改。
卸载插件不删除数据。

## 怎么用

**对话**

```
记一条：把导入改成列映射 + 预览，范围 导入
看看板简报
找一下关于表单的条目
```

**页面**：左侧「看板」图标 → 收件箱 / 看板 / 表格。

**CLI**

```bash
node bin/board.mjs list
node bin/board.mjs add "标题" --kind decision --scope 存储
node bin/board.mjs show <id>
node bin/board.mjs brief
```

## 工具

| 工具 | 作用 |
|---|---|
| `board_brief` | 读简报：按状态列出全部条目 |
| `board_record` | 写入一条新条目 |
| `board_update` | 按字段改一条，必须带 `expectedRev` |
| `board_supersede` | 用新条目取代旧条目，旧条目保留并指向新条目 |
| `board_merge` | 合并两条以上，来源归档并指向新条目 |
| `board_rollback` | 回滚到任意修订，回滚本身也记一条修订 |
| `board_search` | 按关键词 / 状态 / 类型 / 范围检索 |

## 路线图

- [x] 0.1.0 骨架
- [x] 0.2.0 核心 + 工具
- [x] 0.3.0 DSH 内页面（表格 / 看板 / 收件箱）+ 回滚
- [ ] 0.4.0 xlsx 导入（列映射 + 预览 + 冲突报告）
- [ ] 0.5.0 brief 注入与复用统计

## 开发

```bash
npm run check   # 语法检查
npm test        # 自测（不依赖 DSH）
```

## License

MIT
