/**
 * 0.2.0 自测：不依赖 DSH，直接驱动 core/store/tools。
 * 运行：node test/run.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../store.js';
import { createTools } from '../tools.js';
import { normalizeKinds, BoardError } from '../core.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saibo-kanban-'));
const kinds = normalizeKinds(['task', 'decision', 'pitfall', 'design']);
const store = new Store({ dataDir: dir, kinds }).load();
const tools = Object.fromEntries(createTools(store, { kinds, maxBriefChars: 2000 }).map(t => [t.name, t]));
const call = async (name, args) => {
  const out = await tools[name].execute(args, {});
  // DSH 要求工具返回值是 lossless JSON：任何 undefined / 函数 / 类实例都会被拒。
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out, `${name} 的输出不是 lossless JSON`);
  return out;
};

let passed = 0;
function ok(name, fn) {
  return (async () => {
    await fn();
    passed += 1;
    console.log('  ✓', name);
  })();
}

console.log('数据目录', dir);

let rec;

await ok('board_record 写入条目', async () => {
  const out = await call('board_record', { title: '用 JSONL 追加台账', kind: 'decision', scope: '存储' });
  rec = out;
  assert.equal(out.rev, 1);
  assert.equal(store.get(out.id).title, '用 JSONL 追加台账');
});

await ok('board_brief 列出全部条目', async () => {
  const out = await call('board_brief', {});
  assert.match(out.markdown, /用 JSONL 追加台账/);
});

await ok('board_update 改标题 → 新修订', async () => {
  const out = await call('board_update', { id: rec.id, expectedRev: 1, title: '用 JSONL 追加台账（已定）' });
  assert.equal(out.rev, 2);
  assert.equal(out.changed, true);
  assert.deepEqual(out.changes.title, { from: '用 JSONL 追加台账', to: '用 JSONL 追加台账（已定）' });
});

await ok('board_update 带错修订号 → STALE_REVISION', async () => {
  await assert.rejects(
    () => call('board_update', { id: rec.id, expectedRev: 1, body: 'x' }),
    err => err.code === 'STALE_REVISION'
  );
});

await ok('AI 可以把状态改成 done（权限对等）', async () => {
  const it = store.record({ title: '待验收的任务', kind: 'task', status: 'in_review' }, { by: 'ai' });
  const r = store.update(it.id, { status: 'done' }, { by: 'ai', expectedRev: it.rev });
  assert.equal(r.item.status, 'done');
});

await ok('board_rollback 回到旧修订（历史保留）', async () => {
  const before = store.get(rec.id);
  const out = await call('board_rollback', { id: rec.id, rev: 1 });
  assert.equal(out.rev, before.rev + 1);
  assert.equal(store.get(rec.id).title, '用 JSONL 追加台账');
  const hist = store.history(rec.id);
  assert.ok(hist.length >= 3);
});

await ok('任意状态可互转（todo → done）', async () => {
  const cur = store.record({ title: '测试流转', kind: 'task' }, { by: 'ai' });
  const r = store.update(cur.id, { status: 'done' }, { by: 'ai', expectedRev: cur.rev });
  assert.equal(r.item.status, 'done');
});

await ok('board_supersede 保留旧条目并指向新条目', async () => {
  const old = store.record({ title: '旧结论', kind: 'decision' }, { by: 'ai' });
  const out = await call('board_supersede', {
    id: old.id, expectedRev: old.rev, title: '新结论', body: '旧结论作废'
  });
  assert.equal(store.get(old.id).supersededBy, out.newId);
  assert.equal(store.get(out.newId).rev, 1);
  assert.throws(() => store.update(old.id, { body: 'x' }, { by: 'ai', expectedRev: store.get(old.id).rev }),
    err => err.code === 'SUPERSEDED');
});

await ok('board_merge 合并两条并隐藏来源', async () => {
  const a = store.record({ title: '重复 A', kind: 'pitfall' }, { by: 'ai' });
  const b = store.record({ title: '重复 B', kind: 'pitfall' }, { by: 'ai' });
  const out = await call('board_merge', { ids: [a.id, b.id], title: '合并后的一条' });
  assert.equal(store.get(a.id).mergedInto, out.id);
  assert.equal(store.get(b.id).mergedInto, out.id);
});

await ok('合并后的来源不出现在列表', async () => {
  const list = await call('board_search', {});
  assert.equal(list.items.some(i => i.title === '重复 A'), false);
});

await ok('done 条目出现在列表（不再归档）', async () => {
  const list = await call('board_search', { status: 'done' });
  assert.ok(list.items.length >= 1);
});

await ok('重新加载后状态一致（JSONL 可重放）', async () => {
  const before = [...store.items.values()].map(i => ({ id: i.id, rev: i.rev, title: i.title, archived: i.archived }));
  const reloaded = new Store({ dataDir: dir, kinds }).load();
  const after = [...reloaded.items.values()].map(i => ({ id: i.id, rev: i.rev, title: i.title, archived: i.archived }));
  assert.deepEqual(after, before);
  const lines = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(lines, reloaded.events);
  assert.equal(reloaded.badLines, 0);
});

await ok('每条记录只追加、历史修订号单调递增', async () => {
  const raw = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const lastRev = new Map();
  for (const evt of raw) {
    const prev = lastRev.get(evt.id) || 0;
    assert.equal(evt.rev, prev + 1, `条目 ${evt.id} 的修订号跳了`);
    lastRev.set(evt.id, evt.rev);
  }
});

console.log(`\n全部通过：${passed} 项`);
console.log('样例档案：');
console.log(fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').split('\n').slice(0, 2).join('\n'));
