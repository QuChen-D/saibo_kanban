#!/usr/bin/env node
/**
 * 命令行导入（页面导入之外的备用入口）。
 *
 *   node bin/import.mjs --xlsx "C:\path\开发任务管理看板.xlsx" --dry-run
 *   node bin/import.mjs --xlsx "..." --data-dir "C:\...\.dsh\saibo_kanban"
 *
 * 页面操作是主路径：看板面板 → 导入 → 选择 xlsx。
 */
import path from 'node:path';
import { readXlsx } from '../lib/xlsx.js';
import { buildImport, describeImport } from '../lib/import-map.js';
import { Store, defaultDataDir } from '../store.js';
import { normalizeKinds } from '../core.js';

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

const sheets = readXlsx(file);
const plan = buildImport(sheets);
const desc = describeImport(plan);
console.log(`文件：${file}`);
console.log(`主表 ${desc.main} 条（归档，done）`);
console.log(`滚动项 ${desc.rolling} 条（活跃）`);
console.log(`节点说明：${desc.notes} 条`);
console.log('状态分布：', desc.byStatus);
console.log('样例：');
for (const s of desc.samples) console.log('  -', s.status, '|', s.scope, '|', s.title);

if (flags['dry-run'] === true) {
  console.log('\n--dry-run：不写入。');
  process.exit(0);
}

const dataDir = flags['data-dir'] || defaultDataDir();
const store = new Store({ dataDir, kinds: normalizeKinds(null) }).load();
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
if (plan.notes && flags['include-notes'] === true) write(plan.notes, '导入：节点说明');
console.log(`\n已导入 ${imported} 条，跳过重复 ${skipped} 条 → ${path.join(dataDir, 'records.jsonl')}`);
