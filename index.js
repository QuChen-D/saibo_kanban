/**
 * saibo-kanban — AI 与人共用的活看板。
 *
 * 八个工具 + 一个页面（收件箱 / 看板 / 表格）+ 对话里的「kanban」弹窗。
 * 数据落在 $DSH_HOME/saibo_kanban/records.jsonl；页面通过 /saibo-kanban/api 读写。
 * 弹窗里展示本轮相关条目和 AI 本轮的看板改动（改动可回滚），不往用户消息里写任何东西。
 */
import { Store, defaultDataDir } from './store.js';
import { createTools } from './tools.js';
import { normalizeKinds, BoardError, STATUSES, condenseBody } from './core.js';
import { readXlsxBuffer } from './lib/xlsx.js';
import { buildImport, describeImport } from './lib/import-map.js';
import {
  buildIndex, searchIndex, hitView, buildInjectText, estimateTokens, displayTerms
} from './lib/recall.js';
import { appendRecall, recallStats } from './lib/recall-log.js';

export const inject = ['tools', 'webServer'];

const STATUS_LABEL = new Map(STATUSES.map(s => [s.id, s.label]));

/** 检索索引按 store 缓存；看板事件数变了才重建。 */
const recallCache = new WeakMap();

function recallIndexFor(store) {
  const cached = recallCache.get(store);
  const rev = String(store.events);
  if (cached && cached.rev === rev) return cached.index;
  const index = buildIndex(store.items);
  recallCache.set(store, { rev, index });
  return index;
}

const BOARD_WORK_HINT = [
  '看板是你的长期记忆，也是给用户看的。每轮收尾前自检一次：这轮有没有产生新结论、新决策、新踩坑，或某条状态变了？有就自己写进看板，不用等用户开口；没有就不写，别为凑数建条目。',
  '写之前先 board_search 查一次重：已有对应条目就 board_update（带上修订号），没有才 board_record；同一件事不要每轮重复记。',
  '用户提到某件具体任务（做完了、改主意、问进度）时，先用 board_search 找一次定位，再决定是否 board_update；不要每轮遍历看板。',
  '正文就是摘要：一句话，单行、80 字以内，且必须比标题多说一点——标题说“是什么”，正文说“具体怎么做的/关键结论”。只重复标题、或只是“已完成/已清理”这类空话，就留空。依据、过程、长清单写 note 或留在会话里，超长会被拒。',
  '改动只在确有依据时做，note 写清依据；看板改动会由页面在 kanban 弹窗里列给用户回看和回滚，不要往消息里贴改动清单。'
].join('\n');

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  const dataDir = typeof settings.dataDir === 'string' && settings.dataDir.trim()
    ? settings.dataDir
    : defaultDataDir();
  const kinds = normalizeKinds(settings.kinds);
  const store = new Store({ dataDir, kinds }).load();
  const turnState = new Map();
  const tools = createTools(store, {
    kinds,
    maxBriefChars: Number.isFinite(settings.maxBriefChars) ? settings.maxBriefChars : 4000
  });

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `saibo-kanban: ${tool.name}`);
  }

  {
    const prompt = ctx.get('systemPrompt');
    if (prompt) {
      ctx.effect(() => prompt.section({
        name: 'saibo-kanban:work',
        order: 641,
        text: BOARD_WORK_HINT
      }), 'saibo-kanban: 看板协作约定');
    }
  }

  // 每轮开始时记录起点，轮末算出这轮改了哪些条目。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try { trackTurn(store, turnState, session, event); } catch { /* 不影响对话 */ }
  }), 'saibo-kanban: 轮次跟踪');

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
        const result = dispatch(ctx, store, settings, turnState, payload.method, payload.args || {});
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

function dispatch(ctx, store, settings, turnState, method, args) {
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
    case 'recall': {
      return recallTurn(ctx, store, args, settings);
    }
    case 'recall.stats': {
      return recallStats(store.dataDir, Number.isFinite(args.days) ? args.days : 1);
    }
    case 'turn.changes': {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      const state = turnState.get(sessionId);
      if (!state || !Array.isArray(state.changes) || state.changes.length === 0) return { changes: [] };
      if (args.messageId && state.lastAssistantId && args.messageId !== state.lastAssistantId) {
        return { changes: [] };
      }
      return { messageId: state.lastAssistantId, changes: state.changes };
    }
    default:
      throw new Error(`未知方法: ${method}`);
  }
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
  const injectLimit = Number.isFinite(settings.recallInjectLimit) ? settings.recallInjectLimit : 4;
  const ranked = searchIndex(recallIndexFor(store), store.items, parts, { limit: previewLimit, threshold });
  const views = ranked.map(hit => hitView(hit, store));
  const injectText = buildInjectText(views, { limit: injectLimit });
  const injectTokens = estimateTokens(injectText);
  const terms = displayTerms(ranked, 6);
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

/** 记录每轮起点、最后一条助手消息，轮末算改动。 */
function trackTurn(store, turnState, session, event) {
  if (!session || !event) return;
  const sessionId = session.id;
  if (event.type === 'user/message') {
    turnState.set(sessionId, { startTime: Date.now(), lastAssistantId: '', changes: [] });
    return;
  }
  if (event.type === 'assistant/message') {
    const state = turnState.get(sessionId) || { startTime: Date.now(), lastAssistantId: '', changes: [] };
    const message = event.data && event.data.message;
    state.lastAssistantId = message && message.id ? message.id : state.lastAssistantId;
    turnState.set(sessionId, state);
    return;
  }
  if (event.type === 'turn/end') {
    const state = turnState.get(sessionId) || { startTime: Date.now(), lastAssistantId: '', changes: [] };
    state.changes = collectChanges(store, state.startTime);
    state.endedAt = Date.now();
    turnState.set(sessionId, state);
    if (turnState.size > 60) {
      const oldest = turnState.keys().next().value;
      if (oldest !== sessionId) turnState.delete(oldest);
    }
  }
}

/** 找出这轮（起点之后）改过的条目，附上上一版状态供回滚。 */
export function collectChanges(store, since) {
  const out = [];
  for (const [id, item] of store.items) {
    const meta = store.meta.get(id);
    const time = meta ? Date.parse(meta.time) : NaN;
    if (!Number.isFinite(time) || time < since) continue;
    const created = Date.parse(item.createdAt) >= since;
    let previousRev = null;
    let from = null;
    if (!created) {
      previousRev = item.rev - 1;
      try {
        const prev = previousRev > 0 ? store.revision(id, previousRev) : null;
        if (prev) {
          from = {
            status: prev.status,
            title: prev.title,
            body: String(prev.body || '').slice(0, 200)
          };
        }
      } catch { /* 忽略回读失败 */ }
    }
    out.push({
      id,
      title: item.title,
      kind: item.kind,
      scope: item.scope,
      body: String(item.body || '').slice(0, 400),
      status: item.status,
      statusLabel: STATUS_LABEL.get(item.status) || item.status,
      rev: item.rev,
      previousRev,
      created,
      from,
      note: meta ? meta.note : '',
      time: meta ? meta.time : ''
    });
  }
  out.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return out;
}

/**
 * 从 from 往前找第一条有文字的助手消息。
 * 工具调用步骤没有文字，点它的「＋ 看板」时落到前面最近的答复上。
 */function pickTextMessage(messages, from) {
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
      title: item.title, kind: item.kind, scope: item.scope, body: condenseBody(item.body), status: item.status
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
