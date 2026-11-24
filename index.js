/**
 * saibo-kanban — AI 与人共用的活看板。
 *
 * 八个工具 + 一个页面（收件箱 / 看板 / 表格）+ 对话动作（加入看板 / 相关看板 / 本轮改动）。
 * 数据落在 $DSH_HOME/saibo_kanban/records.jsonl；页面通过 /saibo-kanban/api 读写。
 * 每轮把相关条目附在用户消息末尾（只进请求，不落历史），轮末记下改动供人回滚。
 */
import { Store, defaultDataDir } from './store.js';
import { createTools } from './tools.js';
import { normalizeKinds, buildCapture, BoardError, STATUSES } from './core.js';
import { readXlsxBuffer } from './lib/xlsx.js';
import { buildImport, describeImport } from './lib/import-map.js';
import {
  buildIndex, searchIndex, hitView, buildInjectText, estimateTokens, queryTerms
} from './lib/recall.js';
import { appendRecall, recallStats } from './lib/recall-log.js';
import { appendCaptured, loadCaptured } from './lib/capture-archive.js';

export const inject = ['tools', 'webServer'];

const STATUS_LABEL = new Map(STATUSES.map(s => [s.id, s.label]));

/** 检索索引按 store 缓存；看板事件数变了才重建。 */
const recallCache = new WeakMap();

function recallIndexFor(store) {
  const cached = recallCache.get(store);
  const rev = `${store.events}:${store.capturedRev || 0}`;
  if (cached && cached.rev === rev) return cached.index;
  const index = buildIndex(store.items, store.captured || new Map());
  recallCache.set(store, { rev, index });
  return index;
}

const CAPTURE_HINT = [
  '看板（saibo-kanban）是这台机器上所有会话共用的活看板：人可以点开页面改、回滚。',
  '当这轮对话确实产出了值得留下的结果（做完的事、定下的决策、踩到的坑、成型的设计），在回复末尾加一个 board 代码块，一行一条，最多 3 条：',
  '',
  '```board',
  '已完成｜任务｜G5 前端｜修好打印图标｜补了回归测试，弹窗不再串数据',
  '```',
  '',
  '字段顺序固定：状态｜类型｜范围｜标题｜说明。状态用 待规划/待办/进行中/待验收/已完成/受阻；类型用 任务/决策/踩坑/设计；范围沿用看板里已有的分组名，不确定就留空；说明写一句话结果或依据（60 字内），它会成为看板里的正文。',
  '没有值得落板的结果就不要写这个块；也不要主动调用 board_record，除非用户明确要求直接写入。'
].join('\n');

const BOARD_WORK_HINT = [
  '看板协作：这轮对话和看板条目相关时，用户消息末尾会附一段「看板·本轮到相关」（系统自动附加，不是用户说的话）。',
  '如果这轮工作让其中某条的状态、内容或补充说明发生了变化，直接用 board_update 改（带上列表里的 id 和 r 号），note 写清依据；改完在回复末尾用一行列出改动。',
  '没有变化就不要动；不要自己遍历看板，也不要为了确认去全量读取。'
].join('\n');

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  const dataDir = typeof settings.dataDir === 'string' && settings.dataDir.trim()
    ? settings.dataDir
    : defaultDataDir();
  const kinds = normalizeKinds(settings.kinds);
  const store = new Store({ dataDir, kinds }).load();
  store.captured = loadCaptured(dataDir);
  store.capturedRev = 0;
  const turnState = new Map();
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

  if (settings.recallInject !== false) {
    const injectedMessages = new Map();
    // 用户消息进入这一步前，把相关条目附在消息末尾（只在请求里，不写会话历史）。
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        if (!decision || decision.kind !== 'enter') return decision;
        const incoming = payload && Array.isArray(payload.messages)
          ? payload.messages[payload.messages.length - 1]
          : null;
        if (!incoming || incoming.role !== 'user') return decision;
        const sessionId = payload.agent ? payload.agent.id : '';
        if (sessionId && injectedMessages.get(sessionId) === incoming.id) return decision;
        const sessions = ctx.get('sessions');
        const session = sessions && sessionId ? sessions.get(sessionId) : undefined;
        const header = session && session.header;
        if (header && (header.origin === 'subagent' || (header.delegationDepth || 0) > 0)) return decision;
        const block = buildTurnBlock(store, payload, settings);
        if (!block) return decision;
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        const last = messages[messages.length - 1];
        if (!last || last.role !== 'user') return decision;
        const content = Array.isArray(last.content) ? last.content.slice() : [];
        content.push({ type: 'text', text: block });
        const clone = { ...last, content };
        if (sessionId) injectedMessages.set(sessionId, incoming.id);
        return { ...decision, messages: [...messages.slice(0, -1), clone] };
      } catch {
        return decision;
      }
    }), 'saibo-kanban: 相关条目注入');
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
    case 'capture': {
      return capture(ctx, store, args);
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
  const applied = applyCapture(store, plan, source.ref, {
    sourceLabel: source.ref ? `对话 · ${new Date().toISOString().slice(0, 10)}` : '',
    archive: (id, text) => {
      if (!text) return;
      try {
        appendCaptured(store.dataDir, id, text, {
          sessionId: typeof args.sessionId === 'string' ? args.sessionId : '',
          messageId: source.message ? source.message.id : ''
        });
      } catch { /* 原文索引失败不影响落板 */ }
      store.captured.set(id, text);
      store.capturedRev = (store.capturedRev || 0) + 1;
    }
  });
  return { ...applied, warnings: plan.warnings, hasMarkers: plan.hasMarkers };
}

/** 把解析结果落库：新建；同范围同标题则更新状态；状态相同才算已存在。 */
export function applyCapture(store, plan, source, options = {}) {
  const created = [];
  const updated = [];
  const existing = [];
  const sourceLabel = typeof options.sourceLabel === 'string' ? options.sourceLabel : '';
  const bodyFor = item => {
    const summary = String(item.summary || plan.body || '').trim();
    return sourceLabel ? `${summary}\n\n来源：${sourceLabel}` : summary;
  };
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
      body: bodyFor(item),
      source
    }, { by: 'human', note: '从对话加入看板' });
    if (typeof options.archive === 'function' && plan.sourceText) options.archive(saved.id, plan.sourceText);
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
  const injectLimit = Number.isFinite(settings.recallInjectLimit) ? settings.recallInjectLimit : 4;
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
 * 把相关条目附到这一轮用户消息末尾（只进请求，不写会话历史）。
 * 返回要附加的文本；没有相关条目就返回空串。
 */
export function buildTurnBlock(store, payload, settings) {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const last = messages[messages.length - 1];
  if (!last) return '';
  const text = messageText(last);
  if (!text || text.length < 4) return '';
  const limit = Number.isFinite(settings.recallInjectLimit) ? settings.recallInjectLimit : 4;
  const threshold = Number.isFinite(settings.recallThreshold) ? settings.recallThreshold : 3;
  let hits;
  try {
    hits = searchIndex(recallIndexFor(store), store.items, [{ text, weight: 1 }], { limit, threshold });
  } catch {
    return '';
  }
  if (!hits || hits.length === 0) return '';
  const lines = ['【看板·本轮到相关】（系统自动附加，不是用户的话）'];
  for (const hit of hits) {
    const item = hit.item;
    lines.push(`- ${item.title}｜${STATUS_LABEL.get(item.status) || item.status}｜r${item.rev}｜${item.scope || '未定'}`);
  }
  const block = lines.join('\n');
  try {
    const injectTokens = estimateTokens(block);
    appendRecall(store.dataDir, {
      v: 1,
      recallId: `rc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      time: new Date().toISOString(),
      sessionId: payload.agent ? payload.agent.id : '',
      messageId: last.id || '',
      terms: [],
      hitRows: hits.length,
      candidateRows: hits.length,
      injectText: block,
      injectTokens,
      injected: true,
      actualTokens: injectTokens
    });
  } catch { /* 记账失败不影响对话 */ }
  return block;
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
