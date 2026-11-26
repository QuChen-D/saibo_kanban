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

    /** 正文去掉元数据行，保留换行。列表里截一段直接显示，不用悬浮或点开。 */
    function displayContent(body) {
      if (!body) return '—';
      const meta = /^(编号|类型|优先级|滚动次数|首次来源|最近来源|来源)：/;
      const real = String(body).split('\n').map(s => s.trim()).filter(Boolean).filter(l => !meta.test(l));
      const text = real.join('\n').trim();
      if (!text) return '—';
      return text.length > 400 ? text.slice(0, 400) + '…' : text;
    }

    function toBase64(buf) {
      const bytes = new Uint8Array(buf);
      let s = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(s);
    }

    async function api(method, args) {      const res = await fetch('/saibo-kanban/api', {
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
      .sk-row { display:flex; align-items:center; gap:8px; padding:6px 10px; border-top:1px solid var(--dsw-alias-border-l1,#f0f1f4); }
      .sk-row:first-child { border-top:0; }
      .sk-row:hover { background:var(--dsw-alias-bg-layer-2,#fbfbfc); }
      .sk-id { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b7280); width:86px; flex:none; }
      .sk-name { flex:0 0 260px; max-width:260px; cursor:text; border-radius:5px; padding:2px 4px; margin:-2px -4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .sk-content { flex:1 1 auto; min-width:0; font-size:12.5px; color:var(--dsw-alias-label-secondary,#6b7280); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; padding:2px 4px; }
      .sk-body-text { white-space:pre-wrap; overflow:hidden; text-overflow:ellipsis; background:var(--dsw-alias-bg-layer-2,#f7f8fa); border:1px dashed var(--dsw-alias-border-l1,#e6e7eb); border-radius:7px; padding:7px 10px; font-size:12.5px; line-height:1.5; cursor:pointer; }
      .sk-card-body { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary,#6b7280); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.5; }
      .sk-name:hover { background:var(--dsw-alias-bg-layer-2,#f3f4f6); }
      .sk-name input { width:100%; border:1px solid var(--dsw-alias-brand-primary,#2563eb); border-radius:5px; padding:2px 4px; background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; font:inherit; outline:none; }
      .sk-sel { border:1px solid transparent; background:transparent; color:inherit; font:inherit; font-size:12px; border-radius:6px; padding:3px 4px; cursor:pointer; max-width:110px; }
      .sk-sel:hover { border-color:var(--dsw-alias-border-l1,#e6e7eb); background:var(--dsw-alias-bg-layer-1,#fff); }
      .sk-rev { width:48px; flex:none; text-align:right; font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b7280); }
      .sk-num { width:36px; flex:none; text-align:right; font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b7280); }
      .sk-th { background:var(--dsw-alias-bg-layer-2,#f7f8fa); font-size:11.5px; font-weight:600; color:var(--dsw-alias-label-secondary,#6b7280); position:sticky; top:0; z-index:1; }
      .sk-filter { background:var(--dsw-alias-bg-layer-2,#fbfbfc); border-bottom:1px solid var(--dsw-alias-border-l1,#e6e7eb); padding:4px 12px; gap:8px; }
      .sk-col-k { width:84px; flex:none; }
      .sk-col-s { width:100px; flex:none; }
      .sk-col-sc { width:140px; flex:none; }
      .sk-detail-btn { white-space:nowrap; min-width:52px; padding:4px 8px; font-size:12px; }
      .sk-row.arch { opacity:.6; }
      .sk-badge { margin-left:6px; font-size:10.5px; color:var(--dsw-alias-label-secondary,#6b7280); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:999px; padding:0 6px; vertical-align:1px; }
      .sk-board { display:grid; grid-template-columns:repeat(6,minmax(160px,1fr)); gap:10px; align-items:start; }
      .sk-col { background:var(--dsw-alias-bg-layer-2,#f3f4f6); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:10px; min-height:110px; }
      .sk-col-head { display:flex; align-items:center; gap:6px; padding:9px 11px; font-weight:600; font-size:12.5px; color:var(--dsw-alias-label-secondary,#6b7280); border-bottom:1px solid var(--dsw-alias-border-l1,#e6e7eb); }
      .sk-col-body { padding:7px; display:flex; flex-direction:column; gap:7px; min-height:70px; }
      .sk-col.over { outline:2px dashed var(--dsw-alias-brand-primary,#2563eb); outline-offset:-3px; }
      .sk-card { background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:9px; padding:8px 10px; cursor:grab; position:relative; }
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
      .sk-modal { position:absolute; inset:0; background:rgba(15,18,25,.35); display:flex; align-items:center; justify-content:center; z-index:8; }
      .sk-dialog { width:min(520px,92%); background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:12px; box-shadow:0 18px 48px rgba(16,24,40,.22); padding:16px; display:flex; flex-direction:column; gap:10px; }
      .sk-dialog h3 { margin:0; font-size:15px; }
      .sk-dialog .hint { color:var(--dsw-alias-label-secondary,#6b7280); font-size:12px; line-height:1.6; }
      .sk-dialog .row { display:flex; gap:8px; justify-content:flex-end; }
      .sk-dialog input[type=file] { font:inherit; font-size:12.5px; }
      .sk-kv { display:flex; gap:12px; flex-wrap:wrap; font-size:12.5px; }
      .sk-kv b { font-weight:650; }
    `;

    function Panel() {
      const [items, setItems] = useState([]);
      const [view, setView] = useState('table');
      const [fStatus, setFStatus] = useState('');
      const [fKind, setFKind] = useState('');
      const [fScope, setFScope] = useState('');
      const [visibleCount, setVisibleCount] = useState(100);
      const sentinelRef = useRef(null);
      const [query, setQuery] = useState('');
      const [error, setError] = useState('');
      const [detail, setDetail] = useState(null);
      const [bodyEditing, setBodyEditing] = useState(false);
      const [editing, setEditing] = useState(null);
      const [draft, setDraft] = useState('');
      const [overCol, setOverCol] = useState(null);
      const [toast, setToast] = useState('');
      const [busy, setBusy] = useState(false);
      const [imp, setImp] = useState(null);
      const [impBusy, setImpBusy] = useState(false);
      const [impError, setImpError] = useState('');
      const [del, setDel] = useState(null);
      const fileRef = useRef(null);
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
        return items.filter(i => {
          if (fStatus && i.status !== fStatus) return false;
          if (fKind && i.kind !== fKind) return false;
          if (fScope && (i.scope || '') !== fScope) return false;
          if (!q) return true;
          return (i.title + ' ' + (i.scope || '') + ' ' + i.id).toLowerCase().includes(q);
        });
      }, [items, query, fStatus, fKind, fScope]);

      const scopeOptions = useMemo(() => {
        const set = new Set();
        for (const i of items) if (i.scope) set.add(i.scope);
        return [...set].sort();
      }, [items]);

      useEffect(() => { setVisibleCount(100); }, [query, fStatus, fKind, fScope, view]);

      useEffect(() => {
        if (view !== 'table') return undefined;
        const el = sentinelRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return undefined;
        const io = new IntersectionObserver(entries => {
          if (entries.some(e => e.isIntersecting)) {
            setVisibleCount(c => Math.min(c + 100, visible.length));
          }
        });
        io.observe(el);
        return () => io.disconnect();
      }, [view, visible.length, visibleCount]);

      const openDetail = useCallback(async id => {
        setBodyEditing(false);
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
        run(() => api('create', {
          title: t,
          scope: fScope || '',
          status: fStatus || 'backlog'
        }), '已新建');
      }, [run, fScope, fStatus]);

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
        }),
        h('button', { className: 'sk-btn', onClick: () => fileRef.current && fileRef.current.click() }, '导入 xlsx'),
        h('input', {
          ref: fileRef, type: 'file', accept: '.xlsx', style: { display: 'none' },
          onChange: async e => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            setImpBusy(true); setImpError('');
            try {
              const buf = await file.arrayBuffer();
              const data = toBase64(buf);
              const r = await api('import.preview', { data });
              setImp({ name: file.name, data, summary: r.summary });
            } catch (err) {
              setImp({ name: file.name, data: null, summary: null, error: err.message });
            } finally { setImpBusy(false); }
          }
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
        const shown = visible.slice(0, visibleCount);
        content = h('div', null,
          h('div', { className: 'sk-quick' },
            h('span', { className: 'sk-k' }, '＋'),
            h('input', {
              placeholder: '快加一条（回车新建）',
              onKeyDown: e => { if (e.key === 'Enter') { create(e.currentTarget.value); e.currentTarget.value = ''; } }
            }),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary,#6b7280)', fontSize: 12, whiteSpace: 'nowrap' } },
              '共 ' + visible.length + ' 条' + (visible.length > shown.length ? ' · 已显示 ' + shown.length : ''))
          ),
          h('div', { className: 'sk-panel' },
            h('div', { className: 'sk-row sk-th' },
              h('span', { className: 'sk-num' }, '#'),
              h('span', { className: 'sk-name', style: { cursor: 'default' } }, '标题'),
              h('span', { className: 'sk-content', style: { cursor: 'default' } }, '内容'),
              h('select', {
                className: 'sk-sel sk-col-k', value: fKind,
                onChange: e => setFKind(e.target.value)
              }, h('option', { value: '' }, '类型'), KINDS.map(k => h('option', { key: k.id, value: k.id }, k.label))),
              h('select', {
                className: 'sk-sel sk-col-s', value: fStatus,
                onChange: e => setFStatus(e.target.value)
              }, h('option', { value: '' }, '状态'), STATUSES.map(s => h('option', { key: s.id, value: s.id }, s.label))),
              h('select', {
                className: 'sk-sel sk-col-sc', value: fScope,
                onChange: e => setFScope(e.target.value)
              }, h('option', { value: '' }, '范围'), scopeOptions.map(s => h('option', { key: s, value: s }, s))),
              h('span', { className: 'sk-rev' }, '修订'),
              h('span', { style: { width: 112 } }, '')
            ),
            visible.length === 0 ? h('div', { className: 'sk-empty' }, '没有匹配的条目。跟 agent 说“记一条…”，或在上面的输入框快加。') :
            shown.map((item, index) => h('div', { key: item.id, className: 'sk-row' },
              h('span', { className: 'sk-num' }, String(index + 1)),
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
              h('div', {
                className: 'sk-content',
                title: item.body || '',
                onClick: () => openDetail(item.id)
              }, item.body ? displayContent(item.body) : '—'),
              h('select', {
                className: 'sk-sel sk-col-k', value: item.kind,
                onChange: e => update(item.id, item.rev, { kind: e.target.value })
              }, KINDS.map(k => h('option', { key: k.id, value: k.id }, k.label))),
              h('select', {
                className: 'sk-sel sk-col-s', value: item.status,
                onChange: e => setStatus(item, e.target.value)
              }, STATUSES.map(s => h('option', { key: s.id, value: s.id }, s.label))),
              h('select', {
                className: 'sk-sel sk-col-sc', value: item.scope || '',
                onChange: e => update(item.id, item.rev, { scope: e.target.value })
              }, h('option', { value: '' }, '未定'), scopeOptions.map(s => h('option', { key: s, value: s }, s))),
              h('span', { className: 'sk-rev' }, 'r' + item.rev),
              h('div', { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
                h('button', { className: 'sk-btn sk-detail-btn', onClick: () => openDetail(item.id) }, '详情'),
                h('button', {
                  className: 'sk-btn sk-detail-btn danger',
                  title: '物理删除（只在条目本身搞错了时用，删了不能恢复）',
                  onClick: () => setDel(item)
                }, '删')
              )
            )),
            h('div', { ref: sentinelRef, style: { height: 1 } }),
            visible.length > shown.length ? h('div', { style: { padding: 10 } },
              h('button', { className: 'sk-btn', onClick: () => setVisibleCount(c => c + 100) },
                '加载更多（' + shown.length + ' / ' + visible.length + '）')) : null
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
                item.body ? h('div', { className: 'sk-card-body' }, displayContent(item.body)) : null,
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
          h('div', { className: 'sk-field' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('label', { style: { flex: 1 } }, '内容'),
              h('button', {
                className: 'sk-btn',
                onClick: () => setBodyEditing(value => !value)
              }, bodyEditing ? '完成' : '编辑正文')),
            bodyEditing
              ? h('textarea', {
                key: detail.item.id + ':' + detail.item.rev + ':body',
                rows: 3,
                maxLength: 80,
                defaultValue: detail.item.body || '',
                placeholder: '一句话结论，80 字以内（换行会在保存时合并）',
                onBlur: e => {
                  const value = e.target.value.trim();
                  if (value !== (detail.item.body || '')) update(detail.item.id, detail.item.rev, { body: value });
                }
              })
              : h('div', {
                className: 'sk-body-text',
                title: detail.item.body || '',
                onClick: () => setBodyEditing(true)
              }, detail.item.body ? displayContent(detail.item.body) : '（空，点一下写一句）')),
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
            }, h('option', { value: '' }, '未定'), scopeOptions.map(s => h('option', { key: s, value: s }, s)))
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
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1,#e6e7eb)' } },
            h('button', { className: 'sk-btn danger', onClick: () => setDel(detail.item) }, '删除这条'))
        )
      ) : null;

      const deleteDialog = del ? h('div', { className: 'sk-modal' },
        h('div', { className: 'sk-dialog' },
          h('h3', null, '删除这条？'),
          h('div', { className: 'sk-kv' }, h('span', null, del.title)),
          h('div', { className: 'hint' }, '物理删除：这条的所有修订会从 records.jsonl 里一起删掉，不能恢复。只在这条本身搞错了（写错、重复）时用；只是不用了，请改状态或用取代。'),
          h('div', { className: 'row' },
            h('button', { className: 'sk-btn', onClick: () => setDel(null) }, '取消'),
            h('button', {
              className: 'sk-btn danger',
              disabled: busy,
              onClick: async () => {
                const target = del;
                setDel(null);
                if (detail && detail.item.id === target.id) setDetail(null);
                await run(() => api('delete', { id: target.id }), '已删除「' + target.title + '」');
              }
            }, '删除')
          )
        )
      ) : null;

      const importDialog = imp ? h('div', { className: 'sk-modal' },
        h('div', { className: 'sk-dialog' },
          h('h3', null, '导入 ' + (imp.name || 'xlsx')),
          imp.error ? h('div', { className: 'hint', style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, imp.error) : null,
          imp.summary ? h('div', { className: 'sk-kv' },
            h('span', null, '主表 ', h('b', null, String(imp.summary.main)), ' 条'),
            h('span', null, '滚动项 ', h('b', null, String(imp.summary.rolling)), ' 条（活跃）'),
            h('span', null, '节点说明 ', h('b', null, String(imp.summary.notes)), ' 条')
          ) : h('div', { className: 'hint' }, impBusy ? '解析中…' : ''),
          imp.summary ? h('div', { className: 'hint' },
            Object.entries(imp.summary.byStatus || {}).map(([k, v]) => k + ' ' + v).join(' · ')) : null,
          h('div', { className: 'row' },
            h('button', { className: 'sk-btn', onClick: () => { setImp(null); setImpError(''); } }, '取消'),
            imp.summary ? h('button', {
              className: 'sk-btn primary',
              onClick: async () => {
                setImpBusy(true); setImpError('');
                try {
                  const r = await api('import.apply', { data: imp.data });
                  setImp(null); await load();
                  say('已导入 ' + r.imported + ' 条，跳过重复 ' + r.skipped + ' 条');
                } catch (err) { setImpError(err.message); }
                finally { setImpBusy(false); }
              }
            }, impBusy ? '导入中…' : '确认导入') : null
          )
        )
      ) : null;

      return h('div', { className: 'sk', style: { position: 'relative' } },
        h('style', null, CSS),
        head,
        h('div', { className: 'sk-body' }, error ? h('div', { className: 'sk-empty', style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, error) : content),
        importDialog,
        deleteDialog,
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

    const RECALL_CSS = `
      .skrc-wrap { display:inline-flex; align-items:center; }
      .skrc-btn { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--dsw-alias-border-l1,#e6e7eb); background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-secondary,#6b7280); border-radius:6px; padding:1px 8px; font:inherit; font-size:12px; line-height:20px; cursor:pointer; white-space:nowrap; }
      .skrc-btn:hover { border-color:var(--dsw-alias-border-l2,#c9ccd3); color:var(--dsw-alias-label-primary,#17181a); }
      .skrc-btn.on { color:var(--dsw-alias-brand-primary,#2563eb); border-color:var(--dsw-alias-brand-primary,#2563eb); }
      .skrc-panel { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); width:min(560px,92vw); max-height:64vh; overflow:auto; pointer-events:auto; background:var(--dsw-alias-bg-overlay,#fff); border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:12px; box-shadow:0 18px 48px rgba(16,24,40,.24); padding:12px 14px; z-index:60; font-size:12px; line-height:1.55; color:var(--dsw-alias-label-primary,#17181a); }
      .skrc-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      .skrc-head b { font-size:13px; }
      .skrc-meta { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11.5px; }
      .skrc-x { margin-left:auto; border:0; background:transparent; color:var(--dsw-alias-label-secondary,#6b7280); cursor:pointer; font:inherit; font-size:12px; }
      .skrc-terms { color:var(--dsw-alias-label-secondary,#6b7280); border-bottom:1px dashed var(--dsw-alias-border-l1,#e6e7eb); padding-bottom:6px; margin-bottom:6px; }
      .skrc-row { padding:6px 0; border-bottom:1px dashed var(--dsw-alias-border-l1,#f0f1f4); }
      .skrc-row:last-child { border-bottom:0; }
      .skrc-title { display:flex; align-items:baseline; gap:8px; font-weight:600; }
      .skrc-score { margin-left:auto; font-weight:500; color:var(--dsw-alias-label-secondary,#6b7280); }
      .skrc-sub { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11.5px; margin-top:2px; }
      .skrc-hist { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11.5px; margin-top:1px; }
      .skrc-body { margin-top:4px; padding:4px 8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2,#f7f8fa); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11.5px; line-height:1.55; color:var(--dsw-alias-label-primary,#17181a); }
      .skrc-sect { display:flex; align-items:baseline; gap:8px; margin:10px 0 4px; padding-bottom:4px; border-bottom:1px solid var(--dsw-alias-border-l1,#e6e7eb); font-size:11.5px; font-weight:650; color:var(--dsw-alias-label-secondary,#6b7280); }
      .skrc-sect:first-child { margin-top:0; }
      .skrc-sect-x { margin-left:auto; font-weight:500; }
      .skrc-stats { margin-top:8px; color:var(--dsw-alias-label-secondary,#6b7280); font-size:11.5px; }
      .skrc-empty { color:var(--dsw-alias-label-secondary,#6b7280); }
      .skrc-err { color:var(--dsw-alias-state-error-primary,#dc2626); }
      .skrc-change-actions { display:flex; gap:6px; justify-content:flex-end; margin-top:4px; }
      .skrc-btn-sm { border:1px solid var(--dsw-alias-border-l1,#e6e7eb); background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; border-radius:6px; padding:1px 8px; font:inherit; font-size:11.5px; cursor:pointer; }
      .skrc-btn-sm:hover { border-color:var(--dsw-alias-border-l2,#c9ccd3); }
      .skrc-editor { margin-top:6px; display:flex; flex-direction:column; gap:6px; }
      .skrc-input { border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:6px; padding:4px 8px; font:inherit; font-size:12px; background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; outline:none; }
      .skrc-textarea { border:1px solid var(--dsw-alias-border-l1,#e6e7eb); border-radius:6px; padding:4px 8px; font:inherit; font-size:12px; background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; resize:vertical; outline:none; }
      .skrc-editor-row { display:flex; gap:6px; }
    `;

    /** 弹窗状态在所有 kanban 入口之间共享：按钮负责打开，根级浮层负责渲染。 */
    const overlayStore = {
      open: false,
      status: 'idle',
      data: null,
      changes: [],
      sessionId: '',
      messageId: ''
    };
    const overlayListeners = new Set();

    function overlayPatch(patch) {
      Object.assign(overlayStore, patch);
      for (const listener of Array.from(overlayListeners)) listener();
    }

    function useOverlayStore() {
      const [, bump] = useState(0);
      useEffect(() => {
        const listener = () => bump(value => value + 1);
        overlayListeners.add(listener);
        return () => { overlayListeners.delete(listener); };
      }, []);
      return overlayStore;
    }

    const statusText = id => (STATUSES.find(s => s.id === id) || { label: id }).label;

    /** 助手消息旁的动作：打开共享的看板弹窗。 */
    function RecallAction(props) {
      const store = useOverlayStore();
      const sessionId = props && props.sessionId ? props.sessionId : '';
      const messageId = props && props.messageId ? props.messageId : '';
      const mine = store.sessionId === sessionId && store.messageId === messageId;

      const load = useCallback(() => {
        if (overlayStore.status === 'busy') return;
        overlayPatch({ status: 'busy', sessionId, messageId });
        Promise.all([
          api('recall', { sessionId, messageId }),
          api('turn.changes', { sessionId, messageId }).catch(() => ({ changes: [] }))
        ]).then(([recallResult, changeResult]) => {
          overlayPatch({
            status: 'ready',
            data: recallResult,
            changes: changeResult && Array.isArray(changeResult.changes) ? changeResult.changes : [],
            open: true
          });
        }).catch(error => {
          overlayPatch({
            status: 'err',
            data: { error: error && error.message ? error.message : '检索失败' },
            changes: [],
            open: true
          });
        });
      }, [sessionId, messageId]);

      const toggle = useCallback(event => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (!mine || overlayStore.status === 'idle' || overlayStore.status === 'err') { load(); return; }
        overlayPatch({ open: !overlayStore.open });
      }, [mine, load]);

      const views = (mine && store.data && store.data.views) || [];
      const hits = views.filter(view => view.reason !== '低分' && view.reason !== '泛词').length;
      const label = mine && store.status === 'busy' ? '…'
        : mine && store.status === 'ready' ? ('kanban ' + hits + '/' + views.length)
          : 'kanban';

      return h('span', { className: 'skrc-wrap' },
        h('style', null, RECALL_CSS),
        h('button', {
          type: 'button',
          className: 'skrc-btn' + (mine && store.status === 'ready' && store.open ? ' on' : ''),
          title: '看板',
          onClick: toggle
        }, label)
      );
    }

    /** 根级浮层里的弹窗：不进聊天的滚动容器，所以不会被裁剪或跟着布局抖。 */
    function RecallOverlay() {
      const store = useOverlayStore();
      const [editing, setEditing] = useState(null);
      const [saving, setSaving] = useState(false);
      const data = store.data;
      const changes = store.changes;

      useEffect(() => {
        if (!store.open) setEditing(null);
      }, [store.open]);

      useEffect(() => {
        if (!store.open) return undefined;
        const onKey = event => { if (event.key === 'Escape') overlayPatch({ open: false }); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [store.open]);

      const dropChange = useCallback(id => {
        overlayPatch({ changes: overlayStore.changes.filter(change => change.id !== id) });
      }, []);

      const revertChange = useCallback((event, change) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (!change || !change.previousRev) return;
        api('rollback', { id: change.id, rev: change.previousRev })
          .then(() => dropChange(change.id))
          .catch(() => {});
      }, [dropChange]);

      const removeChange = useCallback((event, change) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (!change) return;
        api('delete', { id: change.id })
          .then(() => dropChange(change.id))
          .catch(() => {});
      }, [dropChange]);

      const startEdit = useCallback((event, item) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (!item || !item.id) return;
        api('get', { id: item.id })
          .then(result => setEditing({
            id: item.id,
            rev: result.item.rev,
            title: result.item.title,
            status: result.item.status,
            body: result.item.body || ''
          }))
          .catch(() => {});
      }, []);

      const saveEdit = useCallback(() => {
        if (!editing || saving) return;
        setSaving(true);
        api('update', {
          id: editing.id,
          expectedRev: editing.rev,
          patch: { title: editing.title, status: editing.status, body: editing.body }
        }).then(result => {
          const item = result.item;
          const base = overlayStore.data;
          overlayPatch({
            data: base && Array.isArray(base.views)
              ? {
                ...base,
                views: base.views.map(view => view.id === item.id
                  ? { ...view, title: item.title, status: item.status, statusLabel: statusText(item.status), rev: item.rev }
                  : view)
              }
              : base,
            changes: overlayStore.changes.map(change => change.id === item.id
              ? { ...change, title: item.title, status: item.status, statusLabel: statusText(item.status), rev: item.rev, note: '人在弹窗里编辑' }
              : change)
          });
          setEditing(null);
        }).catch(() => {}).finally(() => setSaving(false));
      }, [editing, saving]);

      if (!store.open || !data) return null;

      const views = data.views || [];
      const stats = data.stats || null;

      const editor = () => h('div', { className: 'skrc-editor' },
        h('input', {
          className: 'skrc-input',
          value: editing.title,
          onChange: e => setEditing({ ...editing, title: e.target.value })
        }),
        h('div', { className: 'skrc-editor-row' },
          h('select', {
            className: 'skrc-input',
            value: editing.status,
            onChange: e => setEditing({ ...editing, status: e.target.value })
          }, STATUSES.map(s => h('option', { key: s.id, value: s.id }, s.label)))
        ),
        h('textarea', {
          className: 'skrc-textarea',
          rows: 3,
          value: editing.body,
          onChange: e => setEditing({ ...editing, body: e.target.value })
        }),
        h('div', { className: 'skrc-change-actions' },
          h('button', { className: 'skrc-btn-sm', disabled: saving, onClick: saveEdit }, saving ? '保存中…' : '保存'),
          h('button', { className: 'skrc-btn-sm', onClick: () => setEditing(null) }, '取消')
        )
      );

      const section = (text, extra) => h('div', { className: 'skrc-sect' },
        h('span', null, text),
        extra ? h('span', { className: 'skrc-sect-x' }, extra) : null
      );

      const changeRow = (change, index) => h('div', { key: change.id || ('c' + index), className: 'skrc-row' },
        h('div', { className: 'skrc-title' }, change.title),
        h('div', { className: 'skrc-sub' },
          (change.created
            ? '新建 · ' + change.statusLabel
            : (change.from && change.from.status !== change.status
              ? statusText(change.from.status) + ' → ' + change.statusLabel
              : '内容更新 · ' + change.statusLabel))
          + (change.note ? ' · ' + change.note : '')),
        change.body ? h('div', { className: 'skrc-body', title: change.body }, change.body) : null,
        editing && editing.id === change.id ? editor() : h('div', { className: 'skrc-change-actions' },
          h('button', { className: 'skrc-btn-sm', onClick: event => startEdit(event, change) }, '编辑'),
          change.created
            ? h('button', { className: 'skrc-btn-sm', onClick: event => removeChange(event, change) }, '删除')
            : h('button', { className: 'skrc-btn-sm', onClick: event => revertChange(event, change) }, '回滚'),
          h('button', {
            className: 'skrc-btn-sm',
            onClick: event => { if (event && event.stopPropagation) event.stopPropagation(); dropChange(change.id); }
          }, '确认')
        )
      );

      const viewRow = (view, index) => h('div', { key: view.id, className: 'skrc-row' },
        h('div', { className: 'skrc-title' },
          h('span', null, (index + 1) + '. ' + view.title),
          h('span', { className: 'skrc-score' }, view.score.toFixed(2))
        ),
        h('div', { className: 'skrc-sub' },
          view.statusLabel + ' · ' + (view.scope || '未定范围') + ' · ' + view.reason
          + (view.matched.length
            ? ' · 命中 ' + view.matched.map(entry => entry.term + (entry.field === 'title' ? '(标题)' : entry.field === 'body' ? '(正文)' : '(原文)')).join(' ')
            : '')),
        view.body ? h('div', { className: 'skrc-body', title: view.body }, view.body) : null,
        h('div', { className: 'skrc-hist' }, view.historyLine)
      );

      return h('div', { style: { pointerEvents: 'none' } },
        h('style', null, RECALL_CSS),
        h('div', { className: 'skrc-panel', onClick: event => event.stopPropagation() },
          h('div', { className: 'skrc-head' },
            h('b', null, '看板'),
            h('span', { className: 'skrc-meta' }, '只展示 · 不进模型'),
            h('button', { className: 'skrc-x', onClick: () => overlayPatch({ open: false }) }, '关闭')
          ),
          data.error ? h('div', { className: 'skrc-err' }, data.error) : h('div', null,
            section('本轮改动', changes.length ? changes.length + ' 条' : '无'),
            changes.length > 0
              ? changes.map(changeRow)
              : h('div', { className: 'skrc-empty' }, '本轮 AI 没有改看板。让我记一条、改某条状态或正文，这里就会出现改动，可以编辑、回滚、删除。'),
            section('相关条目', views.length ? views.length + ' 条' : null),
            h('div', { className: 'skrc-terms' },
              '命中关键词：' + ((data.query && data.query.terms && data.query.terms.length)
                ? data.query.terms.join(' · ')
                : '（没有命中词）')),
            views.length === 0
              ? h('div', { className: 'skrc-empty' }, '没有相关条目')
              : h('div', null, views.map(viewRow)),
            h('div', { className: 'skrc-stats' },
              '每次打开记一行到 recall.jsonl · 今天 ' + (stats ? stats.count : 0) + ' 次')
          )
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'saibo-kanban',
          order: -10,
          label: '看板'
        }, Panel));

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'saibo-recall',
          order: 21,
          label: 'kanban'
        }, RecallAction));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'saibo-recall-overlay',
          order: 40,
          label: 'kanban'
        }, RecallOverlay));
      }
    };
  }
});
