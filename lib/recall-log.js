/**
 * lib/recall-log.js — 召回记录台账（单独一个文件，不影响看板数据）。
 *
 * 每次预览/注入追加一行，用来观察“召回本身花多少 token、命中几条”。
 * 预览阶段 injected=false、actualTokens=0；真注入后 actualTokens 记实际值。
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'recall.jsonl';

export function recallLogPath(dataDir) {
  return path.join(dataDir, FILE);
}

export function appendRecall(dataDir, entry) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(recallLogPath(dataDir), JSON.stringify(entry) + '\n');
}

/** 统计最近 N 天的召回次数与预计 token。 */
export function recallStats(dataDir, days = 1) {
  const file = recallLogPath(dataDir);
  const empty = { days, count: 0, injectTokens: 0, actualTokens: 0, hitRows: 0 };
  if (!fs.existsSync(file)) return empty;
  const since = Date.now() - Math.max(1, days) * 86400000;
  const out = { ...empty };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const time = Date.parse(entry && entry.time);
    if (!Number.isFinite(time) || time < since) continue;
    out.count += 1;
    out.injectTokens += Number(entry.injectTokens) || 0;
    out.actualTokens += Number(entry.actualTokens) || 0;
    out.hitRows += Number(entry.hitRows) || 0;
  }
  return out;
}
