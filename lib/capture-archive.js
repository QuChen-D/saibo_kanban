/**
 * lib/capture-archive.js — 保存被加入看板的原始消息全文（只在本地，用来做检索）。
 *
 * 看板条目的 body 只放一句话说明；原文不进 body，但落到这个文件里，
 * 建索引时作为「原文」字段参与召回，页面上不展示。
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'captured.jsonl';

export function capturedPath(dataDir) {
  return path.join(dataDir, FILE);
}

/** 追加一条原文；同 id 后写的覆盖先写的。 */
export function appendCaptured(dataDir, id, text, meta = {}) {
  if (!id || typeof text !== 'string' || !text.trim()) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(capturedPath(dataDir), JSON.stringify({
    v: 1,
    id,
    text: text.slice(0, 20000),
    time: new Date().toISOString(),
    sessionId: meta.sessionId || '',
    messageId: meta.messageId || ''
  }) + '\n');
}

/** 读出 id → 原文。 */
export function loadCaptured(dataDir) {
  const map = new Map();
  const file = capturedPath(dataDir);
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || !entry.id || typeof entry.text !== 'string') continue;
    map.set(entry.id, entry.text);
  }
  return map;
}
