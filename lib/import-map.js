/**
 * import-map.js — xlsx 工作表 → 看板条目的映射规则。
 *
 * CLI 和页面共用这一份，避免两边规则漂移。
 */
import { STATUSES } from '../core.js';

export const STATUS_MAP = {
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

export function mapMain(rows) {
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
    out.push({
      title,
      body: [
        cell(rows[i], cBody),
        cell(rows[i], cId) ? `编号：${cell(rows[i], cId)}` : '',
        cell(rows[i], cType) ? `类型：${cell(rows[i], cType)}` : ''
      ].filter(Boolean).join('\n'),
      kind: 'task',
      scope: cell(rows[i], cGroup),
      status: STATUS_MAP[cell(rows[i], cStatus)] || 'done',
      archived: false,
      ext: cell(rows[i], cId)
    });
  }
  return out;
}

export function mapRolling(rows) {
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
    out.push({
      title,
      body: [
        cell(rows[i], cBody),
        cell(rows[i], cId) ? `编号：${cell(rows[i], cId)}` : '',
        cell(rows[i], cPri) ? `优先级：${cell(rows[i], cPri)}` : '',
        cell(rows[i], cRoll) ? `滚动次数：${cell(rows[i], cRoll)}` : '',
        cell(rows[i], cFirst) ? `首次来源：${cell(rows[i], cFirst)}` : '',
        cell(rows[i], cLast) ? `最近来源：${cell(rows[i], cLast)}` : ''
      ].filter(Boolean).join('\n'),
      kind: 'task',
      scope: cell(rows[i], cGroup),
      status: STATUS_MAP[cell(rows[i], cStatus)] || 'todo',
      archived: false,
      ext: cell(rows[i], cId)
    });
  }
  return out;
}

export function mapNotes(rows) {
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

/** 把工作簿整理成待导入集合。 */
export function buildImport(sheets) {
  const byName = new Map(sheets.map(s => [s.name, s.rows]));
  const mainRows = byName.get('任务主表') || sheets[0]?.rows || [];
  const rollingRows = byName.get('长期滚动项') || sheets[1]?.rows || [];
  const notesRows = byName.get('节点说明') || sheets[2]?.rows || [];
  return {
    main: mapMain(mainRows),
    rolling: mapRolling(rollingRows),
    notes: mapNotes(notesRows)
  };
}

export function describeImport({ main, rolling, notes }) {
  const byStatus = {};
  for (const item of rolling) {
    const label = statusLabel(item.status);
    byStatus[label] = (byStatus[label] || 0) + 1;
  }
  return {
    main: main.length,
    rolling: rolling.length,
    notes: notes ? 1 : 0,
    byStatus,
    samples: rolling.slice(0, 5).map(r => ({ title: r.title, scope: r.scope, status: r.status }))
  };
}
