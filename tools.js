/**
 * tools.js — 暴露给模型的积木级工具。
 *
 * 每个工具只做一件事；规则从 core/store 来，不在这里重复。
 * 物理删除只用于「这条本身搞错了」；不用了请改状态或用 board_supersede。
 */
import { DEFAULT_KINDS, STATUSES, BoardError } from './core.js';

const text = value => [{ type: 'text', text: value }];

function serialize(value) {
  return JSON.stringify(value, null, 2);
}

function fail(error) {
  if (error instanceof BoardError) {
    const err = new Error(`${error.code}: ${error.message}`);
    err.code = error.code;
    throw err;
  }
  throw error;
}

function wrap(fn) {
  return async (args, exec) => {
    try {
      return await fn(args || {}, exec);
    } catch (error) {
      fail(error);
    }
  };
}

export function createTools(store, options = {}) {
  const kinds = options.kinds || DEFAULT_KINDS;
  const kindIds = kinds.map(k => k.id);
  const statusIds = STATUSES.map(s => s.id);
  const maxBriefChars = options.maxBriefChars ?? 4000;

  return [
    {
      name: 'board_brief',
      description: '读取看板简报：按状态列出全部条目。只读，不修改数据。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: '只保留这个范围的条目，例如“看板插件”；省略表示全部' },
          maxChars: { type: 'number', description: '返回文本上限，默认取插件配置' }
        },
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { markdown: { type: 'string' }, stats: { type: 'object' } },
          required: ['markdown', 'stats']
        },
        render: (_args, value) => text(value.markdown)
      },
      execute: wrap(async args => {
        const items = [...store.items.values()];
        const scoped = args.scope ? items.filter(i => i.scope === args.scope) : items;
        const markdown = store.brief({
          maxChars: Number.isFinite(args.maxChars) ? args.maxChars : maxBriefChars
        });
        const stats = { ...store.stats(), inScope: scoped.length };
        return {
          markdown: args.scope
            ? markdown + `\n\n（范围 ${args.scope}：${scoped.length} 条）`
            : markdown,
          stats
        };
      })
    },
    {
      name: 'board_record',
      description: '把一条新条目写进看板。标题说清是什么，正文只写一句结论。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题，必填，最长 200 字' },
          kind: { type: 'string', enum: kindIds, description: '条目类型，默认 task' },
          scope: { type: 'string', description: '所属范围，例如“看板插件”“存储”；不确定就省略' },
          body: { type: 'string', description: '正文：第一行写结论（不看标题也能读懂），需要时再补「为什么」「以后」；说人话、少废话，不复述标题' },
          status: { type: 'string', enum: statusIds.filter(s => s !== 'done'), description: '初始状态，默认 backlog' },
          source: {
            type: 'object',
            description: '来源：type=session/file/web/manual，ref=会话 id 或文件名',
            properties: { type: { type: 'string' }, ref: { type: 'string' } },
            additionalProperties: false
          }
        },
        required: ['title'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, rev: { type: 'number' }, item: { type: 'object' } },
          required: ['id', 'rev']
        },
        render: (_args, value) => text(`已记录 ${value.id}（r${value.rev}）`)
      },
      execute: wrap(async args => {
        const item = store.record(args, { by: 'ai', note: 'AI 记录' });
        return { id: item.id, rev: item.rev, item: publicItem(item) };
      })
    },
    {
      name: 'board_update',
      description: '按字段修改一条条目。必须带当前修订号；只能改 title/kind/status/scope/body。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id，例如 b-xxxx' },
          expectedRev: { type: 'number', description: '你读到的当前修订号；不一致会拒绝，需重新读取' },
          title: { type: 'string' },
          kind: { type: 'string', enum: kindIds },
          status: { type: 'string', enum: statusIds },
          scope: { type: 'string' },
          body: { type: 'string', description: '正文：第一行结论，可再补「为什么」「以后」' },
          note: { type: 'string', description: '这次改动的理由，会写进修订历史' }
        },
        required: ['id', 'expectedRev'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, rev: { type: 'number' }, changed: { type: 'boolean' }, changes: { type: 'object' } },
          required: ['id', 'rev', 'changed']
        },
        render: (_args, value) => text(value.changed
          ? `已更新 ${value.id} → r${value.rev}（${Object.keys(value.changes || {}).join(', ')}）`
          : `没有字段变化，${value.id} 仍是 r${value.rev}`)
      },
      execute: wrap(async args => {
        const patch = {};
        for (const field of ['title', 'kind', 'status', 'scope', 'body']) {
          if (args[field] !== undefined) patch[field] = args[field];
        }
        const result = store.update(args.id, patch, {
          by: 'ai', expectedRev: args.expectedRev, note: args.note || 'AI 修改'
        });
        return {
          id: result.item.id,
          rev: result.item.rev,
          changed: result.changed,
          changes: result.changes || {},
          item: publicItem(result.item)
        };
      })
    },
    {
      name: 'board_supersede',
      description: '用一条新条目取代旧条目（旧条目保留并指向新条目）。用于结论变了、旧条目不能再直接改的场景。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '被取代的旧条目 id' },
          expectedRev: { type: 'number', description: '旧条目当前修订号' },
          title: { type: 'string', description: '新条目的标题' },
          kind: { type: 'string', enum: kindIds },
          scope: { type: 'string' },
          body: { type: 'string', description: '正文：第一行结论，可再补「为什么」「以后」' },
          status: { type: 'string', enum: statusIds.filter(s => s !== 'done'), description: '新条目状态，默认 in_review' },
          note: { type: 'string' }
        },
        required: ['id', 'expectedRev', 'title'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { oldId: { type: 'string' }, newId: { type: 'string' }, rev: { type: 'number' } },
          required: ['oldId', 'newId']
        },
        render: (_args, value) => text(`已用 ${value.newId} 取代 ${value.oldId}`)
      },
      execute: wrap(async args => {
        const result = store.supersede(args.id, {
          title: args.title,
          kind: args.kind,
          scope: args.scope,
          body: args.body,
          status: args.status || 'in_review'
        }, { by: 'ai', expectedRev: args.expectedRev, note: args.note || `AI 取代 ${args.id}` });
        return { oldId: result.old.id, newId: result.created.id, rev: result.created.rev };
      })
    },
    {
      name: 'board_merge',
      description: '把两条以上重复或相近的条目合并成一条新条目；来源条目归档并指向新条目。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '要合并的条目 id，至少两个' },
          title: { type: 'string', description: '合并后条目的标题' },
          kind: { type: 'string', enum: kindIds },
          scope: { type: 'string' },
          body: { type: 'string', description: '合并后的正文；省略则取来源里第一条能用的内容' },
          status: { type: 'string', enum: statusIds.filter(s => s !== 'done'), description: '默认 in_review' },
          note: { type: 'string' }
        },
        required: ['ids', 'title'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, merged: { type: 'array' } },
          required: ['id']
        },
        render: (_args, value) => text(`已合并 ${value.merged.length} 条 → ${value.id}`)
      },
      execute: wrap(async args => {
        const result = store.merge(args.ids, {
          title: args.title,
          kind: args.kind,
          scope: args.scope,
          body: args.body,
          status: args.status || 'in_review'
        }, { by: 'ai', note: args.note || 'AI 合并' });
        return { id: result.created.id, merged: result.sources };
      })
    },
    {
      name: 'board_rollback',
      description: '把条目回滚到之前的某个修订。历史不销毁，回滚本身也记一条修订。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id' },
          rev: { type: 'number', description: '要回到的修订号' },
          note: { type: 'string', description: '回滚理由，会写进修订历史' }
        },
        required: ['id', 'rev'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, rev: { type: 'number' } },
          required: ['id', 'rev']
        },
        render: (_args, value) => text(`已回滚 ${value.id} → r${value.rev}`)
      },
      execute: wrap(async args => {
        const result = store.rollback(args.id, args.rev, {
          by: 'ai',
          note: args.note || `AI 回滚到 r${args.rev}`
        });
        return { id: result.item.id, rev: result.item.rev };
      })
    },
    {
      name: 'board_delete',
      description: '物理删除一条「本身搞错了」的条目（写错、重复）。所有修订会从文件里删掉，不能回滚。只是不用了，请不要删：改状态或用 board_supersede 取代。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的条目 id' }
        },
        required: ['id'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            removed: { type: 'number' },
            repaired: { type: 'array', items: { type: 'string' } }
          },
          required: ['id', 'removed', 'repaired']
        },
        render: (_args, value) => text(`已物理删除 ${value.id}（${value.removed} 条修订）`)
      },
      execute: wrap(async args => {
        const result = store.remove(args.id, { by: 'ai' });
        return { id: result.id, removed: result.removed, repaired: result.repaired };
      })
    },
    {
      name: 'board_search',
      description: '检索看板条目：按关键词、状态、类型、范围过滤，返回紧凑列表。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，匹配标题/正文/范围/id' },
          status: { type: 'string', enum: statusIds },
          kind: { type: 'string', enum: kindIds },
          scope: { type: 'string' },
          limit: { type: 'number', description: '最多返回条数，默认 20，上限 200' }
        },
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'number' }, truncated: { type: 'boolean' },
            items: { type: 'array', items: { type: 'object' } }
          },
          required: ['total', 'items']
        },
        render: (_args, value) => text(value.items.length === 0
          ? '没有匹配的条目'
          : value.items.map(i => `- ${i.id} ${i.title}（${i.status}${i.scope ? ' · ' + i.scope : ''}）`).join('\n'))
      },
      execute: wrap(async args => {
        const result = store.list({
          query: args.query,
          status: args.status,
          kind: args.kind,
          scope: args.scope,
          limit: Math.min(Math.max(args.limit || 20, 1), 200)
        });
        return {
          total: result.total,
          truncated: result.truncated,
          items: result.items.map(publicItem)
        };
      })
    }
  ];
}

function publicItem(item) {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    scope: item.scope,
    body: item.body,
    verified: item.verified,
    archived: item.archived,
    rev: item.rev,
    updatedAt: item.updatedAt,
    supersededBy: item.supersededBy,
    mergedInto: item.mergedInto
  };
}
