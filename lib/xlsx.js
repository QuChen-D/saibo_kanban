/**
 * xlsx.js — 零依赖的最小 XLSX 读取器。
 *
 * 只做导入需要的事：读 ZIP 中央目录，拿 sharedStrings 和工作表 XML，
 * 还原成二维数组。支持内联字符串、共享字符串、数字、布尔和公式缓存值。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

function findEocd(buf) {
  const start = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error('不是有效的 xlsx（找不到 ZIP 目录）');
}

function readEntries(buf) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readFile(buf, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== LOC) throw new Error(`ZIP 本地头损坏: ${name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error(`不支持的压缩方式 ${entry.method}: ${name}`);
}

const decode = s => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

function xmlText(xml) {
  const parts = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) parts.push(decode(m[1]));
  return parts.join('');
}

function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(xmlText(m[1]));
  return out;
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowIndex = Number(rm[1]) - 1;
    const cells = [];
    const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rm[2])) !== null) {
      const attrs = cm[1];
      const body = cm[2];
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
      const idx = refMatch ? colIndex(refMatch[1]) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs);
      let value = '';
      if (type && type[1] === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? (shared[Number(v[1])] ?? '') : '';
      } else if (type && type[1] === 'inlineStr') {
        value = xmlText(body);
      } else if (type && (type[1] === 'str' || type[1] === 'b')) {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? decode(v[1]) : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? decode(v[1]) : '';
      }
      cells[idx] = value;
    }
    rows[rowIndex] = cells;
  }
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  return rows;
}

/** 读取工作簿，返回 [{ name, rows }]，rows 为二维字符串数组。 */
export function readXlsx(file) {
  const buf = fs.readFileSync(file);
  const entries = readEntries(buf);
  const shared = readSharedStrings(readFile(buf, entries, 'xl/sharedStrings.xml'));
  const workbook = readFile(buf, entries, 'xl/workbook.xml');
  const rels = readFile(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('缺少 workbook.xml 或 rels');

  const relMap = new Map();
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  let rm;
  while ((rm = relRe.exec(rels)) !== null) {
    relMap.set(rm[1], rm[2].replace(/^\/?xl\//, ''));
  }

  const sheets = [];
  const sheetRe = /<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
  let sm;
  while ((sm = sheetRe.exec(workbook)) !== null) {
    const name = decode(sm[1]);
    const target = relMap.get(sm[2]);
    if (!target) continue;
    const xml = readFile(buf, entries, 'xl/' + target);
    if (!xml) continue;
    sheets.push({ name, rows: readSheet(xml, shared) });
  }
  return sheets;
}
