/**
 * lib/recall.js — 对话 → 看板条目的本地召回（零模型调用，零 token）。
 *
 * 纯函数：给条目集合和查询文本，返回排序后的候选。索引只在看板变更后重建。
 * 标题与正文同权（内容同样重要）；范围只作展示，不参与打分。
 */
import { STATUSES, DEFAULT_KINDS } from '../core.js';

const META_LINE = /^(编号|类型|优先级|滚动次数|首次来源|最近来源)[：:]/;
const BODY_LIMIT = 2000;
const SOURCE_LIMIT = 4000;
const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 3;
const SOURCE_WEIGHT = 1.5;
const MIN_IDF = 0.8;

const STATUS_LABEL = new Map(STATUSES.map(s => [s.id, s.label]));
const KIND_LABEL = new Map(DEFAULT_KINDS.map(k => [k.id, k.label]));

const STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '什么', '怎么', '怎样', '如何',
  '可以', '就是', '不是', '还是', '如果', '然后', '因为', '所以', '但是', '一个', '没有',
  '现在', '已经', '需要', '应该', '可能', '看看', '一下', '历史', '东西', '问题', '时候',
  '地方', '知道', '觉得', '比较', '进行', '以及', '还有', '这样', '那样', '自己', '不能',
  '能不能', '是不是', '为什么', '有没有'
]);

const ALIASES = new Map(Object.entries({
  icon: ['图标'],
  图标: ['icon'],
  done: ['完成', '已完成'],
  完成: ['done'],
  已完成: ['done', '完成'],
  xlsx: ['excel'],
  excel: ['xlsx'],
  回滚: ['恢复', '撤销'],
  恢复: ['回滚'],
  撤销: ['回滚'],
  删除: ['移除', '删掉'],
  移除: ['删除'],
  删掉: ['删除'],
  修复: ['修好'],
  修好: ['修复'],
  子任务: ['拆分'],
  简报: ['摘要'],
  摘要: ['简报']
}));

/** 正文去掉元数据行，截断到固定长度。 */
export function bodyText(body) {
  return String(body || '')
    .split(/\r?\n/)
    .filter(line => !META_LINE.test(line.trim()))
    .join('\n')
    .slice(0, BODY_LIMIT);
}

/** 2–3 字中文片段 + 英文/数字词。 */
export function grams(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) out.push(run.slice(i, i + n));
    }
  }
  for (const w of s.match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]/g) || []) out.push(w);
  return out;
}

/** 查询词 → Map(term → 权重)；别名展开。 */
export function queryTerms(text) {
  const weights = new Map();
  for (const g of grams(text)) {
    if (STOPWORDS.has(g)) continue;
    weights.set(g, Math.max(weights.get(g) || 0, 1));
  }
  for (const term of [...weights.keys()]) {
    for (const alias of ALIASES.get(term) || []) {
      if (!weights.has(alias)) weights.set(alias, 0.6);
    }
  }
  return weights;
}

/** 建索引：term → Map(itemId → { t/b/s: 各字段词频 })。extras 是 id → 原文。 */
export function buildIndex(items, extras = new Map()) {
  const postings = new Map();
  const lens = new Map();
  const docs = [];
  for (const item of items.values ? items.values() : items) {
    if (!item || item.mergedInto) continue;
    docs.push(item);
    const title = grams(item.title);
    const body = grams(bodyText(item.body));
    const original = extras && extras.get ? String(extras.get(item.id) || '').slice(0, SOURCE_LIMIT) : '';
    const source = original ? grams(original) : [];
    lens.set(item.id, {
      t: title.length,
      b: body.length,
      s: source.length,
      size: title.length + body.length + source.length
    });
    const bump = (term, field) => {
      let post = postings.get(term);
      if (!post) { post = new Map(); postings.set(term, post); }
      let entry = post.get(item.id);
      if (!entry) { entry = { t: 0, b: 0, s: 0 }; post.set(item.id, entry); }
      entry[field] += 1;
    };
    for (const g of title) bump(g, 't');
    for (const g of body) bump(g, 'b');
    for (const g of source) bump(g, 's');
  }
  let bodyLenSum = 0;
  let sourceLenSum = 0;
  for (const len of lens.values()) {
    bodyLenSum += len.b;
    sourceLenSum += len.s;
  }
  const idf = new Map();
  const N = Math.max(docs.length, 1);
  for (const [term, post] of postings) {
    idf.set(term, Math.log(1 + (N - post.size + 0.5) / (post.size + 0.5)));
  }
  return {
    postings,
    idf,
    lens,
    size: docs.length,
    avgBodyLen: bodyLenSum / N,
    avgSourceLen: sourceLenSum / N
  };
}

function fieldScore(tf, norm) {
  if (!tf) return 0;
  return tf / (tf + norm);
}

/**
 * 检索。queries: [{ text, weight }]
 * 返回 [{ item, score, coverage, matched: [{ term, field, idf }], reason }]
 */
export function searchIndex(index, items, queries, options = {}) {
  const limit = Math.max(1, Math.min(options.limit || 20, 50));
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 3;
  const scores = new Map();
  const matched = new Map();
  const seen = new Map();
  const matchedWeight = new Map();
  let totalWeight = 0;

  for (const part of queries) {
    const weight = Number.isFinite(part.weight) ? part.weight : 1;
    if (!part.text) continue;
    for (const [term, qw] of queryTerms(part.text)) {
      const df = index.postings.get(term);
      if (!df) continue;
      const idf = index.idf.get(term) || 0;
      const qWeight = qw * weight;
      totalWeight += qWeight;
      if (idf < MIN_IDF) continue;
      const termWeight = idf * (term.length >= 3 ? 1.3 : 1) * qWeight;
      for (const [id, tf] of df) {
        const len = index.lens.get(id) || { t: 1, b: 1, s: 0 };
        const normB = 1.2 * (0.25 + 0.75 * (len.b / Math.max(index.avgBodyLen, 1)));
        const normS = 1.2 * (0.25 + 0.75 * (len.s / Math.max(index.avgSourceLen || 1, 1)));
        const contribution = termWeight
          * (TITLE_WEIGHT * fieldScore(tf.t, 1)
            + BODY_WEIGHT * fieldScore(tf.b, normB)
            + SOURCE_WEIGHT * fieldScore(tf.s, normS));
        if (contribution <= 0) continue;
        scores.set(id, (scores.get(id) || 0) + contribution);
        let set = seen.get(id);
        if (!set) { set = new Set(); seen.set(id, set); }
        if (!set.has(term)) {
          set.add(term);
          matchedWeight.set(id, (matchedWeight.get(id) || 0) + qWeight);
        }
        let list = matched.get(id);
        if (!list) { list = []; matched.set(id, list); }
        const field = tf.t > 0 ? 'title' : (tf.b > 0 ? 'body' : 'source');
        list.push({ term, field, idf });
      }
    }
  }

  const ranked = [];
  for (const [id, score] of scores) {
    const item = items.get ? items.get(id) : null;
    if (!item) continue;
    const terms = matched.get(id) || [];
    const fields = new Set(terms.map(entry => entry.field));
    const allCommon = terms.length > 0 && terms.every(entry => entry.idf < 1.5);
    const FIELD_LABEL = { title: '标题', body: '正文', source: '原文' };
    let reason;
    if (score < threshold) reason = '低分';
    else if (allCommon) reason = '泛词';
    else reason = ['title', 'body', 'source']
      .filter(field => fields.has(field))
      .map(field => FIELD_LABEL[field])
      .join('+');
    ranked.push({
      item,
      score,
      coverage: totalWeight > 0 ? (matchedWeight.get(id) || 0) / totalWeight : 0,
      matched: terms
        .slice()
        .sort((a, b) => b.idf - a.idf)
        .slice(0, 4),
      reason
    });
  }
  ranked.sort((a, b) => b.score - a.score
    || String(b.item.updatedAt || '').localeCompare(String(a.item.updatedAt || '')));
  return ranked.slice(0, limit);
}

/** 展示用的关键词：取命中条目里真正命中的稀有词，去掉被更长词包含的碎片。 */
export function displayTerms(hits, limit = 6) {
  const map = new Map();
  for (const hit of hits || []) {
    for (const match of hit.matched || []) {
      if (!match || typeof match.term !== 'string') continue;
      if ((match.idf || 0) < 2) continue;
      if (match.term.length < 2) continue;
      const prev = map.get(match.term);
      if (!prev || (match.idf || 0) > (prev.idf || 0)) map.set(match.term, { term: match.term, idf: match.idf || 0 });
    }
  }
  const sorted = [...map.values()].sort((a, b) => b.idf - a.idf || b.term.length - a.term.length);
  const kept = [];
  for (const entry of sorted) {
    if (kept.some(term => term.includes(entry.term) || entry.term.includes(term))) continue;
    kept.push(entry.term);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
export function relativeTime(iso, now = Date.now()) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, now - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + ' 天前';
  return new Date(time).toISOString().slice(0, 10);
}

/** 粗略 token 估算：中文按 1 字 1 token（保守），英文按 0.3 token/字符。 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (s.match(/[A-Za-z0-9_\-.]/g) || []).length;
  const punctuation = Math.max(0, s.length - cjk - latin);
  return Math.ceil(cjk + latin * 0.3 + punctuation * 0.6);
}

/** 展示行：标题、状态、范围、最近一次修订。 */
export function hitView(hit, store) {
  const item = hit.item;
  const summary = store && store.revisionSummary ? store.revisionSummary(item.id) : null;
  const historyLine = summary
    ? `r${summary.rev} · ${relativeTime(summary.time)} · ${summary.by === 'human' ? '人' : 'AI'}${summary.note ? ' · ' + summary.note : ''}`
    : `r${item.rev}`;
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    statusLabel: STATUS_LABEL.get(item.status) || item.status,
    kind: item.kind,
    kindLabel: KIND_LABEL.get(item.kind) || item.kind,
    scope: item.scope || '',
    rev: item.rev,
    updatedAt: item.updatedAt,
    score: Number(hit.score.toFixed(2)),
    coverage: Number(hit.coverage.toFixed(2)),
    reason: hit.reason,
    matched: hit.matched.map(entry => ({ term: entry.term, field: entry.field })),
    body: bodyText(item.body || '').slice(0, 800),
    historyLine
  };
}

/** 拼“如果注入会发出去的文本”。 */
export function buildInjectText(views, options = {}) {
  const limit = Math.max(1, Math.min(options.limit || 3, 10));
  const picked = views
    .filter(view => view.reason !== '低分' && view.reason !== '泛词')
    .slice(0, limit);
  if (picked.length === 0) return '';
  const lines = ['【看板·相关】'];
  for (const view of picked) {
    lines.push(`- ${view.title}（${view.scope || '未定'} · ${view.statusLabel} · ${view.historyLine}）`);
  }
  return lines.join('\n');
}
