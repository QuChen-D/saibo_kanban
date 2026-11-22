/**
 * saibo_kanban — AI 与人共用的活看板。
 *
 * 0.2.0：注册六个积木级工具，数据落在 $DSH_HOME/saibo_kanban/records.jsonl。
 * 界面（收件箱/看板/表格）在 0.3.0 接入，共用同一份 core 与 store。
 */
import { Store, defaultDataDir } from './store.js';
import { createTools } from './tools.js';
import { normalizeKinds } from './core.js';

export const inject = ['tools'];

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  const dataDir = typeof settings.dataDir === 'string' && settings.dataDir.trim()
    ? settings.dataDir
    : defaultDataDir();
  const kinds = normalizeKinds(settings.kinds);
  const store = new Store({ dataDir, kinds }).load();
  const tools = createTools(store, {
    kinds,
    maxBriefChars: Number.isFinite(settings.maxBriefChars) ? settings.maxBriefChars : 4000
  });

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `saibo_kanban: ${tool.name}`);
  }
}
