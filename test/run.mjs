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
import { collectChanges } from '../index.js';
import { buildIndex, searchIndex, queryTerms, estimateTokens, buildInjectText, hitView, displayTerms } from '../lib/recall.js';
import { appendRecall, recallStats } from '../lib/recall-log.js';

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

await ok('物理删除：记录从文件里消失，内存里也查不到', async () => {
  const it = store.record({ title: '误加的条目', kind: 'task' }, { by: 'ai' });
  store.update(it.id, { body: '错的内容' }, { by: 'ai', expectedRev: it.rev });
  const out = await call('board_delete', { id: it.id });
  assert.equal(out.removed, 2);
  assert.throws(() => store.get(it.id), err => err.code === 'NOT_FOUND');
  const raw = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8');
  assert.equal(raw.includes(it.id), false);
  const reloaded = new Store({ dataDir: dir, kinds }).load();
  assert.equal(reloaded.items.has(it.id), false);
  assert.equal(reloaded.badLines, 0);
});

await ok('删掉被取代的目标：旧条目的指向自动撤销', async () => {
  const oldItem = store.record({ title: '旧结论待撤', kind: 'decision' }, { by: 'ai' });
  const sup = await call('board_supersede', { id: oldItem.id, expectedRev: oldItem.rev, title: '新结论待撤' });
  await call('board_delete', { id: sup.newId });
  const after = store.get(oldItem.id);
  assert.equal(after.supersededBy, null);
});

await ok('删掉合并目标：来源条目恢复可见', async () => {
  const a = store.record({ title: '合并来源甲', kind: 'pitfall' }, { by: 'ai' });
  const b = store.record({ title: '合并来源乙', kind: 'pitfall' }, { by: 'ai' });
  const merged = await call('board_merge', { ids: [a.id, b.id], title: '会被删的合并结果' });
  await call('board_delete', { id: merged.id });
  const list = await call('board_search', { query: '合并来源' });
  assert.equal(list.items.length, 2);
  assert.equal(store.get(a.id).mergedInto, null);
  const lines = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(store.events, lines);
});

await ok('召回：标题和正文同等命中，别名可展开', async () => {
  const now = new Date().toISOString();
  const items = new Map();
  for (let i = 0; i < 40; i += 1) {
    items.set('f' + i, {
      id: 'f' + i, title: '占位条目 ' + i, body: '无关内容 ' + i,
      status: 'done', kind: 'task', scope: '占位', rev: 1, updatedAt: now
    });
  }
  items.set('r1', { id: 'r1', title: '前端打印 icon', body: '', status: 'in_progress', kind: 'task', scope: 'G5', rev: 2, updatedAt: now });
  items.set('r2', { id: 'r2', title: '样式调整', body: '打印弹窗在小屏下错位', status: 'done', kind: 'pitfall', scope: 'G5', rev: 1, updatedAt: now });
  items.set('r3', { id: 'r3', title: '图标风格统一', body: '', status: 'done', kind: 'task', scope: 'G15', rev: 1, updatedAt: now });
  const index = buildIndex(items);
  const byTitle = searchIndex(index, items, [{ text: '打印 icon 怎么修', weight: 1 }], { threshold: 1 });
  assert.equal(byTitle[0].item.id, 'r1');
  const byBody = searchIndex(index, items, [{ text: '小屏下错位', weight: 1 }], { threshold: 1 });
  assert.equal(byBody[0].item.id, 'r2');
  assert.equal(byBody[0].reason, '正文');
  const byAlias = searchIndex(index, items, [{ text: 'icon 风格', weight: 1 }], { threshold: 1 });
  assert.ok(byAlias.some(hit => hit.item.id === 'r3'), 'icon 应该通过别名命中「图标」');
  assert.ok(queryTerms('icon').has('图标'));
});

await ok('召回：低分与命中文本', async () => {
  const now = new Date().toISOString();
  const items = new Map();
  for (let i = 0; i < 40; i += 1) {
    items.set('f' + i, {
      id: 'f' + i, title: '占位条目 ' + i, body: '无关内容 ' + i,
      status: 'done', kind: 'task', scope: '占位', rev: 1, updatedAt: now
    });
  }
  items.set('r4', { id: 'r4', title: '物理删除条目', body: '删掉不能恢复', status: 'done', kind: 'task', scope: '导入', rev: 3, updatedAt: now });
  const index = buildIndex(items);
  const low = searchIndex(index, items, [{ text: '完全无关的话', weight: 1 }], { threshold: 1 });
  assert.equal(low.length, 0);
  const hits = searchIndex(index, items, [{ text: '物理删除', weight: 1 }], { threshold: 1 });
  const views = hits.map(hit => hitView(hit, { revisionSummary: () => ({ rev: 3, time: now, by: 'human', note: '从对话加入看板' }) }));
  const text = buildInjectText(views);
  assert.match(text, /【看板·相关】/);
  assert.match(text, /物理删除条目/);
  assert.ok(estimateTokens(text) > 10);
  assert.ok(estimateTokens(text) < text.length);
});

await ok('召回记录单独记账，不写进 records.jsonl', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saibo-recall-'));
  appendRecall(logDir, {
    v: 1, recallId: 'rc-1', time: new Date().toISOString(),
    sessionId: 's', messageId: 'm', terms: ['打印'], hitRows: 2, candidateRows: 4,
    injectText: '【看板·相关】\n- 打印', injectTokens: 42, injected: false, actualTokens: 0
  });
  const stats = recallStats(logDir, 1);
  assert.equal(stats.count, 1);
  assert.equal(stats.injectTokens, 42);
  assert.equal(fs.existsSync(path.join(logDir, 'records.jsonl')), false);
});

await ok('展示关键词：只留稀有词，去掉重叠碎片', async () => {
  const hits = [{
    matched: [
      { term: '合并完', idf: 4.2, field: 'title' },
      { term: '合并', idf: 3.1, field: 'title' },
      { term: '发布', idf: 3.5, field: 'title' },
      { term: '已发布', idf: 1.2, field: 'title' },
      { term: '本机没', idf: 2.6, field: 'body' }
    ]
  }];
  const terms = displayTerms(hits, 6);
  assert.ok(terms.includes('合并完'), '应保留较长的稀有词');
  assert.equal(terms.includes('合并'), false, '被更长词包含的碎片应去掉');
  assert.ok(terms.includes('发布'));
  assert.equal(terms.includes('已发布'), false, 'idf 太低的不展示');
  assert.ok(terms.length <= 6);
});

await ok('轮内改动：能拿到旧状态和回滚点', async () => {
  const it = store.record({ title: '轮内改动测试', kind: 'task', status: 'in_progress' }, { by: 'ai' });
  const since = Date.now();
  store.update(it.id, { status: 'done' }, { by: 'ai', expectedRev: it.rev, note: '这轮做完了' });
  const changes = collectChanges(store, since);
  const hit = changes.find(change => change.id === it.id);
  assert.ok(hit, '应该能抓到这条改动');
  assert.equal(hit.from.status, 'in_progress');
  assert.equal(hit.status, 'done');
  assert.equal(hit.previousRev, 1);
  assert.equal(hit.note, '这轮做完了');
});

await ok('正文折叠换行，超 80 字直接拒绝', async () => {
  const it = await call('board_record', { title: '正文契约测试', body: '一句话结论\n第二行' });
  assert.equal(store.get(it.id).body, '一句话结论 第二行', '换行应折叠成空格');
  await assert.rejects(
    () => call('board_record', { title: '超长正文测试', body: '长'.repeat(81) }),
    err => err.code === 'BODY_TOO_LONG'
  );
  await assert.rejects(
    () => call('board_update', { id: it.id, expectedRev: it.rev, body: '长'.repeat(81) }),
    err => err.code === 'BODY_TOO_LONG'
  );
});

console.log(`\n全部通过：${passed} 项`);
console.log('样例档案：');
console.log(fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').split('\n').slice(0, 2).join('\n'));
