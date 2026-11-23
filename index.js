/**
 * saibo-kanban — AI 与人共用的活看板。
 *
 * 0.3.0：六个工具 + 一个页面（收件箱 / 看板 / 表格）。
 * 数据落在 $DSH_HOME/saibo_kanban/records.jsonl；页面通过 /saibo-kanban/api 读写。
 * 权限对等：人通过 UI、AI 通过工具，都走同一份 store 与规则；回滚兜底。
 */
import { Store, defaultDataDir } from './store.js';
import { createTools } from './tools.js';
import { normalizeKinds } from './core.js';
import { readXlsxBuffer } from './lib/xlsx.js';
import { buildImport, describeImport } from './lib/import-map.js';

export const inject = ['tools', 'webServer'];

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  const dataDir = typeof settings.dataDir === 'string' && settings.dataDir.trim()
    ? settings.dataDir
    : defaultDataDir();
  const kinds = normalizeKinds(settings.kinds);
  const store = new Store({ dataDir, kinds }).load();
  const tools = createTools(store, {
    kinds,
    maxBriefChars: Number.isFinite(settings.maxBriefChars) ? settings.maxBriefChars : 4000
  });

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `saibo-kanban: ${tool.name}`);
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/saibo-kanban/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
        return;
      }
      try {
        const payload = await readJsonBody(req);
        const result = dispatch(store, payload.method, payload.args || {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: error && error.message ? error.message : 'unknown error',
          code: error && error.code ? error.code : undefined
        }));
      }
    }
  }), 'saibo-kanban: /saibo-kanban/api');
}

function dispatch(store, method, args) {
  switch (method) {
    case 'list': {
      const result = store.list({ includeArchived: args.includeArchived === true, limit: 2000 });
      return { items: result.items.map(publicItem), total: result.total };
    }
    case 'get': {
      const item = store.get(args.id);
      return { item: publicItem(item), history: store.history(args.id) };
    }
    case 'create': {
      const item = store.record({
        title: args.title,
        kind: args.kind || 'task',
        scope: args.scope || '',
        body: args.body || '',
        status: args.status || 'backlog'
      }, { by: 'human', note: '页面新建' });
      return { item: publicItem(item) };
    }
    case 'update': {
      const result = store.update(args.id, args.patch || {}, {
        by: 'human',
        expectedRev: args.expectedRev,
        note: args.note || '页面修改'
      });
      return { item: publicItem(result.item), changed: result.changed, changes: result.changes };
    }
    case 'archive': {
      const result = store.archive(args.id, { by: 'human', note: '页面归档' });
      return { item: publicItem(result.item) };
    }
    case 'restore': {
      const result = store.restore(args.id, { by: 'human', note: '页面恢复' });
      return { item: publicItem(result.item) };
    }
    case 'rollback': {
      const result = store.rollback(args.id, args.rev, { by: 'human', note: args.note || `回滚到 r${args.rev}` });
      return { item: publicItem(result.item) };
    }
    case 'brief': {
      return { markdown: store.brief({}) };
    }
    case 'import.preview': {
      const plan = buildImport(readXlsxBuffer(decodeData(args.data)));
      return { summary: describeImport(plan) };
    }
    case 'import.apply': {
      const plan = buildImport(readXlsxBuffer(decodeData(args.data)));
      return applyPlan(store, plan);
    }
    default:
      throw new Error(`未知方法: ${method}`);
  }
}

function publicItem(item) {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    scope: item.scope,
    body: item.body,
    archived: item.archived,
    rev: item.rev,
    updatedAt: item.updatedAt,
    supersededBy: item.supersededBy,
    mergedInto: item.mergedInto
  };
}

function decodeData(data) {
  if (typeof data !== 'string' || data.length < 16) throw new Error('没有收到文件内容');
  return Buffer.from(data, 'base64');
}

function applyPlan(store, plan) {
  const existing = new Set([...store.items.values()].map(i => `${i.scope}|${i.title}`));
  let imported = 0;
  let skipped = 0;
  const write = (item, note) => {
    if (existing.has(`${item.scope}|${item.title}`)) { skipped += 1; return; }
    const created = store.record({
      title: item.title, kind: item.kind, scope: item.scope, body: item.body, status: item.status
    }, { by: 'human', note });
    if (item.archived) store.archive(created.id, { by: 'human', note: '导入历史台账' });
    existing.add(`${item.scope}|${item.title}`);
    imported += 1;
  };
  for (const item of plan.main) write(item, '导入：任务主表');
  for (const item of plan.rolling) write(item, '导入：长期滚动项');
  if (plan.notes && args.includeNotes === true) write(plan.notes, '导入：节点说明');
  return { imported, skipped, summary: describeImport(plan) };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}
