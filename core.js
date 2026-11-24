/**
 * core.js — 纯领域逻辑，零宿主依赖。
 *
 * 这里只做三件事：校验、状态机、简报。不碰文件、不碰 DSH。
 * store.js 负责持久化，tools.js 负责模型接口，页面负责渲染；三者共用这一份规则。
 */

export const DEFAULT_KINDS = [
  { id: 'task', label: '任务' },
  { id: 'decision', label: '决策' },
  { id: 'pitfall', label: '踩坑' },
  { id: 'design', label: '设计' }
];

export const STATUSES = [
  { id: 'backlog', label: '待规划' },
  { id: 'todo', label: '待办' },
  { id: 'in_progress', label: '进行中' },
  { id: 'in_review', label: '待验收' },
  { id: 'done', label: '已完成' },
  { id: 'blocked', label: '受阻' }
];

const STATUS_IDS = new Set(STATUSES.map(s => s.id));

/** 允许的状态流转。done 只允许人写；AI 在 tools 层被额外拦住。 */
export const TRANSITIONS = {
  backlog: ['todo', 'in_progress', 'blocked'],
  todo: ['backlog', 'in_progress', 'blocked'],
  in_progress: ['todo', 'in_review', 'blocked'],
  in_review: ['in_progress', 'blocked', 'done'],
  done: ['in_progress'],
  blocked: ['backlog', 'todo', 'in_progress']
};

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
  }
}

/** 可在修订里被改的字段。id / rev / createdAt / 来源 / verified 都不在此列。 */
export const EDITABLE_FIELDS = ['title', 'kind', 'status', 'scope', 'body'];

export function normalizeKinds(input) {
  if (!Array.isArray(input) || input.length === 0) return DEFAULT_KINDS.map(k => ({ ...k }));
  const seen = new Set();
  const kinds = [];
  for (const raw of input) {
    const id = typeof raw === 'string' ? raw : raw && raw.id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const key = id.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    kinds.push({ id: key, label: (raw && raw.label) || key });
  }
  return kinds.length > 0 ? kinds : DEFAULT_KINDS.map(k => ({ ...k }));
}

export function assertKind(kind, kinds) {
  if (typeof kind !== 'string' || !kinds.some(k => k.id === kind)) {
    throw new BoardError('INVALID_KIND', `未知类型 "${kind}"，可用：${kinds.map(k => k.id).join(' / ')}`);
  }
}

export function assertStatus(status) {
  if (!STATUS_IDS.has(status)) {
    throw new BoardError('INVALID_STATUS', `未知状态 "${status}"，可用：${[...STATUS_IDS].join(' / ')}`);
  }
}

export function assertTitle(title) {
  if (typeof title !== 'string' || !title.trim()) {
    throw new BoardError('INVALID_TITLE', '标题不能为空');
  }
  if (title.length > 200) {
    throw new BoardError('INVALID_TITLE', '标题最长 200 字');
  }
  return title.trim();
}

/**
 * 校验状态值。任意状态之间可以互转（回滚兜底），只拒绝未知状态。
 */
export function assertTransition(from, to) {
  if (from === to) return;
  assertStatus(to);
}

export function nextId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `b-${t}${r}`;
}

/** 生成字段级 diff：{ field: { from, to } }，未变化的字段不出现。 */
export function diffFields(item, patch, fields = EDITABLE_FIELDS) {
  const changes = {};
  for (const field of fields) {
    if (!(field in patch)) continue;
    const from = item[field] ?? '';
    const to = patch[field] ?? '';
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export function isDraft(item) {
  return !item.verified;
}

/** 简报：列出全部未归档条目；回滚兜底，不再区分确认状态。 */
export function buildBrief(items, options = {}) {
  const maxChars = options.maxChars ?? 4000;
  const active = items.filter(i => !i.archived);
  const pool = active;

  const byStatus = new Map(STATUSES.map(s => [s.id, []]));
  for (const item of pool) {
    if (byStatus.has(item.status)) byStatus.get(item.status).push(item);
  }

  const lines = [];
  lines.push('## 看板简报');
  const counts = STATUSES
    .map(s => `${s.label} ${byStatus.get(s.id).length}`)
    .join(' · ');
  lines.push(`- 统计：${counts}`);

  const order = ['blocked', 'in_review', 'in_progress', 'todo', 'backlog', 'done'];
  for (const status of order) {
    const list = byStatus.get(status) || [];
    if (list.length === 0) continue;
    lines.push('');
    lines.push(`### ${STATUSES.find(s => s.id === status).label}（${list.length}）`);
    for (const item of list) {
      const meta = [item.kind, item.scope].filter(Boolean).join(' · ');
      lines.push(`- \`${item.id}\` ${item.title}${meta ? `（${meta}）` : ''}`);
    }
  }

  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 20) + '\n…（简报已截断）';
}

/** 关键词匹配：标题、正文、范围、id。 */
export function matchesQuery(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [item.id, item.title, item.body, item.scope]
    .some(v => typeof v === 'string' && v.toLowerCase().includes(q));
}

/* ------------------------------------------------------------------ *
 * 对话 → 看板
 *
 * 约定：AI 在回复末尾放一个 board 代码块，一行一条，字段顺序固定：
 *   状态｜类型｜范围｜标题
 * 用户点「＋ 看板」时，宿主解析这条消息，按 AI 给的状态直接写入。
 * 没有代码块时退化为「首行做标题、待办、任务」。
 * ------------------------------------------------------------------ */

const STATUS_ALIASES = new Map();
for (const s of STATUSES) {
  STATUS_ALIASES.set(s.id, s.id);
  STATUS_ALIASES.set(s.label, s.id);
}
STATUS_ALIASES.set('完成', 'done');
STATUS_ALIASES.set('已做', 'done');
STATUS_ALIASES.set('待处理', 'todo');
STATUS_ALIASES.set('未开始', 'backlog');

const KIND_ALIASES = new Map();
for (const k of DEFAULT_KINDS) {
  KIND_ALIASES.set(k.id, k.id);
  KIND_ALIASES.set(k.label, k.id);
}
KIND_ALIASES.set('问题', 'pitfall');
KIND_ALIASES.set('bug', 'pitfall');
KIND_ALIASES.set('决定', 'decision');
KIND_ALIASES.set('方案', 'design');

const BOARD_FENCE = /```(?:board|kanban|看板)[^\n]*\r?\n([\s\S]*?)```/g;

function cleanToken(value) {
  return String(value || '')
    .replace(/^\s*[-*·•]\s*/, '')
    .replace(/^[\s`*_]+/, '')
    .replace(/[\s`*_]+$/, '')
    .trim();
}

/** 解析消息里的 board 代码块；返回 { entries, warnings }。 */
export function parseBoardCapture(text) {
  const entries = [];
  const warnings = [];
  if (typeof text !== 'string' || !text) return { entries, warnings };
  BOARD_FENCE.lastIndex = 0;
  let match;
  while ((match = BOARD_FENCE.exec(text))) {
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = cleanToken(rawLine);
      if (!line) continue;
      const parts = line.split(/[｜|]/).map(cleanToken);
      if (parts.length < 4) {
        warnings.push(`看不懂这一行：${line.slice(0, 40)}`);
        continue;
      }
      const status = STATUS_ALIASES.get(parts[0].toLowerCase()) || STATUS_ALIASES.get(parts[0]);
      const kind = KIND_ALIASES.get(parts[1].toLowerCase()) || KIND_ALIASES.get(parts[1]);
      if (!status) {
        warnings.push(`未知状态「${parts[0]}」，已跳过`);
        continue;
      }
      if (!kind) {
        warnings.push(`未知类型「${parts[1]}」，已跳过`);
        continue;
      }
      const scope = parts[2].slice(0, 60);
      const title = parts[3].trim().slice(0, 200);
      const summary = parts.slice(4).join('｜').trim().slice(0, 160);
      if (!title) {
        warnings.push('标题为空，已跳过');
        continue;
      }
      entries.push({ title, kind, status, scope, summary });
    }
  }
  return { entries, warnings };
}

/** 去掉 board 代码块，剩下的才是正文。 */
export function stripBoardCapture(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(BOARD_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fallbackTitle(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^```/.test(line.trim())) continue;
    const s = cleanToken(line)
      .replace(/^#{1,6}\s*/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim();
    if (!s || /^[-=]{3,}$/.test(s)) continue;
    const first = s.split(/[。；;！!？?]/)[0].trim();
    const title = first || s;
    return title.length > 80 ? title.slice(0, 80) : title;
  }
  return '';
}

/** 无说明时的兜底正文：第一段，最多 300 字。 */
function firstParagraph(text) {
  const body = stripBoardCapture(text);
  for (const block of body.split(/\n{2,}/)) {
    const s = block.trim();
    if (!s) continue;
    return s.length > 300 ? s.slice(0, 300) : s;
  }
  return '';
}

/**
 * 把一条消息变成待写入条目：{ body, items, warnings, hasMarkers, sourceText }。
 * 每条条目取自己的「说明」当正文；没有说明就退化为第一段。
 */
export function buildCapture(text, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const parsed = parseBoardCapture(source);
  const fallback = firstParagraph(source);
  const scope = typeof options.scope === 'string' ? options.scope : '';
  const items = parsed.entries.map(entry => ({
    ...entry,
    scope: entry.scope || scope,
    summary: entry.summary || fallback
  }));
  if (items.length === 0) {
    const title = fallbackTitle(source);
    if (!title) throw new BoardError('EMPTY_MESSAGE', '这条消息没有可加入看板的内容');
    items.push({
      title,
      kind: 'task',
      status: options.status || 'todo',
      scope,
      summary: fallback
    });
  }
  return {
    body: fallback,
    items,
    warnings: parsed.warnings,
    hasMarkers: parsed.entries.length > 0,
    sourceText: stripBoardCapture(source)
  };
}
