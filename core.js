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
export const EDITABLE_FIELDS = ['title', 'kind', 'status', 'scope', 'body', 'at'];

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
 * 业务时间：只有日期（YYYY-MM-DD），可留空——留空表示跟随条目的更新时间。
 * 它是给人看的排序依据（这件事发生在哪天），不替代 createdAt / updatedAt。
 */
export function normalizeAt(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim().slice(0, 10);
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BoardError('INVALID_AT', '时间要写成 YYYY-MM-DD，或者留空');
  }
  const time = Date.parse(text + 'T00:00:00Z');
  if (!Number.isFinite(time)) throw new BoardError('INVALID_AT', `不是有效日期：${text}`);
  return text;
}

/** 只做一道防滥用闸门，不是写作标准：看板是决策记忆，不是文档仓库。 */
export const BODY_MAX = 2000;

/** 统一换行、去行尾空格、压缩连续空行。内容本身一字不改。 */
export function normalizeBodyText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 正文校验：只做格式清理，不限制长度、不要求单行。
 * 写得好不好靠写作规范（结论先行 + 为什么 + 以后），不靠字数。
 */
export function assertBody(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new BoardError('INVALID_BODY', '正文必须是字符串');
  }
  const text = normalizeBodyText(value);
  if (text.length > BODY_MAX) {
    throw new BoardError('BODY_TOO_LONG',
      `正文 ${text.length} 字，超过 ${BODY_MAX} 字上限。看板存结论和依据，不存整篇文档；细节写文档或留在会话里。`);
  }
  return text;
}

/**
 * 把任意文本压成可读正文：去掉元数据行和列表标记，保留换行与全部内容。
 * 导入、合并这类“拿到原文但没有作者意图”的场景用它兜底。
 */
export function condenseBody(value) {
  const lines = normalizeBodyText(value)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^(编号|类型|优先级|滚动次数|首次来源|最近来源|来源|依据|参考|状态|标签|范围|序号)[：:]/.test(line))
    .map(line => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  const text = lines.join('\n');
  return text.length > BODY_MAX ? text.slice(0, BODY_MAX) : text;
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

  const byStatus = new Map(STATUSES.map(s => [s.id, []]));
  for (const item of active) {
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
