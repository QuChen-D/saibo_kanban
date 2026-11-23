#!/usr/bin/env node
/**
 * 导入 xlsx 到看板。
 *
 *   node bin/import.mjs --xlsx "C:\path\开发任务管理看板.xlsx" --dry-run
 *   node bin/import.mjs --xlsx "..." --data-dir "C:\...\.dsh\saibo_kanban"
 *
 * 规则：
 * - 任务主表：全部导入为已归档（历史台账），状态 done
 * - 长期滚动项：导入为活跃条目，按状态映射
 * - 节点说明：整页文本合成一条 design 资产
 */
import path from 'node:path';
import { readXlsx } from '../lib/xlsx.js';
import { Store, defaultDataDir } from '../store.js';
import { normalizeKinds, STATUSES } from '../core.js';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; }
    else flags[key] = true;
  }
}
const file = flags.xlsx;
if (!file) {
  console.error('用法: node bin/import.mjs --xlsx <文件> [--dry-run] [--data-dir <目录>]');
  process.exit(1);
}
const dryRun = flags['dry-run'] === true;
const dataDir = flags['data-dir'] || defaultDataDir();

const STATUS_MAP = {
  DONE: 'done',
  'DONE（描述修正）': 'done',
  'DONE（已覆盖）': 'done',
  TODO: 'todo',
  PARTIAL: 'in_progress',
  FIX: 'in_progress',
  BLOCKED: 'blocked',
  暂缓: 'backlog'
};

const statusLabel = id => (STATUSES.find(s => s.id === id) || { label: id }).label;

function headerIndex(rows, name) {
  for (let i = 0; i < Math.min(rows.length, 5); i += 1) {
    if ((rows[i] || []).some(v => String(v).trim() === name)) return i;
  }
  return 1;
}

function col(rows, headerRow, name) {
  const row = rows[headerRow] || [];
  for (let i = 0; i < row.length; i += 1) if (String(row[i]).trim() === name) return i;
  return -1;
}

function cell(row, idx) {
  if (idx < 0) return '';
  const v = row[idx];
  return v === undefined || v === null ? '' : String(v).trim();
}

function mapMain(rows) {
  const h = headerIndex(rows, '编号');
  const cId = col(rows, h, '编号');
  const cGroup = col(rows, h, '分组');
  const cTitle = col(rows, h, '名称');
  const cBody = col(rows, h, '详细说明');
  const cStatus = col(rows, h, '状态');
  const cType = col(rows, h, '类型');
  const out = [];
  for (let i = h + 1; i < rows.length; i += 1) {
    const title = cell(rows[i], cTitle);
    if (!title) continue;
    const status = STATUS_MAP[cell(rows[i], cStatus)] || 'done';
    out.push({
      title,
      body: [
        cell(rows[i], cId) ? `编号：${cell(rows[i], cId)}` : '',
        cell(rows[i], cType) ? `类型：${cell(rows[i], cType)}` : '',
        cell(rows[i], cBody)
      ].filter(Boolean).join('\n'),
      kind: 'task',
      scope: cell(rows[i], cGroup),
      status,
      archived: true,
      ext: cell(rows[i], cId)
    });
  }
  return out;
}

function mapRolling(rows) {
  const h = headerIndex(rows, '编号');
  const cId = col(rows, h, '编号');
  const cGroup = col(rows, h, '分组');
  const cTitle = col(rows, h, '名称');
  const cBody = col(rows, h, '详细说明');
  const cStatus = col(rows, h, '状态');
  const cPri = col(rows, h, '优先级');
  const cRoll = col(rows, h, '滚动次数');
  const cFirst = col(rows, h, '首次来源');
  const cLast = col(rows, h, '最近来源');
  const out = [];
  for (let i = h + 1; i < rows.length; i += 1) {
    const title = cell(rows[i], cTitle);
    if (!title) continue;
    const status = STATUS_MAP[cell(rows[i], cStatus)] || 'todo';
    out.push({
      title,
      body: [
        cell(rows[i], cId) ? `编号：${cell(rows[i], cId)}` : '',
        cell(rows[i], cBody),
        cell(rows[i], cPri) ? `优先级：${cell(rows[i], cPri)}` : '',
        cell(rows[i], cRoll) ? `滚动次数：${cell(rows[i], cRoll)}` : '',
        cell(rows[i], cFirst) ? `首次来源：${cell(rows[i], cFirst)}` : '',
        cell(rows[i], cLast) ? `最近来源：${cell(rows[i], cLast)}` : ''
      ].filter(Boolean).join('\n'),
      kind: 'task',
      scope: cell(rows[i], cGroup),
      status,
      archived: false,
      ext: cell(rows[i], cId)
    });
  }
  return out;
}

function mapNotes(rows) {
  const text = rows.map(r => cell(r, 0)).join('\n').trim();
  if (!text) return null;
  const firstLine = text.split('\n').find(l => l.trim()) || '节点说明';
  return {
    title: firstLine.replace(/^#+\s*/, '').slice(0, 120),
    body: text,
    kind: 'design',
    scope: '设计',
    status: 'done',
    archived: false,
    ext: 'nodes'
  };
}

const sheets = readXlsx(file);
const byName = new Map(sheets.map(s => [s.name, s.rows]));
const mainRows = byName.get('任务主表') || sheets[0]?.rows || [];
const rollingRows = byName.get('长期滚动项') || sheets[1]?.rows || [];
const notesRows = byName.get('节点说明') || sheets[2]?.rows || [];

const main = mapMain(mainRows);
const rolling = mapRolling(rollingRows);
const notes = mapNotes(notesRows);

console.log(`文件：${file}`);
console.log(`主表 ${main.length} 条（归档，done）`);
console.log(`滚动项 ${rolling.length} 条（活跃）`);
console.log(`节点说明：${notes ? '1 条' : '无'}`);
console.log('状态分布：', Object.fromEntries([...new Set(rolling.map(r => r.status))].map(s => [statusLabel(s), rolling.filter(r => r.status === s).length])));

const titles = new Map();
for (const r of rolling) titles.set(r.title, (titles.get(r.title) || 0) + 1);
const dup = [...titles.entries()].filter(([, n]) => n > 1);
console.log(`滚动项重名：${dup.length} 组`);
console.log('样例：');
for (const r of rolling.slice(0, 2)) console.log('  -', r.status, '|', r.scope, '|', r.title);
for (const r of main.slice(0, 1)) console.log('  -', r.status, '|', r.scope, '|', r.title, '(归档)');

if (dryRun) {
  console.log('\n--dry-run：不写入。去掉 --dry-run 才导入。');
  process.exit(0);
}

const store = new Store({ dataDir, kinds: normalizeKinds(null) }).load();
let written = 0;
for (const item of main) {
  const created = store.record({
    title: item.title, kind: item.kind, scope: item.scope, body: item.body, status: item.status
  }, { by: 'human', note: '导入：任务主表' });
  store.archive(created.id, { by: 'human', note: '导入历史台账' });
  written += 1;
}
for (const item of rolling) {
  store.record({
    title: item.title, kind: item.kind, scope: item.scope, body: item.body, status: item.status
  }, { by: 'human', note: '导入：长期滚动项' });
  written += 1;
}
if (notes) {
  store.record({ title: notes.title, kind: notes.kind, scope: notes.scope, body: notes.body, status: notes.status },
    { by: 'human', note: '导入：节点说明' });
  written += 1;
}
console.log(`\n已导入 ${written} 条到 ${path.join(dataDir, 'records.jsonl')}`);
