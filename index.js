/**
 * saibo-kanban — AI 与人共用的活看板。
 *
 * 八个工具 + 一个页面（收件箱 / 看板 / 表格）+ 对话动作（加入看板 / 相关看板）。
 * 数据落在 $DSH_HOME/saibo_kanban/records.jsonl；页面通过 /saibo-kanban/api 读写。
 * 召回只读，单独记在 recall.jsonl，不注入对话（0 token）。
 */
import { Store, defaultDataDir } from './store.js';
import { createTools } from './tools.js';
import { normalizeKinds, buildCapture, BoardError } from './core.js';
import { readXlsxBuffer } from './lib/xlsx.js';
import { buildImport, describeImport } from './lib/import-map.js';
import {
  buildIndex, searchIndex, hitView, buildInjectText, estimateTokens, queryTerms
} from './lib/recall.js';
import { appendRecall, recallStats } from './lib/recall-log.js';

export const inject = ['tools', 'webServer'];

/** 检索索引按 store 缓存；看板事件数变了才重建。 */
const recallCache = new WeakMap();

function recallIndexFor(store) {
  const cached = recallCache.get(store);
  if (cached && cached.rev === store.events) return cached.index;
  const index = buildIndex(store.items);
  recallCache.set(store, { rev: store.events, index });
  return index;
}

const CAPTURE_HINT = [
  '看板（saibo-kanban）是这台机器上所有会话共用的活看板：人可以点开页面改、回滚。',
  '当这轮对话确实产出了值得留下的结果（做完的事、定下的决策、踩到的坑、成型的设计），在回复末尾加一个 board 代码块，一行一条，最多 3 条：',
  '',
  '```board',
  '已完成｜任务｜G5 前端｜修好打印图标',
  '```',
  '',
  '字段顺序固定：状态｜类型｜范围｜标题。状态用 待规划/待办/进行中/待验收/已完成/受阻；类型用 任务/决策/踩坑/设计；范围沿用看板里已有的分组名，不确定就留空（写成 进行中｜任务｜｜标题）。',
  '没有值得落板的结果就不要写这个块；也不要主动调用 board_record，除非用户明确要求直接写入。'
].join('\n');

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

  if (settings.captureHint !== false) {
    const prompt = ctx.get('systemPrompt');
    if (prompt) {
      ctx.effect(() => prompt.section({
        name: 'saibo-kanban:capture',
        order: 640,
        text: CAPTURE_HINT
      }), 'saibo-kanban: 看板写入约定');
    }
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
        const result = dispatch(ctx, store, settings, payload.method, payload.args || {});
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

function dispatch(ctx, store, settings, method, args) {
  switch (method) {
    case 'list': {
      const result = store.list({ limit: 2000 });
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
    case 'rollback': {
      const result = store.rollback(args.id, args.rev, { by: 'human', note: args.note || `回滚到 r${args.rev}` });
      return { item: publicItem(result.item) };
    }
    case 'delete': {
      const result = store.remove(args.id, { by: 'human' });
      return { id: result.id, title: result.title, removed: result.removed, repaired: result.repaired };
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
      return applyPlan(store, plan, args.includeNotes === true);
    }
    case 'capture': {
      return capture(ctx, store, args);
    }
    case 'recall': {
      return recallTurn(ctx, store, args, settings);
    }
    case 'recall.stats': {
      return recallStats(store.dataDir, Number.isFinite(args.days) ? args.days : 1);
    }
    default:
      throw new Error(`未知方法: ${method}`);
  }
}

/**
 * 对话 → 看板：读这条消息，按其中 board 代码块（或首行）写入。
 * args: { sessionId, messageId?, scope?, text?, dryRun? }
 * messageId 省略时取该会话最后一条助手消息（便于脚本和自测）。
 */
function capture(ctx, store, args) {
  const source = resolveMessage(ctx, args);
  const plan = buildCapture(source.text, { scope: args.scope });
  if (args.dryRun === true) {
    return {
      dryRun: true,
      message: source.message,
      body: plan.body,
      items: plan.items,
      warnings: plan.warnings,
      hasMarkers: plan.hasMarkers
    };
  }
  const applied = applyCapture(store, plan, source.ref);
  return { ...applied, warnings: plan.warnings, hasMarkers: plan.hasMarkers };
}

/** 把解析结果落库：新建；同范围同标题则更新状态；状态相同才算已存在。 */
export function applyCapture(store, plan, source) {
  const created = [];
  const updated = [];
  const existing = [];
  for (const item of plan.items) {
    const dup = findSameItem(store, item);
    if (dup) {
      if (dup.status !== item.status) {
        const result = store.update(dup.id, { status: item.status }, {
          by: 'human',
          expectedRev: dup.rev,
          note: '从对话更新状态'
        });
        updated.push(publicItem(result.item));
      } else {
        existing.push(publicItem(dup));
      }
      continue;
    }
    const saved = store.record({
      title: item.title,
      kind: item.kind,
      status: item.status,
      scope: item.scope,
      body: plan.body,
      source
    }, { by: 'human', note: '从对话加入看板' });
    created.push(publicItem(saved));
  }
  return { created, updated, existing };
}

/** 活会话的消息列表。 */
function sessionMessages(ctx, sessionId) {
  if (!sessionId) throw new BoardError('NO_SESSION', '缺少会话 id，读不到消息');
  const sessions = ctx.get('sessions');
  if (!sessions) throw new BoardError('NO_SESSIONS', '运行时没有会话服务');
  const session = sessions.get(sessionId);
  if (!session) throw new BoardError('NO_SESSION', '这个会话不在内存里了，请刷新页面再试');
  try {
    return session.deriveMessages();
  } catch (error) {
    throw new BoardError('NO_MESSAGES', '读取会话消息失败');
  }
}

/** 从活会话里取出一条消息的纯文本。 */
function resolveMessage(ctx, args) {
  if (typeof args.text === 'string' && args.text.trim()) {
    return { text: args.text, ref: null, message: null };
  }
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
  const messages = sessionMessages(ctx, sessionId);
  const index = typeof args.messageId === 'string' && args.messageId
    ? messages.findIndex(m => m && m.id === args.messageId)
    : messages.length - 1;
  if (index < 0) throw new BoardError('NO_MESSAGE', '找不到这条消息');
  const picked = pickTextMessage(messages, index);
  if (!picked) throw new BoardError('EMPTY_MESSAGE', '这条消息没有可加入看板的内容');
  return {
    text: picked.text,
    ref: { type: 'session', ref: `${sessionId}#${picked.message.id}` },
    message: { id: picked.message.id, role: picked.message.role }
  };
}

/** 取这一轮的用户消息 + 助手消息，供召回当查询。 */
function resolveTurn(ctx, args) {
  if (typeof args.text === 'string' && args.text.trim()) {
    return { user: args.text, prevUser: '', assistant: '', messageId: '' };
  }
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
  const messages = sessionMessages(ctx, sessionId);
  const start = typeof args.messageId === 'string' && args.messageId
    ? messages.findIndex(m => m && m.id === args.messageId)
    : messages.length - 1;
  if (start < 0) throw new BoardError('NO_MESSAGE', '找不到这条消息');
  const picked = pickTextMessage(messages, start);
  const anchorIndex = picked ? messages.indexOf(picked.message) : start;
  let user = '';
  let prevUser = '';
  let userIndex = -1;
  for (let i = anchorIndex; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const text = messageText(message);
    if (!text) continue;
    user = text;
    userIndex = i;
    break;
  }
  for (let i = userIndex - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const text = messageText(message);
    if (!text) continue;
    prevUser = text;
    break;
  }
  return {
    user,
    prevUser,
    assistant: picked ? picked.text : '',
    messageId: picked ? picked.message.id : ''
  };
}

/** 只读召回：算一遍相关条目并记账，不注入模型。 */
function recallTurn(ctx, store, args, settings) {
  const turn = resolveTurn(ctx, args);
  const parts = [];
  if (turn.user) parts.push({ text: turn.user, weight: 1 });
  if (turn.prevUser && turn.user.length < 8) parts.push({ text: turn.prevUser, weight: 0.7 });
  if (turn.assistant) parts.push({ text: turn.assistant.slice(0, 1500), weight: 0.4 });

  const threshold = Number.isFinite(settings.recallThreshold) ? settings.recallThreshold : 3;
  const previewLimit = Number.isFinite(settings.recallPreviewLimit) ? settings.recallPreviewLimit : 5;
  const injectLimit = Number.isFinite(settings.recallInjectLimit) ? settings.recallInjectLimit : 3;
  const ranked = searchIndex(recallIndexFor(store), store.items, parts, { limit: previewLimit, threshold });
  const views = ranked.map(hit => hitView(hit, store));
  const injectText = buildInjectText(views, { limit: injectLimit });
  const injectTokens = estimateTokens(injectText);
  const terms = [...queryTerms(parts.map(part => part.text).join('\n')).keys()].slice(0, 12);
  const hitRows = views.filter(view => view.reason !== '低分' && view.reason !== '泛词').length;
  const recallId = `rc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  appendRecall(store.dataDir, {
    v: 1,
    recallId,
    time: new Date().toISOString(),
    sessionId: typeof args.sessionId === 'string' ? args.sessionId : '',
    messageId: turn.messageId || '',
    terms,
    hitRows,
    candidateRows: views.length,
    injectText,
    injectTokens,
    injected: false,
    actualTokens: 0
  });

  return {
    recallId,
    messageId: turn.messageId,
    query: { user: turn.user.slice(0, 120), terms },
    views,
    threshold,
    injectText,
    injectTokens,
    displayTokens: 0,
    stats: recallStats(store.dataDir, 1)
  };
}

/**
 * 从 from 往前找第一条有文字的助手消息。
 * 工具调用步骤没有文字，点它的「＋ 看板」时落到前面最近的答复上。
 */
function pickTextMessage(messages, from) {
  for (let i = from; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const text = messageText(message);
    if (text) return { message, text };
  }
  return null;
}

function messageText(message) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const texts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n\n').trim();
}

/** 同范围同标题的活跃条目视为已存在，不重复写。 */
function findSameItem(store, item) {
  const scope = item.scope || '';
  for (const current of store.items.values()) {
    if (current.archived || current.mergedInto || current.supersededBy) continue;
    if ((current.scope || '') === scope && current.title === item.title) return current;
  }
  return null;
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

function applyPlan(store, plan, includeNotes = false) {
  const existing = new Set([...store.items.values()].map(i => `${i.scope}|${i.title}`));
  let imported = 0;
  let skipped = 0;
  const write = (item, note) => {
    if (existing.has(`${item.scope}|${item.title}`)) { skipped += 1; return; }
    store.record({
      title: item.title, kind: item.kind, scope: item.scope, body: item.body, status: item.status
    }, { by: 'human', note });
    existing.add(`${item.scope}|${item.title}`);
    imported += 1;
  };
  for (const item of plan.main) write(item, '导入：任务主表');
  for (const item of plan.rolling) write(item, '导入：长期滚动项');
  if (plan.notes && includeNotes === true) write(plan.notes, '导入：节点说明');
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
