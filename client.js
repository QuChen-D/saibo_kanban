window.__ModuleLoader__.load({
  id: 'saibo-kanban',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;

    const KINDS = [
      { id: 'task', label: '任务' },
      { id: 'decision', label: '决策' },
      { id: 'pitfall', label: '踩坑' },
      { id: 'design', label: '设计' }
    ];
    const STATUSES = [
      { id: 'backlog', label: '待规划' },
      { id: 'todo', label: '待办' },
      { id: 'in_progress', label: '进行中' },
      { id: 'in_review', label: '待验收' },
      { id: 'done', label: '已完成' },
      { id: 'blocked', label: '受阻' }
    ];
    const SCOPES = ['看板插件', '存储', '表单', '导入', '编排', '记忆'];
    const kindLabel = id => (KINDS.find(k => k.id === id) || { label: id }).label;
    const statusLabel = id => (STATUSES.find(s => s.id === id) || { label: id }).label;

    async function api(method, args) {
      const res = await fetch('/saibo-kanban/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args: args || {} })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '请求失败');
      return data.result;
    }

    const CSS = `
      .sk { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base,#f6f7f9); color:var(--dsw-alias-label-primary,#17181a); font-size:13.5px; }
      .sk * { box-sizing:border-box; }
      .sk-head { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--dsw-alias-border-l1,#e6e7eb); background:var(--dsw-alias-bg-layer-1,#fff); flex:none; }
      .sk-title { font-weight:650; font-size:15px; }
      .sk-tabs { display:flex; gap:2px; padding:3px; border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:9px; background:var(--dsw-alias-bg-layer-2,#fbfbfc); }
      .sk-tab { border:0; background:transparent; color:var(--dsw-alias-label-secondary,#6b7280); padding:5px 12px; border-radius:7px; font:inherit; font-weight:550; cursor:pointer; }
      .sk-tab.on { background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#17181a); box-shadow:0 1px 2px rgba(16,24,40,.08); }
      .sk-search { margin-left:auto; width:min(280px,30vw); padding:6px 10px; border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:8px; background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; font:inherit; outline:none; }
      .sk-search:focus { border-color:var(--dsw-alias-brand-primary,#2563eb); }
      .sk-btn { border:1px solid var(--dsw-alias-border-l1,#e6e7eb); background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; border-radius:7px; padding:5px 11px; font:inherit; font-size:12.5px; font-weight:550; cursor:pointer; }
      .sk-btn:hover { border-color:var(--dsw-alias-border-l2,#c9ccd3); }
      .sk-btn.primary { background:var(--dsw-alias-brand-primary,#2563eb); border-color:var(--dsw-alias-brand-primary,#2563eb); color:#fff; }
      .sk-btn.danger { color:var(--dsw-alias-state-error-primary,#dc2626); }
      .sk-body { flex:1; min-height:0; overflow:auto; padding:14px 18px 40px; }
      .sk-quick { display:flex; gap:8px; align-items:center; margin-bottom:12px; background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:10px; padding:8px 12px; }
      .sk-quick input { flex:1; border:0; outline:none; background:transparent; color:inherit; font:inherit; padding:4px; }
      .sk-quick .sk-k { color:var(--dsw-alias-label-secondary,#6b7280); font-size:12px; }
      .sk-panel { background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:10px; overflow:hidden; }
      .sk-row { display:flex; align-items:center; gap:10px; padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l1,#f0f1f4); }
      .sk-row:first-child { border-top:0; }
      .sk-row:hover { background:var(--dsw-alias-bg-layer-2,#fbfbfc); }
      .sk-id { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b7280); width:86px; flex:none; }
      .sk-name { flex:1; min-width:140px; cursor:text; border-radius:5px; padding:2px 4px; margin:-2px -4px; }
      .sk-name:hover { background:var(--dsw-alias-bg-layer-2,#f3f4f6); }
      .sk-name input { width:100%; border:1px solid var(--dsw-alias-brand-primary,#2563eb); border-radius:5px; padding:2px 4px; background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; font:inherit; outline:none; }
      .sk-sel { border:1px solid transparent; background:transparent; color:inherit; font:inherit; font-size:12px; border-radius:6px; padding:3px 4px; cursor:pointer; max-width:110px; }
      .sk-sel:hover { border-color:var(--dsw-alias-border-l1,#e6e7eb); background:var(--dsw-alias-bg-layer-1,#fff); }
      .sk-rev { width:44px; flex:none; text-align:right; font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b7280); }
      .sk-board { display:grid; grid-template-columns:repeat(6,minmax(160px,1fr)); gap:10px; align-items:start; }
      .sk-col { background:var(--dsw-alias-bg-layer-2,#f3f4f6); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:10px; min-height:110px; }
      .sk-col-head { display:flex; align-items:center; gap:6px; padding:9px 11px; font-weight:600; font-size:12.5px; color:var(--dsw-alias-label-secondary,#6b7280); border-bottom:1px solid var(--dsw-alias-border-l1,#e6e7eb); }
      .sk-col-body { padding:7px; display:flex; flex-direction:column; gap:7px; min-height:70px; }
      .sk-col.over { outline:2px dashed var(--dsw-alias-brand-primary,#2563eb); outline-offset:-3px; }
      .sk-card { background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:9px; padding:8px 10px; cursor:grab; }
      .sk-card .t { font-weight:550; line-height:1.4; font-size:13px; }
      .sk-card .m { margin-top:5px; display:flex; gap:6px; color:var(--dsw-alias-label-secondary,#6b7280); font-size:11.5px; }
      .sk-drawer { position:absolute; top:0; right:0; bottom:0; width:min(460px,92%); background:var(--dsw-alias-bg-layer-1,#fff); border-left:1px solid var(--dsw-alias-border-l1,#e6e7eb); box-shadow:-8px 0 24px rgba(16,24,40,.08); display:flex; flex-direction:column; z-index:5; }
      .sk-drawer-head { display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--dsw-alias-border-l1,#e6e7eb); }
      .sk-drawer-body { flex:1; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:12px; }
      .sk-field { display:flex; flex-direction:column; gap:4px; }
      .sk-field label { font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b7280); }
      .sk-field input, .sk-field select, .sk-field textarea { border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:7px; padding:6px 8px; background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; font:inherit; outline:none; width:100%; }
      .sk-field textarea { min-height:90px; resize:vertical; }
      .sk-hist { border-top:1px solid var(--dsw-alias-border-l1,#e6e7eb); padding-top:8px; }
      .sk-hist h4 { margin:0 0 6px; font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b7280); font-weight:600; }
      .sk-h { display:flex; gap:8px; align-items:baseline; padding:6px 0; border-bottom:1px dashed var(--dsw-alias-border-l1,#f0f1f4); font-size:12px; }
      .sk-h .by { font-weight:600; }
      .sk-h .chg { color:var(--dsw-alias-label-secondary,#6b7280); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sk-toast { position:absolute; left:50%; bottom:18px; transform:translateX(-50%); background:var(--dsw-alias-label-primary,#17181a); color:var(--dsw-alias-bg-base,#fff); padding:8px 14px; border-radius:9px; font-size:12.5px; z-index:9; }
      .sk-empty { padding:40px; text-align:center; color:var(--dsw-alias-label-secondary,#6b7280); }
      .sk-rail { display:flex; align-items:center; justify-content:center; }
    `;

    function Panel() {
      const [items, setItems] = useState([]);
      const [view, setView] = useState('table');
      const [query, setQuery] = useState('');
      const [error, setError] = useState('');
      const [detail, setDetail] = useState(null);
      const [editing, setEditing] = useState(null);
      const [draft, setDraft] = useState('');
      const [overCol, setOverCol] = useState(null);
      const [toast, setToast] = useState('');
      const [busy, setBusy] = useState(false);
      const toastTimer = useRef(null);

      const say = useCallback(msg => {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 2600);
      }, []);

      const load = useCallback(async () => {
        try {
          const r = await api('list');
          setItems(r.items);
          setError('');
        } catch (e) { setError(e.message); }
      }, []);

      useEffect(() => { load(); }, [load]);

      const run = useCallback(async (fn, ok) => {
        setBusy(true);
        try { await fn(); await load(); if (ok) say(ok); }
        catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }, [load, say]);

      const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter(i => (i.title + ' ' + i.id + ' ' + (i.scope || '')).toLowerCase().includes(q));
      }, [items, query]);

      const openDetail = useCallback(async id => {
        try { setDetail(await api('get', { id })); }
        catch (e) { setError(e.message); }
      }, []);

      const update = useCallback((id, rev, patch) => run(
        () => api('update', { id, expectedRev: rev, patch }),
        '已保存'
      ), [run]);

      const create = useCallback(title => {
        const t = title.trim();
        if (!t) return;
        run(() => api('create', { title: t }), '已新建');
      }, [run]);

      const setStatus = useCallback((item, status) => {
        if (item.status === status) return;
        update(item.id, item.rev, { status });
      }, [update]);

      const commitTitle = useCallback((item) => {
        const v = draft.trim();
        setEditing(null);
        if (v && v !== item.title) update(item.id, item.rev, { title: v });
      }, [draft, update]);

      const head = h('div', { className: 'sk-head' },
        h('span', { className: 'sk-title' }, '看板'),
        h('div', { className: 'sk-tabs' },
          ['inbox', 'board', 'table'].map(v => h('button', {
            key: v, className: 'sk-tab' + (view === v ? ' on' : ''),
            onClick: () => setView(v)
          }, v === 'inbox' ? '收件箱' : v === 'board' ? '看板' : '表格'))
        ),
        h('input', {
          className: 'sk-search', placeholder: '搜索标题 / 编号 / 范围',
          value: query, onChange: e => setQuery(e.target.value)
        })
      );

      const quick = h('div', { className: 'sk-quick' },
        h('span', { className: 'sk-k' }, '＋'),
        h('input', {
          placeholder: '快加一条（回车新建）',
          onKeyDown: e => { if (e.key === 'Enter') { create(e.currentTarget.value); e.currentTarget.value = ''; } }
        })
      );

      let content = null;
      if (view === 'table') {
        content = h('div', null,
          quick,
          h('div', { className: 'sk-panel' },
            visible.length === 0 ? h('div', { className: 'sk-empty' }, '还没有条目。跟 agent 说“记一条…”，或在上面的输入框快加。') :
            visible.map(item => h('div', { key: item.id, className: 'sk-row' },
              h('span', { className: 'sk-id' }, item.id),
              h('div', {
                className: 'sk-name',
                onClick: () => { setEditing(item.id); setDraft(item.title); }
              }, editing === item.id ? h('input', {
                autoFocus: true, value: draft,
                onChange: e => setDraft(e.target.value),
                onBlur: () => commitTitle(item),
                onKeyDown: e => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditing(null);
                }
              }) : item.title),
              h('select', {
                className: 'sk-sel', value: item.kind,
                onChange: e => update(item.id, item.rev, { kind: e.target.value })
              }, KINDS.map(k => h('option', { key: k.id, value: k.id }, k.label))),
              h('select', {
                className: 'sk-sel', value: item.status,
                onChange: e => setStatus(item, e.target.value)
              }, STATUSES.map(s => h('option', { key: s.id, value: s.id }, s.label))),
              h('select', {
                className: 'sk-sel', value: item.scope || '',
                onChange: e => update(item.id, item.rev, { scope: e.target.value })
              }, h('option', { value: '' }, '范围'), SCOPES.map(s => h('option', { key: s, value: s }, s))),
              h('span', { className: 'sk-rev' }, 'r' + item.rev),
              h('button', { className: 'sk-btn', onClick: () => openDetail(item.id) }, '详情')
            ))
          )
        );
      } else if (view === 'board') {
        content = h('div', null,
          quick,
          h('div', { className: 'sk-board' },
            STATUSES.map(s => {
              const list = visible.filter(i => i.status === s.id);
              return h('div', {
                key: s.id,
                className: 'sk-col' + (overCol === s.id ? ' over' : ''),
                onDragOver: e => { e.preventDefault(); setOverCol(s.id); },
                onDragLeave: () => setOverCol(c => c === s.id ? null : c),
                onDrop: e => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData('text/plain');
                  const item = items.find(i => i.id === id);
                  setOverCol(null);
                  if (item) setStatus(item, s.id);
                }
              },
              h('div', { className: 'sk-col-head' }, s.label, h('span', { style: { marginLeft: 'auto' } }, String(list.length))),
              h('div', { className: 'sk-col-body' },
                list.map(item => h('div', {
                  key: item.id, className: 'sk-card', draggable: true,
                  onDragStart: e => e.dataTransfer.setData('text/plain', item.id),
                  onDoubleClick: () => openDetail(item.id)
                },
                h('div', { className: 't' }, item.title),
                h('div', { className: 'm' },
                  h('span', null, kindLabel(item.kind)),
                  h('span', null, item.scope || '未定范围'),
                  h('span', { style: { marginLeft: 'auto' } }, 'r' + item.rev)
                )))
              ));
            })
          )
        );
      } else {
        const recent = visible.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 30);
        content = h('div', null,
          quick,
          h('div', { className: 'sk-panel' },
            recent.length === 0 ? h('div', { className: 'sk-empty' }, '还没有条目。') :
            recent.map(item => h('div', { key: item.id, className: 'sk-row' },
              h('span', { className: 'sk-id' }, item.id),
              h('span', { style: { flex: 1, fontWeight: 550 } }, item.title),
              h('span', { style: { color: 'var(--dsw-alias-label-secondary,#6b7280)', fontSize: 12 } },
                statusLabel(item.status) + ' · ' + kindLabel(item.kind) + (item.scope ? ' · ' + item.scope : '')),
              h('span', { className: 'sk-rev' }, 'r' + item.rev),
              h('button', { className: 'sk-btn', onClick: () => openDetail(item.id) }, '查看')
            ))
          )
        );
      }

      const drawer = detail ? h('div', { className: 'sk-drawer' },
        h('div', { className: 'sk-drawer-head' },
          h('span', { className: 'sk-id' }, detail.item.id),
          h('span', { style: { fontWeight: 600, flex: 1 } }, '条目详情'),
          h('button', { className: 'sk-btn', onClick: () => setDetail(null) }, '关闭')
        ),
        h('div', { className: 'sk-drawer-body' },
          h('div', { className: 'sk-field' }, h('label', null, '标题'),
            h('input', {
              key: detail.item.id + ':' + detail.item.rev,
              defaultValue: detail.item.title,
              onBlur: e => {
                const v = e.target.value.trim();
                if (v && v !== detail.item.title) update(detail.item.id, detail.item.rev, { title: v });
              }
            })),
          h('div', { className: 'sk-field' }, h('label', null, '内容'),
            h('textarea', {
              key: detail.item.id + ':' + detail.item.rev + ':body',
              defaultValue: detail.item.body || '',
              onBlur: e => {
                if (e.target.value !== (detail.item.body || '')) update(detail.item.id, detail.item.rev, { body: e.target.value });
              }
            })),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('select', {
              className: 'sk-sel', value: detail.item.status,
              onChange: e => setStatus(detail.item, e.target.value)
            }, STATUSES.map(s => h('option', { key: s.id, value: s.id }, s.label))),
            h('select', {
              className: 'sk-sel', value: detail.item.kind,
              onChange: e => update(detail.item.id, detail.item.rev, { kind: e.target.value })
            }, KINDS.map(k => h('option', { key: k.id, value: k.id }, k.label))),
            h('select', {
              className: 'sk-sel', value: detail.item.scope || '',
              onChange: e => update(detail.item.id, detail.item.rev, { scope: e.target.value })
            }, h('option', { value: '' }, '范围'), SCOPES.map(s => h('option', { key: s, value: s }, s))),
            h('button', {
              className: 'sk-btn danger',
              onClick: () => run(() => api('archive', { id: detail.item.id }), '已归档').then(() => setDetail(null))
            }, '归档')
          ),
          h('div', { className: 'sk-hist' },
            h('h4', null, '修订历史（点“回滚”回到那一版）'),
            detail.history.slice().reverse().map(ev => h('div', { key: ev.rev, className: 'sk-h' },
              h('span', { className: 'by' }, ev.by === 'human' ? '人' : 'AI'),
              h('span', null, 'r' + ev.rev),
              h('span', { className: 'chg' }, summarize(ev)),
              h('button', {
                className: 'sk-btn',
                onClick: () => api('rollback', { id: detail.item.id, rev: ev.rev })
                  .then(() => api('get', { id: detail.item.id }))
                  .then(d => { setDetail(d); return load(); })
                  .then(() => say('已回滚到 r' + ev.rev))
                  .catch(e => setError(e.message))
              }, '回滚')
            ))
          )
        )
      ) : null;

      return h('div', { className: 'sk', style: { position: 'relative' } },
        h('style', null, CSS),
        head,
        h('div', { className: 'sk-body' }, error ? h('div', { className: 'sk-empty', style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, error) : content),
        drawer,
        toast ? h('div', { className: 'sk-toast' }, toast) : null
      );
    }

    function summarize(ev) {
      if (!ev.changes) return '';
      return Object.keys(ev.changes).map(k => {
        const c = ev.changes[k];
        return k + ': ' + String(c.from || '∅') + ' → ' + String(c.to || '∅');
      }).join('；');
    }

    function RailIcon(props) {
      const size = props && props.size ? props.size : 18;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'
      },
      h('rect', { x: 3, y: 4, width: 5, height: 16, rx: 1.2 }),
      h('rect', { x: 10, y: 4, width: 5, height: 16, rx: 1.2 }),
      h('rect', { x: 17, y: 4, width: 4, height: 16, rx: 1.2 }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'saibo-kanban', order: 6, label: '看板'
        }, props => h('span', { className: 'sk-rail' }, h(RailIcon, props))));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'saibo-kanban'
        }, Panel));
      }
    };
  }
});
