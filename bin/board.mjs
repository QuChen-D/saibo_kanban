#!/usr/bin/env node
/**
 * 赛博看板的人机界面（CLI）。
 *
 * 这是「人」的入口：0 token、本地直写台账。页面做好之前先用它，
 * 页面做好之后两者共用同一份 store 与规则。
 *
 *   saibo-board list [--status todo] [--scope 看板插件]
 *   saibo-board inbox
 *   saibo-board add "标题" [--kind decision] [--scope 存储] [--body "正文"]
 *   saibo-board show <id>
 *   saibo-board accept <id> | unaccept <id>
 *   saibo-board update <id> [--title ...] [--status ...] [--kind ...] [--scope ...] [--body ...]
 *   saibo-board search <关键词>
 *   saibo-board brief [--scope ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store, defaultDataDir } from '../store.js';
import { STATUSES, DEFAULT_KINDS, normalizeKinds } from '../core.js';

const argv = process.argv.slice(2);
const command = argv[0];
const positionals = [];
const flags = {};
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i];
  if (token.startsWith('--')) {
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  } else {
    positionals.push(token);
  }
}

const kindLabel = id => (DEFAULT_KINDS.find(k => k.id === id) || { label: id }).label;
const statusLabel = id => (STATUSES.find(s => s.id === id) || { label: id }).label;

function dataDir() {
  return flags['data-dir'] || process.env.SAIBO_DATA_DIR || defaultDataDir();
}

function openStore() {
  const store = new Store({ dataDir: dataDir(), kinds: normalizeKinds(null) }).load();
  return store;
}

function printItem(item) {
  const mark = item.verified ? '✓' : '◌';
  const parts = [
    item.id,
    `r${item.rev}`,
    statusLabel(item.status),
    kindLabel(item.kind),
    item.scope || '—',
    `${mark} ${item.title}`
  ];
  if (item.archived) parts.push('(已归档)');
  if (item.supersededBy) parts.push(`→ ${item.supersededBy}`);
  console.log(parts.join('  '));
}

function usage() {
  console.log(`赛博看板 CLI

  list [--status <状态>] [--kind <类型>] [--scope <范围>] [--query <词>]
  inbox
  add <标题> [--kind <类型>] [--scope <范围>] [--body <正文>]
  show <id>
  accept <id>       把条目标为已确认
  unaccept <id>     取消确认
  update <id> [--title ...] [--status ...] [--kind ...] [--scope ...] [--body ...]
  search <关键词>
  brief [--scope <范围>]

数据目录：${dataDir()}
`);
}

const store = openStore();

switch (command) {
  case 'list': {
    const result = store.list({
      status: flags.status,
      kind: flags.kind,
      scope: flags.scope,
      query: flags.query,
      includeArchived: flags.all === true,      draft: flags.drafts === true ? true : undefined,
      limit: 200
    });
    if (result.items.length === 0) {
      console.log('（空）');
    } else {
      result.items.forEach(printItem);
      console.log(`\n共 ${result.total} 条${result.truncated ? '（已截断）' : ''}`);
    }
    break;
  }
  case 'inbox': {
    const result = store.list({ draft: true, limit: 200 });
    if (result.items.length === 0) {
      console.log('收件箱是空的。');
    } else {
      result.items.forEach(printItem);
      console.log(`\n待确认 ${result.total} 条。用 accept <id> 接受，archive <id> 删除。`);
    }
    break;
  }
  case 'add': {
    const title = positionals.join(' ');
    if (!title) { usage(); process.exitCode = 1; break; }
    const item = store.record({
      title,
      kind: flags.kind || 'task',
      scope: flags.scope || '',
      body: flags.body || ''
    }, { by: 'human', verified: true, note: '人工添加' });
    console.log(`已添加 ${item.id}（r${item.rev}）`);
    break;
  }
  case 'show': {
    const id = positionals[0];
    if (!id) { usage(); process.exitCode = 1; break; }
    const item = store.get(id);
    console.log(`${item.id}  ${item.title}`);
    console.log(`  类型 ${kindLabel(item.kind)} · 状态 ${statusLabel(item.status)} · 范围 ${item.scope || '—'} · ${item.verified ? '已确认' : '待确认'}${item.archived ? ' · 已归档' : ''}`);
    if (item.body) console.log(`\n${item.body}`);
    console.log('\n修订历史：');
    for (const event of store.history(id)) {
      const changes = Object.entries(event.changes)
        .map(([field, pair]) => `${field}: ${pair.from || '∅'} → ${pair.to || '∅'}`)
        .join('；');
      console.log(`  r${event.rev}  ${event.time.slice(0, 16).replace('T', ' ')}  ${event.by}  ${event.note || ''}`);
      if (changes) console.log(`      ${changes}`);
    }
    break;
  }
  case 'accept':
  case 'unaccept': {
    const id = positionals[0];
    if (!id) { usage(); process.exitCode = 1; break; }
    store.setVerified(id, command === 'accept', { by: 'human' });
    console.log(`${id} → ${command === 'accept' ? '已确认' : '待确认'}`);
    break;
  }
  case 'update': {
    const id = positionals[0];
    if (!id) { usage(); process.exitCode = 1; break; }
    const current = store.get(id);
    const patch = {};
    for (const field of ['title', 'kind', 'status', 'scope', 'body']) {
      if (typeof flags[field] === 'string') patch[field] = flags[field];
    }
    if (Object.keys(patch).length === 0) { usage(); process.exitCode = 1; break; }
    const result = store.update(id, patch, { by: 'human', expectedRev: current.rev, note: '人工修改' });
    console.log(result.changed ? `${id} → r${result.item.rev}` : '没有字段变化');
    break;
  }
  case 'search': {
    const query = positionals.join(' ');
    const result = store.list({ query, includeArchived: true, limit: 200 });
    if (result.items.length === 0) console.log('没有匹配的条目');
    else result.items.forEach(printItem);
    break;
  }
  case 'brief': {
    console.log(store.brief({}));
    break;
  }
  default:
    usage();
    if (command !== undefined) process.exitCode = 1;
}
