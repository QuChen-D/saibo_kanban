/**
 * store.js — 本地 JSONL 追加台账。
 *
 * 一条记录 = 一次修订（含完整快照），只追加、不覆盖。
 * 换 SQLite / PG 时只需要换掉这个文件，core 和 tools 不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  BoardError, assertTitle, assertKind, assertStatus, assertTransition,
  diffFields, nextId, isDraft, buildBrief, matchesQuery
} from './core.js';

const SCHEMA_VERSION = 1;
const FILE_NAME = 'records.jsonl';

export function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'saibo_kanban');
}

function emptyItem() {
  return {
    id: '', title: '', kind: 'task', status: 'backlog', scope: '', body: '',
    source: null, verified: false, archived: false,
    rev: 0, createdAt: '', updatedAt: '', supersededBy: null, mergedInto: null
  };
}

export class Store {
  constructor(options = {}) {
    this.dataDir = options.dataDir || defaultDataDir();
    this.file = path.join(this.dataDir, FILE_NAME);
    this.kinds = options.kinds;
    this.items = new Map();
    this.events = 0;
    this.badLines = 0;
  }

  load() {
    this.items.clear();
    this.events = 0;
    this.badLines = 0;
    if (!fs.existsSync(this.file)) return this;
    const raw = fs.readFileSync(this.file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { this.badLines += 1; continue; }
      if (!event || event.v !== SCHEMA_VERSION || !event.item || !event.item.id) { this.badLines += 1; continue; }
      this.events += 1;
      const current = this.items.get(event.item.id);
      if (!current || current.rev <= event.item.rev) {
        this.items.set(event.item.id, event.item);
      }
    }
    return this;
  }

  append(event) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.events += 1;
    this.items.set(event.item.id, event.item);
  }

  get(id) {
    const item = this.items.get(id);
    if (!item) throw new BoardError('NOT_FOUND', `没有找到条目 ${id}`);
    return item;
  }

  /** 新建条目。AI 写入默认 verified=false；人写入可以直接 verified=true。 */
  record(input, context = {}) {
    const by = context.by === 'human' ? 'human' : 'ai';
    const now = new Date().toISOString();
    const title = assertTitle(input.title);
    const kind = input.kind || 'task';
    assertKind(kind, this.kinds);
    const status = input.status || 'backlog';
    assertStatus(status);
    const item = emptyItem();
    item.id = input.id || nextId();
    if (this.items.has(item.id)) throw new BoardError('DUPLICATE_ID', `条目 ${item.id} 已存在`);
    item.title = title;
    item.kind = kind;
    item.status = status;
    item.scope = typeof input.scope === 'string' ? input.scope : '';
    item.body = typeof input.body === 'string' ? input.body : '';
    item.source = normalizeSource(input.source);
    item.rev = 1;
    item.createdAt = now;
    item.updatedAt = now;
    this.append({
      v: SCHEMA_VERSION, id: item.id, rev: item.rev, time: now, by,
      note: context.note || '创建',
      changes: { created: { from: '', to: title } },
      item
    });
    return item;
  }

  /** 字段级修改。必须带 expectedRev；冲突即拒绝，不自动重试。 */
  update(id, patch, context = {}) {
    const by = context.by === 'human' ? 'human' : 'ai';
    const current = this.get(id);
    if (current.archived) throw new BoardError('ARCHIVED', `条目 ${id} 已归档，不能再修改`);
    if (current.supersededBy) throw new BoardError('SUPERSEDED', `条目 ${id} 已被 ${current.supersededBy} 取代`);
    if (typeof context.expectedRev !== 'number' || context.expectedRev !== current.rev) {
      throw new BoardError('STALE_REVISION',
        `修订冲突：当前是 r${current.rev}，你给的是 r${context.expectedRev ?? '缺失'}。请重新读取后再改`);
    }
    const next = { ...current };
    const safe = {};
    for (const field of ['title', 'kind', 'status', 'scope', 'body']) {
      if (patch[field] === undefined) continue;
      safe[field] = patch[field];
    }
    if ('title' in safe) safe.title = assertTitle(safe.title);
    if ('kind' in safe) { assertKind(safe.kind, this.kinds); }
    if ('status' in safe) {
      assertStatus(safe.status);
      assertTransition(current.status, safe.status);
    }
    if ('scope' in safe && typeof safe.scope !== 'string') {
      throw new BoardError('INVALID_SCOPE', 'scope 必须是字符串');
    }
    if ('body' in safe && typeof safe.body !== 'string') {
      throw new BoardError('INVALID_BODY', 'body 必须是字符串');
    }
    const changes = diffFields(current, safe);
    if (Object.keys(changes).length === 0) {
      return { item: current, changed: false, changes: {} };
    }
    Object.assign(next, safe);
    next.rev = current.rev + 1;
    next.updatedAt = new Date().toISOString();
    this.append({
      v: SCHEMA_VERSION, id, rev: next.rev, time: next.updatedAt, by,
      note: context.note || '', changes, item: next
    });
    return { item: next, changed: true, changes };
  }

  /** 人点「接受」：verified=true。 */
  accept(id, context = {}) {
    return this.setVerified(id, true, { ...context, by: 'human', note: context.note || '接受' });
  }

  setVerified(id, verified, context = {}) {
    const current = this.get(id);
    if (current.verified === verified) return { item: current, changed: false };
    if (context.by !== 'human') {
      throw new BoardError('HUMAN_ONLY', '确认状态只能由人改');
    }
    const next = { ...current, verified, rev: current.rev + 1, updatedAt: new Date().toISOString() };
    this.append({
      v: SCHEMA_VERSION, id, rev: next.rev, time: next.updatedAt, by: 'human',
      note: context.note || (verified ? '接受' : '取消确认'),
      changes: { verified: { from: String(current.verified), to: String(verified) } },
      item: next
    });
    return { item: next, changed: true };
  }

  /** 用新条目取代旧条目；旧条目保留，标记 supersededBy。 */
  supersede(id, replacement, context = {}) {
    const old = this.get(id);
    if (old.archived) throw new BoardError('ARCHIVED', `条目 ${id} 已归档，不能再取代`);
    if (typeof context.expectedRev !== 'number' || context.expectedRev !== old.rev) {
      throw new BoardError('STALE_REVISION',
        `修订冲突：当前是 r${old.rev}，你给的是 r${context.expectedRev ?? '缺失'}`);
    }
    const by = context.by === 'human' ? 'human' : 'ai';
    const replacementStatus = replacement.status || 'in_review';
    const created = this.record({
      ...replacement,
      kind: replacement.kind || old.kind,
      scope: replacement.scope ?? old.scope,
      body: replacement.body ?? old.body,
      source: replacement.source || old.source,
      status: replacementStatus
    }, { by, note: context.note || `取代 ${old.id}`, verified: false });
    const next = { ...old, supersededBy: created.id, rev: old.rev + 1, updatedAt: new Date().toISOString() };
    this.append({
      v: SCHEMA_VERSION, id, rev: next.rev, time: next.updatedAt, by,
      note: context.note || `被 ${created.id} 取代`,
      changes: { supersededBy: { from: '', to: created.id } }, item: next
    });
    return { old: next, created };
  }

  /** 合并多条到一个新条目；来源条目归档并标记 mergedInto。 */
  merge(ids, merged, context = {}) {
    if (!Array.isArray(ids) || ids.length < 2) {
      throw new BoardError('INVALID_INPUT', 'merge 至少需要两个条目');
    }
    const by = context.by === 'human' ? 'human' : 'ai';
    const sources = ids.map(id => this.get(id));
    for (const src of sources) {
      if (src.archived) throw new BoardError('ARCHIVED', `条目 ${src.id} 已归档`);
      if (src.supersededBy) throw new BoardError('SUPERSEDED', `条目 ${src.id} 已被取代`);
    }
    const created = this.record({
      title: merged.title,
      kind: merged.kind || sources[0].kind,
      status: merged.status || 'in_review',
      scope: merged.scope ?? sources[0].scope,
      body: merged.body ?? sources.map(s => s.body).filter(Boolean).join('\n\n'),
      source: merged.source || sources[0].source
    }, { by, note: context.note || `合并 ${sources.map(s => s.id).join(' + ')}` });
    const now = new Date().toISOString();
    for (const src of sources) {
      const next = {
        ...src, mergedInto: created.id, archived: true,
        rev: src.rev + 1, updatedAt: now
      };
      this.append({
        v: SCHEMA_VERSION, id: src.id, rev: next.rev, time: now, by,
        note: context.note || `合并进 ${created.id}`,
        changes: { mergedInto: { from: '', to: created.id }, archived: { from: 'false', to: 'true' } },
        item: next
      });
    }
    return { created, sources: ids };
  }

  /** 归档（人操作）：不删除，可撤销。 */
  archive(id, context = {}) {
    const current = this.get(id);
    if (current.archived) return { item: current, changed: false };
    const now = new Date().toISOString();
    const next = { ...current, archived: true, rev: current.rev + 1, updatedAt: now };
    this.append({
      v: SCHEMA_VERSION, id, rev: next.rev, time: now,
      by: context.by === 'human' ? 'human' : 'ai',
      note: context.note || '归档',
      changes: { archived: { from: 'false', to: 'true' } }, item: next
    });
    return { item: next, changed: true };
  }

  restore(id, context = {}) {
    const current = this.get(id);
    if (!current.archived) return { item: current, changed: false };
    const now = new Date().toISOString();
    const next = { ...current, archived: false, rev: current.rev + 1, updatedAt: now };
    this.append({
      v: SCHEMA_VERSION, id, rev: next.rev, time: now,
      by: context.by === 'human' ? 'human' : 'ai',
      note: context.note || '撤销归档',
      changes: { archived: { from: 'true', to: 'false' } }, item: next
    });
    return { item: next, changed: true };
  }

  list(options = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 2000));
    const out = [];
    for (const item of this.items.values()) {
      if (item.mergedInto) continue;
      if (options.status && item.status !== options.status) continue;
      if (options.kind && item.kind !== options.kind) continue;
      if (options.scope && item.scope !== options.scope) continue;
      if (options.draft === true && item.verified) continue;
      if (options.draft === false && !item.verified) continue;
      if (!matchesQuery(item, options.query)) continue;
      out.push(item);
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: out.slice(0, limit), total: out.length, truncated: out.length > limit };
  }

  brief(options = {}) {
    const items = [...this.items.values()];
    return buildBrief(items, options);
  }

  stats() {
    const all = [...this.items.values()];
    return {
      total: all.length,
      active: all.filter(i => !i.archived).length,
      archived: all.filter(i => i.archived).length,
      rev: this.events
    };
  }

  /** 读取某个条目的完整修订历史（直接扫文件，不改内存）。 */
  history(id) {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.id !== id) continue;
      out.push({ rev: event.rev, time: event.time, by: event.by, note: event.note, changes: event.changes });
    }
    return out.sort((a, b) => a.rev - b.rev);
  }

  /** 取某个修订的完整快照（回滚用）。 */
  revision(id, rev) {
    if (!fs.existsSync(this.file)) return null;
    const raw = fs.readFileSync(this.file, 'utf8');
    let found = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.id === id && event.rev === rev && event.item) found = event.item;
    }
    return found;
  }

  /**
   * 回滚到指定修订：把那一版的字段写成一条新的修订。
   * 历史不销毁；回滚本身也可再回滚。
   */
  rollback(id, rev, context = {}) {
    const current = this.get(id);
    const target = this.revision(id, rev);
    if (!target) throw new BoardError('NOT_FOUND', `条目 ${id} 没有 r${rev}`);
    const now = new Date().toISOString();
    const next = {
      ...target,
      id: current.id,
      createdAt: current.createdAt,
      rev: current.rev + 1,
      updatedAt: now,
      archived: false,
      supersededBy: null,
      mergedInto: null
    };
    this.append({
      v: SCHEMA_VERSION, id, rev: next.rev, time: now,
      by: context.by === 'human' ? 'human' : 'ai',
      note: context.note || `回滚到 r${rev}`,
      changes: { rollback: { from: `r${current.rev}`, to: `r${rev}` } },
      item: next
    });
    return { item: next, changed: true };
  }
}

function normalizeSource(source) {
  if (!source) return null;
  if (typeof source === 'string') return { type: 'manual', ref: source };
  if (typeof source === 'object') {
    return {
      type: typeof source.type === 'string' ? source.type : 'manual',
      ref: typeof source.ref === 'string' ? source.ref : ''
    };
  }
  return null;
}
