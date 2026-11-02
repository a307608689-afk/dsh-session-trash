/**
 * dsh-session-trash —— 浏览器半端
 * ============================================================================
 * 三个注册点：
 *   · sidebar.workspaces.session.menu.item —— 会话「⋯」菜单里的「删除会话」
 *   · shell.overlay —— 确认弹层 + 轻提示（宿主没有 dialog/toast 服务，自己画）
 *   · settings.section —— 设置里的「回收站」页
 *
 * 约定：
 *   · 只 require('react')，不 require 任何 @deepseek-ai/dsh-client-* 包；
 *   · 样式用 --dsw-alias-* token，类名统一 st- 前缀，不污染宿主；
 *   · 所有写操作都走宿主接口，客户端只管界面。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /**
     * 宿主把 shell.overlay 挂在自己的层里；设置面板在更上/更下的层里时，我们的弹层会被压住或裁切。
     * 有 react-dom 就把弹层 portal 到 document.body，并用最大 z-index 顶到最上面；没有就原地渲染。
     */
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { ReactDOM = null }

    const API = '/dsh-session-trash'

    /* ── 极简 store（跨槽位共享状态） ─────────────────────────────────── */

    const listeners = new Set()
    const state = {
      tab: 'sessions', archive: null, archiveTotalMB: 0, archiveMaxMB: 2048, archiveQuery: '', archiveKind: 'all', archiveBusy: false, archiveLoaded: false, archiveArm: '',
      /* 确认弹层 */
      open: false,
      sessionId: '',
      title: '',
      loading: false,
      error: '',
      data: null,
      busy: false,
      /* 轻提示 */
      toast: null, // { id, text, actionLabel, action }
      /* 回收站页 */
      trashLoaded: false,
      trashLoading: false,
      trash: [],
      trashError: '',
      releaseAtt: false,
      attachView: false,
      attachList: null,
      attachSel: [],
      attachLoading: false,
      includeForks: false,
      trashSel: [],
      trashQuery: '',
      trashRetention: 30,
      soonCount: 0,
      orphanDirs: null,
      orphanSel: [],
      orphanOpen: false,
      orphanBusy: false,
      orphan: null,
      confirmPurge: null, // { ids: [], releaseMB: number }
      /* 安全 / 自检（M6） */
      settings: null, // { exitCheck, diagnostics, retentionDays }
      precheck: null, // 上次体检结果
      precheckAlert: null, // 上次退出时发现异常 → 顶部横幅
      precheckBusy: false, fuse: null, fuseBusy: false,
      repairBusy: false,
      /* 导出 / 导入 */
      exportOpen: false,
      exportSid: '',
      exportTitle: '',
      exportFmt: 'md',
      exportText: '',
      exportName: '',
      exportBusy: false,
      exportErr: '',
      importOpen: false,
      importText: '',
      importBusy: false,
      importErr: '',
      importPreview: null,
      importMode: 'new',
    }
    const emit = () => { for (const fn of listeners) fn() }
    const patch = (p) => { Object.assign(state, p); emit() }

    const useStore = () => {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => { listeners.delete(force) }
      }, [])
      return state
    }

    /* ── HTTP ─────────────────────────────────────────────────────────── */

    const getJson = async (url) => {
      const res = await fetch(API + url, { headers: { accept: 'application/json' } })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + res.status)
      return body
    }
    const postJson = async (url, body) => {
      const res = await fetch(API + url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    const fmtMB = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return ''
      return v >= 1 ? v + ' MB' : Math.round(v * 1024) + ' KB'
    }
    const fmtFileMB = (n) => (n >= 0.1 ? n + ' MB' : '<0.1 MB')
    const fmtDate = (iso) => {
      const d = new Date(iso)
      if (!Number.isFinite(d.getTime())) return ''
      const p = (n) => (n < 10 ? '0' + n : '' + n)
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    /** 宿主侧刷新会话列表（Client sessions 服务有 refresh；没有就静默跳过） */
    let clientCtx = null
    async function refreshSessionList() {
      try {
        const svc = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : null
        if (svc && typeof svc.refresh === 'function') await svc.refresh()
      } catch { /* 刷新失败不影响删除结果 */ }
    }

    /** 「刷新」按钮：先重拉插件自己的数据，再整页重载。
     *  侧栏会话列表由宿主渲染，Client sessions/workspaces 都没有「列表刷新」接口
     *  （sessions.refresh 在 2026-11-02 核查时并不存在），插件改完磁盘后宿主不会收到通知，
     *  因此只有整页重载能让侧栏重新拉取。整页重载会触发一次 web boot，0.1.7 之前曾因
     *  插件刚升级、入口未就绪而一次性激活失败（已通过补齐 package.json files + 版本 0.1.7 修复）。 */
    async function softRefresh() {
      try { await loadTrash(true) } catch { /* ignore */ }
      try { await loadArchive() } catch { /* ignore */ }
      try { await loadOrphanDirs() } catch { /* ignore */ }
      try { window.location.reload() } catch { /* ignore */ }
    }

    /** 让侧栏那一行立刻消失：借用宿主自己的「归档」能力（Client workspaces 服务有 archiveSession），
     *  宿主在内部把会话标记为归档并推给界面，不需要整页刷新。
     *  如果随后真正的删除失败，再用 unarchiveSession 还原，避免会话卡在归档里。 */
    function workspacesService() {
      try {
        return clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('workspaces') : null
      } catch { return null }
    }

    async function hideFromSidebar(sessionIds) {
      const svc = workspacesService()
      if (!svc || typeof svc.archiveSession !== 'function') return []
      const hidden = []
      for (const sid of sessionIds) {
        try { await svc.archiveSession(sid); hidden.push(sid) } catch { /* 单个失败就跳过 */ }
      }
      return hidden
    }

    async function unhideFromSidebar(sessionIds) {
      const svc = workspacesService()
      if (!svc || typeof svc.unarchiveSession !== 'function') return
      for (const sid of sessionIds) {
        try { await svc.unarchiveSession(sid) } catch { /* ignore */ }
      }
    }

    let toastSeq = 0
    function toast(text, actionLabel, action) {
      patch({ toast: { id: ++toastSeq, text, actionLabel: actionLabel || '', action: action || null } })
      const id = toastSeq
      setTimeout(() => {
        if (state.toast && state.toast.id === id) patch({ toast: null })
      }, actionLabel ? 9000 : 4000)
    }

    /* ── 打开确认层 ───────────────────────────────────────────────────── */

    async function openDelete(sessionId, title) {
      patch({ open: true, sessionId, title: title || '', loading: true, error: '', data: null, busy: false, releaseAtt: false, includeForks: false, attachView: false, attachList: null, attachSel: [], attachLoading: true })
      try {
        const data = await postJson('/analyze', { sessionId })
        patch({ data, loading: false })
        try {
          const list = await postJson('/attachments', { sessionId })
          patch({ attachList: list, attachLoading: false })
        } catch { patch({ attachLoading: false }) }
      } catch (e) {
        patch({ loading: false, error: String((e && e.message) || e) })
      }
    }

    async function doDelete() {
      if (state.busy) return
      patch({ busy: true })
      const sid = state.sessionId
      // 级联删除时，分叉对话也要一起从侧栏消失
      const cascade = state.includeForks === true && state.data && state.data.forks && Array.isArray(state.data.forks.items)
        ? state.data.forks.items.map((x) => x && (x.sessionId || x.id)).filter(Boolean)
        : []
      // 先归档（宿主动作，界面立刻移除这一行），再真正搬到回收站；删除失败就取消归档还原
      const hidden = await hideFromSidebar([sid].concat(cascade))
      try {
        await postJson('/delete', {
          sessionId: sid,
          title: state.title,
          releaseShas: Array.isArray(state.attachSel) ? state.attachSel : [],
          includeForks: state.includeForks === true,
        })
        patch({ open: false, busy: false, data: null })
        if (hidden.length > 0) {
          toast('已移入回收站，30 天内可在「设置 → 回收站」找回')
        } else {
          toast('已移入回收站，30 天内可在「设置 → 回收站」找回', '刷新页面', () => { softRefresh() })
        }
        await refreshSessionList()
      } catch (e) {
        await unhideFromSidebar(hidden)
        patch({ busy: false, error: String((e && e.message) || e) })
      }
    }

    /* ── 导出 ─────────────────────────────────────────────────────────── */

    async function openExport(sid, title) {
      patch({ exportOpen: true, exportSid: sid, exportTitle: title || '', exportFmt: 'json', exportText: '', exportName: '', exportBusy: true, exportErr: '' })
      await fetchExport('json')
    }

    async function fetchExport(fmt) {
      patch({ exportFmt: fmt, exportBusy: true, exportErr: '' })
      try {
        const r = await postJson('/export', { sessionId: state.exportSid, format: fmt })
        patch({ exportText: r.text, exportName: r.suggestedName || '', exportBusy: false })
      } catch (e) {
        patch({ exportBusy: false, exportErr: String((e && e.message) || e) })
      }
    }

    function exportExt() {
      return state.exportFmt === 'md' ? 'md' : 'json'
    }

    function exportBaseName() {
      const raw = String(state.exportName || '').trim() || '对话导出'
      return raw.replace(/\.(md|json)$/i, '')
    }

    function exportFileName() {
      return exportBaseName() + '.' + exportExt()
    }

    async function copyExport() {
      try {
        await navigator.clipboard.writeText(state.exportText)
        toast('已复制到剪贴板')
      } catch {
        toast('复制失败，可以点「下载文件」')
      }
    }

    function downloadExport() {
      try {
        const blob = new Blob([state.exportText], { type: state.exportFmt === 'md' ? 'text/markdown' : 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = exportFileName()
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        toast('已开始下载 ' + a.download)
      } catch (e) {
        toast('下载失败：' + String((e && e.message) || e))
      }
    }

    /* ── 导入 ─────────────────────────────────────────────────────────── */

    function openImport() {
      patch({ importOpen: true, importText: '', importPreview: null, importMode: 'new', importErr: '', importBusy: false })
    }

    async function previewImport(text) {
      const body = String(text || '')
      patch({ importText: body, importErr: '', importPreview: null })
      if (!body.trim()) return
      try {
        const r = await postJson('/import/preview', { text: body })
        const seat = r.seat || { kind: 'new' }
        patch({
          importPreview: r,
          importMode: seat.kind === 'trash' ? 'restore' : (seat.kind === 'list' ? 'merge' : 'new'),
        })
      } catch (e) {
        patch({ importErr: String((e && e.message) || e) })
      }
    }

    async function readImportFile(file) {
      try {
        const text = await file.text()
        await previewImport(text)
      } catch (e) {
        patch({ importErr: '读文件失败：' + String((e && e.message) || e) })
      }
    }

    async function applyImport() {
      if (state.importBusy || !state.importPreview) return
      patch({ importBusy: true, importErr: '' })
      try {
        const r = await postJson('/import/apply', {
          text: state.importText,
          mode: state.importMode,
          targetSessionId: state.importPreview.seat && state.importPreview.seat.sessionId,
        })
        const where = r.mode === 'merge' ? '合并进已有对话' : (r.mode === 'restore' ? '从回收站恢复' : '导入为新对话')
        toast(where + (r.added ? '，新增 ' + r.added + ' 条消息' : ''))
        patch({ importOpen: false, importBusy: false, importPreview: null, importText: '' })
        await loadTrash(true)
        await refreshSessionList()
      } catch (e) {
        patch({ importBusy: false, importErr: String((e && e.message) || e) })
      }
    }

    /* ── 菜单项 ───────────────────────────────────────────────────────── */

    /** 菜单注入的 useMenuOpenState：优先用它收起菜单，取不到就退回 Esc。 */
    function useMenuClose(props) {
      const hook = props && props.useMenuOpenState
      if (typeof hook === 'function') {
        try {
          const r = hook()
          if (typeof r === 'function') return r
          if (r && typeof r.close === 'function') return () => r.close()
          if (Array.isArray(r) && typeof r[1] === 'function') return () => r[1](false)
        } catch { /* 形状不符就走兜底 */ }
      }
      return null
    }

    function dismissMenu(close) {
      if (close) { try { close(); return } catch { /* 继续兜底 */ } }
      try {
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        ;(document.activeElement || document.body).dispatchEvent(ev)
      } catch { /* ignore */ }
    }

    function MenuDeleteItem(props) {
      const closeMenu = useMenuClose(props)
      const sid = String((props && props.sessionId) || '')
      const title = String((props && props.displayTitle) || '')
      const [on, setOn] = React.useState(false)
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'st-menu-item',
        style: { background: on ? 'rgba(128,128,128,0.16)' : 'transparent', color: 'var(--dsw-alias-state-error-primary, #d92d20)' },
        onMouseEnter: () => setOn(true),
        onMouseLeave: () => setOn(false),
        onFocus: () => setOn(true),
        onBlur: () => setOn(false),
        onClick: (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          dismissMenu(closeMenu)
          openDelete(sid, title)
        },
      },
        h('span', { className: 'st-menu-ico', 'aria-hidden': 'true' },
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 },
            h('path', { d: 'M2.8 4.2h10.4' }),
            h('path', { d: 'M6.2 4.2V3a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.2' }),
            h('path', { d: 'M4 4.2l.6 8.2a.9.9 0 0 0 .9.8h4.8a.9.9 0 0 0 .9-.8l.6-8.2' }),
            h('path', { d: 'M6.6 6.8v4.2M9.4 6.8v4.2' }))),
        h('span', { className: 'st-menu-text' }, '删除会话'),
      )
    }

    /** 菜单项：导出这段对话 */
    function MenuExportItem(props) {
      const sid = props && props.sessionId
      const title = (props && props.displayTitle) || ''
      const closeMenu = useMenuClose(props)
      const [on, setOn] = React.useState(false)
      if (!sid) return null
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'st-menu-item',
        style: { background: on ? 'rgba(128,128,128,0.16)' : 'transparent' },
        onMouseEnter: () => setOn(true),
        onMouseLeave: () => setOn(false),
        onFocus: () => setOn(true),
        onBlur: () => setOn(false),
        onClick: (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          dismissMenu(closeMenu)
          openExport(sid, title)
        },
      },
        h('span', { className: 'st-menu-ico', 'aria-hidden': 'true' },
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 },
            h('path', { d: 'M8 2.6v7.2' }),
            h('path', { d: 'M5.2 5.4L8 2.6l2.8 2.8' }),
            h('path', { d: 'M3 9.6v2.2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.6' }))),
        h('span', { className: 'st-menu-text' }, '导出对话…'),
      )
    }

    /** 顶栏图标按钮：从文件导入（独立内联样式，不依赖 .st-root 变量作用域） */
    function HeaderImportButton() {
      const [on, setOn] = React.useState(false)
      return h('button', {
        type: 'button',
        title: '从文件导入对话',
        'aria-label': '从文件导入对话',
        style: {
          width: '28px', height: '28px', flex: 'none', padding: 0, border: 0, borderRadius: '8px',
          display: 'grid', placeItems: 'center', cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary, #6b6b73)',
          background: on ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16))' : 'transparent',
        },
        onMouseEnter: () => setOn(true),
        onMouseLeave: () => setOn(false),
        onFocus: () => setOn(true),
        onBlur: () => setOn(false),
        onClick: () => openImport(),
      },
        h('svg', { width: 18, height: 18, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.45, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M1.9 5a1.1 1.1 0 0 1 1.1-1.1h2.6l1.1 1.5h5.4A1.1 1.1 0 0 1 13.2 6.5v6.2a1.1 1.1 0 0 1-1.1 1.1H3A1.1 1.1 0 0 1 1.9 12.7z' }),
          h('path', { d: 'M8 6.6v3.7' }),
          h('path', { d: 'M6.3 8.7L8 10.4l1.7-1.7' })))
    }

    /* ── 导出弹层 ─────────────────────────────────────────────────────── */

    function ExportDialog() {
      const s = useStore()
      const close = () => patch({ exportOpen: false })
      const size = s.exportText ? Math.max(1, Math.round(s.exportText.length / 1024)) : 0
      const docIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 2.4h4.6l3 3v8.2H4.2z"/><path d="M8.6 2.6v3.2h3"/><path d="M6 8.4h4M6 10.6h4"/></svg>'
      const fmtName = s.exportFmt === 'md' ? 'Markdown' : 'JSON'
      return h('div', {
        className: 'st-backdrop',
        onMouseDown: (ev) => { if (ev.target === ev.currentTarget) close() },
      },
        h('div', { className: 'st-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导出对话' },
          h('div', { className: 'st-dlg-head' },
            h('h2', {}, '导出「' + (s.exportTitle || s.exportSid) + '」'),
            h('button', {
              type: 'button',
              className: 'st-dlg-close',
              onClick: close,
              'aria-label': '关闭',
            }, h('span', { className: 'st-ico-svg', dangerouslySetInnerHTML: { __html: ST_ICONS.close } }))),
          h('p', { className: 'st-sub' }, '选好格式，然后复制内容或下载成文件。'),
          h('div', { className: 'st-sec', style: { marginTop: '14px' } },
            h('div', { className: 'st-sec-label', style: { marginBottom: '8px' } }, '格式'),
            h('div', {
              role: 'radiogroup',
              'aria-label': '导出格式',
              style: {
                display: 'inline-flex', gap: '2px', padding: '4px',
                background: 'var(--bg-layer-1)', borderRadius: '12px',
                border: '1px solid var(--border-l2)',
                boxShadow: 'inset 0 1px 2px rgba(0,0,0,.05)',
              },
            },
              [['json', 'JSON'], ['md', 'Markdown']].map(([f, label]) => {
                const on = s.exportFmt === f
                return h('button', {
                  key: f,
                  type: 'button',
                  role: 'radio',
                  'aria-checked': on,
                  disabled: s.exportBusy,
                  onClick: () => fetchExport(f),
                  style: {
                    font: 'inherit', border: 0, cursor: 'pointer',
                    padding: '5px 16px', borderRadius: '8px',
                    fontSize: '12.5px', lineHeight: '20px', fontWeight: on ? 600 : 400,
                    transition: 'background .12s ease,color .12s ease',
                    background: on ? 'var(--label-primary)' : 'transparent',
                    color: on ? 'var(--bg-base)' : 'var(--label-secondary)',
                    boxShadow: on ? '0 1px 2px rgba(0,0,0,.18)' : 'none',
                  },
                }, label)
              })),
            h('div', { className: 'st-cf-desc', style: { marginTop: '9px' } }, s.exportFmt === 'md'
              ? 'Markdown 只用来阅读、贴给别人看；想再导回来请切到 JSON。'
              : 'JSON 是完整事件流，可以再导入回来；导入时按事件指纹去重。')),
          s.exportErr ? h('div', { className: 'st-verdict st-bad' }, s.exportErr) : null,
          h('div', { className: 'st-file-card' },
            h('span', { className: 'st-att-thumb', 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: docIcon } }),
            h('div', { className: 'st-att-main' },
              h('div', { className: 'st-file-name' }, exportFileName()),
              h('div', { className: 'st-file-meta' }, s.exportBusy ? '正在整理…' : (fmtName + ' · 约 ' + size + ' KB')))),
          h('div', { className: 'st-hint-line' }, '导出只读，不会改动对话；Markdown 丢掉工具调用细节，JSON 保留完整事件。'),
          h('div', { className: 'st-dlg-foot' },
            h('button', { type: 'button', className: 'st-btn st-plain', onClick: close }, '关闭'),
            h('button', {
              type: 'button',
              className: 'st-btn st-plain',
              onClick: copyExport,
              disabled: !s.exportText,
            }, '复制'),
            h('button', {
              type: 'button',
              className: 'st-btn st-primary',
              onClick: downloadExport,
              disabled: !s.exportText,
            }, '下载文件'))))
    }

    /* ── 导入弹层 ─────────────────────────────────────────────────────── */

    function ImportDialog() {
      const s = useStore()
      const close = () => patch({ importOpen: false })
      const [over, setOver] = React.useState(false)
      const pv = s.importPreview
      const seat = pv && pv.seat
      let seatText = ''
      if (seat) {
        if (seat.kind === 'trash') seatText = '「' + (seat.title || '这段对话') + '」在回收站里（还剩 ' + seat.daysLeft + ' 天）——可以恢复，也可以另存副本。'
        else if (seat.kind === 'list') seatText = '文件里的 Session ID 和已有的「' + (seat.title || '这段对话') + '」一致——可以合并进去，也可以另存副本。'
        else seatText = ''
      }
      const modes = []
      if (seat) {
        if (seat.kind === 'trash') modes.push(['restore', '从回收站恢复'], ['copy', '另存副本'])
        else if (seat.kind === 'list') modes.push(['merge', '合并到已有'], ['copy', '另存副本'])
        else modes.push(['new', '导入为新对话'])
      }
      const iconIn = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2v6.6"/><path d="M5.4 6.2L8 8.8l2.6-2.6"/><path d="M2.9 10.4v2.1a1.1 1.1 0 0 0 1.1 1.1h8a1.1 1.1 0 0 0 1.1-1.1v-2.1"/></svg>'
      const pick = (ev) => {
        const f = ev.target.files && ev.target.files[0]
        ev.target.value = ''
        if (f) readImportFile(f)
      }
      const dragOver = (ev) => { ev.preventDefault(); setOver(true) }
      const dragLeave = () => setOver(false)
      const drop = (ev) => {
        ev.preventDefault(); setOver(false)
        const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]
        if (f) readImportFile(f)
      }
      const primaryText = s.importBusy ? '导入中…'
        : s.importMode === 'merge' ? '合并导入'
        : s.importMode === 'restore' ? '从回收站恢复'
        : '导入'

      const dropZone = h('label', {
        className: 'st-drop' + (over ? ' st-over' : ''),
        style: { display: 'block' },
        onDragOver: dragOver,
        onDragLeave: dragLeave,
        onDrop: drop,
      },
        h('div', { className: 'st-drop-ico', 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: iconIn } }),
        h('div', { className: 'st-drop-title' }, pv ? (pv.session.title || pv.session.id || '已读取文件') : '把导出的 JSON 拖到这里'),
        h('div', { className: 'st-drop-sub' },
          pv
            ? ('v' + pv.schemaVersion + ' · ' + pv.messages + ' 条消息 · ' + pv.events + ' 个事件')
            : '支持 .json · 也可以',
          pv ? null : h('span', { className: 'st-lnk' }, ' 选择文件')),
        h('input', {
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          onChange: pick,
        }))

      const conflict = seat && seat.kind !== 'new'
        ? h('div', { className: 'st-conflict' },
          h('div', { className: 'st-cf-head' }, seat.kind === 'trash' ? '这个对话在回收站里' : '这个对话已经在列表里'),
          h('div', { className: 'st-cf-sub' }, seatText),
          h('div', { className: 'st-segline' }, modes.map(([m, label]) => h('button', {
            key: m,
            type: 'button',
            className: 'st-chip' + (s.importMode === m ? ' st-on' : ''),
            onClick: () => patch({ importMode: m }),
          }, label))),
          h('div', { className: 'st-cf-desc' }, s.importMode === 'merge'
            ? '合并：按事件指纹去重后，把新消息追加到末尾；不重排、不改已有消息，标题和列表位置都不变。附件按内容去重，本地已有的不再存。'
            : s.importMode === 'restore'
              ? '恢复：把回收站那份放回列表，不产生重复，保留期会重新计算。'
              : '另存副本：另起一段，两边各改各的，互不影响。'))
        : (pv ? h('div', { className: 'st-new-tag' }, '新会话 · 直接导入') : null)

      return h('div', {
        className: 'st-backdrop',
        onMouseDown: (ev) => { if (ev.target === ev.currentTarget) close() },
      },
        h('div', { className: 'st-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入对话' },
          h('div', { className: 'st-dlg-head' },
            h('h2', { className: 'st-dlg-title' }, '从文件导入对话'),
            h('button', {
              type: 'button',
              className: 'st-dlg-close',
              onClick: close,
              'aria-label': '关闭',
            }, h('span', { className: 'st-ico-svg', dangerouslySetInnerHTML: { __html: ST_ICONS.close } }))),
          h('p', { className: 'st-sub' }, '选一个之前导出的 .json 文件，或把内容粘到下面。'),
          dropZone,
          conflict,
          s.importErr ? h('div', { className: 'st-verdict st-bad' }, s.importErr) : null,
          h('div', { className: 'st-sec' },
            h('div', { className: 'st-sec-label' }, '或者粘贴 JSON'),
            h('textarea', {
              placeholder: '把导出的 JSON 粘到这里…',
              value: s.importText,
              rows: 5,
              spellCheck: false,
              style: {
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                padding: '10px 12px', borderRadius: '9px',
                border: '1px solid var(--border-l2)', background: 'var(--bg-base)',
                color: 'var(--label-primary)', font: '12.5px/1.6 ui-monospace,Consolas,"Courier New",monospace',
              },
              onChange: (ev) => previewImport(ev.target.value),
            })),
          h('div', { className: 'st-hint-line' }, '导入只写新记录，不会覆盖已有对话；文件里列出的附件会重新登记，本地已有的同一个文件不会重复存。'),
          h('div', { className: 'st-dlg-foot' },
            h('button', { type: 'button', className: 'st-btn st-plain', onClick: close }, '取消'),
            h('button', {
              type: 'button',
              className: 'st-btn st-primary',
              onClick: applyImport,
              disabled: !pv || s.importBusy || (pv && pv.blocked),
            }, primaryText))))
    }

    /* ── 确认弹层（DOM 结构与类名对齐 HTML 原型） ─────────────────────── */

    const SVG = (body, extra) => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"' + (extra || '') + '>' + body + '</svg>'
    const ST_ICONS = {
      close: SVG('<path d="M4 4l8 8M12 4l-8 8"/>'),
      check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8.6l3.2 3.1L13 4.8"/></svg>',
      dot: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="2.6"/></svg>',
      chev: SVG('<path d="M6 3.5L10.5 8 6 12.5"/>'),
      lock: SVG('<rect x="3.6" y="7" width="8.8" height="5.8" rx="1.4"/><path d="M5.8 7V5.4a2.2 2.2 0 014.4 0V7"/>'),
      img: SVG('<rect x="2.2" y="3" width="11.6" height="10" rx="1.6"/><circle cx="6" cy="6.6" r="1.1" fill="currentColor" stroke="none"/><path d="M3.2 11.6l3.1-3 2.3 2.2 1.8-1.6 2.4 2.4"/>'),
      sheet: SVG('<rect x="2.4" y="2.6" width="11.2" height="10.8" rx="1.4"/><path d="M2.4 6.2h11.2M6.4 6.2v7.2"/>'),
      zip: SVG('<path d="M3 3.4h10v9.2H3z"/><path d="M7.4 3.4v1.6M8.6 5v1.6M7.4 6.6V8.2M8.6 8.2v1.6M7.4 9.8v1.4"/>'),
      doc: SVG('<path d="M3.6 2.6h6l2.8 2.8v8H3.6z"/><path d="M9.4 2.8v3h3"/>'),
    }

    function verdictOf(d) {
      if (!d) return { tone: 'idle', text: '正在检查…' }
      if (d.trashed) return { tone: 'warn', text: '这个会话已经在回收站里了。' }
      if (d.team && d.team.inTeam && d.team.role === 'lead') {
        return { tone: 'warn', text: '可以删，但你是这个团队的队长：删掉之后队员们在列表里就找不到这个团队了。' }
      }
      if (d.team && d.team.inTeam) {
        return { tone: 'warn', text: '可以删，但你是团队里的成员' + (d.team.name ? '「' + d.team.name + '」' : '') + '：删掉之后队长那边就找不到它了。' }
      }
      const dep = (d.forks && d.forks.count ? 1 : 0) + (d.subagents && d.subagents.count ? 1 : 0) + (d.reminders && d.reminders.count ? 1 : 0)
      if (d.live) return { tone: 'warn', text: '建议先别删：它正在跑任务。' }
      if (!d.dirFound) return { tone: 'bad', text: '找不到本地目录：删掉只会清列表里的这一条。' }
      if (dep > 0) return { tone: 'warn', text: '可以删，但有 ' + dep + ' 处会受影响。' }
      if (d.archived) return { tone: 'ok', text: '可以删。它现在是归档状态，没发现别的东西依赖它。' }
      return { tone: 'ok', text: '可以删。没发现别的对话或任务依赖它。' }
    }

    const mbTxt = (mb) => {
      const v = Number(mb)
      if (!Number.isFinite(v) || v <= 0) return '0 MB'
      return v >= 1 ? String(Math.round(v * 10) / 10) + ' MB' : String(Math.round(v * 1024)) + ' KB'
    }
    const bytesToMB = (b) => b / 1048576
    const pickedBytes = (list, selSet) =>
      ((list && list.own) || []).filter((f) => selSet.has(f.sha)).reduce((a, f) => a + (f.bytes || 0), 0)
    const kindOf = (name) => {
      const n = String(name || '').toLowerCase()
      if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(n)) return 'img'
      if (/\.(xlsx?|csv)$/.test(n)) return 'sheet'
      if (/\.(zip|7z|tar|gz|rar)$/.test(n)) return 'zip'
      return 'doc'
    }

    /** 确认层里的附件勾选行：全选 / 半选，点进去看明细。 */
    function AttachPickRow() {
      const s = useStore()
      const list = s.attachList
      const own = (list && list.own) || []
      const selSet = new Set(s.attachSel || [])
      const picked = own.filter((f) => selSet.has(f.sha))
      const all = own.length > 0 && picked.length === own.length
      const some = picked.length > 0 && !all
      const ref = React.useRef(null)
      React.useEffect(() => { if (ref.current) ref.current.indeterminate = some }, [some])
      if (!own.length) {
        return h('div', { className: 'st-attach-sub' }, list && list.shared && list.shared.length
          ? '这些附件都被其他对话共用，没有可清理的。'
          : '这个对话没有引用附件。')
      }
      return h('label', { className: 'st-cascade' },
        h('input', {
          type: 'checkbox', ref, checked: all,
          onChange: () => patch({ attachSel: all ? [] : own.map((f) => f.sha) }),
        }),
        h('span', null,
          h('span', { className: 'st-att-cb-text' }, picked.length
            ? '删除选中的 ' + picked.length + ' 个附件 · 可回收 ' + mbTxt(bytesToMB(pickedBytes(list, selSet)))
            : '删除只被它使用的 ' + own.length + ' 个附件 · 可回收 ' + mbTxt(list.ownMB)),
          h('div', { className: 'st-cb-desc' }, '附件会跟着进回收站；恢复这段对话时一起回来，彻底删除时才真正释放空间。')))
    }

    /** 附件明细：同一个弹层的第二个视图，不叠新层。 */
    function AttachSheet() {
      const s = useStore()
      const list = s.attachList || { own: [], shared: [] }
      const selSet = new Set(s.attachSel || [])
      const own = list.own || []
      const shared = list.shared || []
      const all = own.length > 0 && own.every((f) => selSet.has(f.sha))
      const toggle = (sha) => patch({
        attachSel: selSet.has(sha)
          ? (s.attachSel || []).filter((x) => x !== sha)
          : (s.attachSel || []).concat([sha]),
      })
      const shown = shared.slice(0, 60)
      const back = () => patch({ attachView: false })
      return h('div', { className: 'st-backdrop st-stacked', onMouseDown: (e) => { if (e.target === e.currentTarget) back() } },
        h('div', { className: 'st-dialog st-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择要释放的附件' },
          h('div', { className: 'st-dlg-head' },
            h('div', null,
              h('h2', null, '这段对话用了 ' + (own.length + shared.length) + ' 个附件'),
              h('div', { className: 'st-sub' }, '标「仅这段对话」的可以清；标「共用」的还有别的对话在用，一定保留。')),
            h('button', { type: 'button', className: 'st-dlg-close', 'aria-label': '返回', onClick: back }, h('span', { className: 'st-ico-svg', dangerouslySetInnerHTML: { __html: ST_ICONS.close } }))),
          h('div', { className: 'st-att-note' }, '判断依据：附件在 DSH 里按内容共用，同一个文件只存一份，被几个对话引用就有几个引用方。删除这段对话后，只有引用数归零的附件才会变成孤儿——所以这里标「仅这段对话」的才清得掉；只要还有别的对话在用，就不动它。'),
          s.attachLoading ? h('div', { className: 'st-loading' }, '正在列出附件…') : null,
          own.length ? h('label', { className: 'st-cascade' },
            h('input', { type: 'checkbox', checked: all, onChange: () => patch({ attachSel: all ? [] : own.map((f) => f.sha) }) }),
            h('span', null,
              h('span', { className: 'st-att-cb-text' }, all ? '已全选 ' + own.length + ' 个（共 ' + mbTxt(list.ownMB) + '）' : '全选 ' + own.length + ' 个（共 ' + mbTxt(list.ownMB) + '）'),
              h('div', { className: 'st-cb-desc' }, '只勾选你确定不再需要的；不勾的会一直留着。'))) : null,
          own.length ? h('ul', { className: 'st-att-list st-pick' }, own.map((f) => h('li', { className: 'st-att-row', key: f.sha },
            h('input', { type: 'checkbox', checked: selSet.has(f.sha), onChange: () => toggle(f.sha) }),
            h('span', { className: 'st-att-thumb st-t-' + (kindOf(f.name) === 'img' ? 'img' : kindOf(f.name) === 'sheet' ? 'sheet' : kindOf(f.name) === 'zip' ? 'zip' : 'doc') }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS[kindOf(f.name)] } })),
            h('span', { className: 'st-att-main' },
              h('span', { className: 'st-att-name' }, f.name || '未命名文件'),
              h('span', { className: 'st-att-meta' }, kindLabel(f.name) + ' · ' + mbTxt(bytesToMB(f.bytes || 0)) + ' · 仅这段对话')),
            h('span', { className: 'st-att-tag st-own' }, '可清理')))) : null,
          !s.attachLoading && !own.length ? h('div', { className: 'st-att-note' }, '没有可以释放的附件：这些文件都还被别的对话共用。') : null,
          shared.length ? h('div', { className: 'st-att-list' },
            h('div', { className: 'st-sec-label' }, '还被其他对话用（一定保留）'),
            h('ul', null, shown.map((f) => h('li', { className: 'st-att-row', key: f.sha },
              h('span', { className: 'st-att-lock' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.lock } })),
              h('span', { className: 'st-att-thumb st-t-' + (kindOf(f.name) === 'img' ? 'img' : kindOf(f.name) === 'sheet' ? 'sheet' : kindOf(f.name) === 'zip' ? 'zip' : 'doc') }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS[kindOf(f.name)] } })),
              h('span', { className: 'st-att-main' },
                h('span', { className: 'st-att-name' }, f.name || '未命名文件'),
                h('span', { className: 'st-att-meta' }, kindLabel(f.name) + ' · ' + mbTxt(bytesToMB(f.bytes || 0)) + ' · 还被 ' + (f.refCount || 2) + ' 个对话使用')),
              h('span', { className: 'st-att-tag st-shared' }, '共用'))))) : null,
          shared.length > shown.length ? h('div', { className: 'st-att-note' }, '还有 ' + (shared.length - shown.length) + ' 个共用附件没列出来，反正都会保留。') : null,
          h('div', { className: 'st-dlg-foot st-split' },
            h('span', { className: 'st-att-selinfo' }, '已选 ' + (s.attachSel || []).length + ' 个 · ' + mbTxt(bytesToMB(pickedBytes(list, selSet)))),
            h('div', { className: 'st-dlg-actions' },
              h('button', { type: 'button', className: 'st-btn st-plain', onClick: back }, '返回'),
              h('button', { type: 'button', className: 'st-btn st-primary', onClick: back }, '完成')))))
    }

    const kindLabel = (name) => {
      const k = kindOf(name)
      return k === 'img' ? '图片' : k === 'sheet' ? '表格' : k === 'zip' ? '压缩包' : '文本'
    }

    function ConfirmCard() {
      const s = useStore()
      const d = s.data
      const v = verdictOf(d)
      const [details, setDetails] = React.useState(false)
      const title = (d && d.title) || s.title || s.sessionId
      const wsLabel = d && d.workspace ? (d.workspace.title || d.workspace.id) : ''
      const disabled = s.loading || s.busy || Boolean(d && (d.trashed || !d.dirFound))
      const close = () => { if (!s.busy) patch({ open: false }) }

      const lost = []
      if (d && d.dirFound) {
        lost.push({ key: 'log', text: '这段对话的聊天记录（' + (d.retentionDays || 30) + ' 天内可从回收站找回）' })
        if (d.live) lost.push({ key: 'run', text: '会先中断当前正在生成的回答（等同于点「停止」）' })
        if (d.forks && d.forks.count) lost.push({ key: 'forks', text: d.forks.count + ' 个对话是从它分叉出来的：「来源」链接会断，内容还能打开' })
        if (d.subagents && d.subagents.count) lost.push({ key: 'subs', text: '它下面还有 ' + d.subagents.count + ' 个子任务会话，删完在列表里就找不到入口了' })
        if (d.reminders && d.reminders.count) {
          lost.push({ key: 'rem', text: d.reminders.count + ' 个定时提醒会跟着失效' + (d.reminders.items && d.reminders.items[0] ? '（如「' + d.reminders.items[0].title + '」）' : ''), act: '去处理' })
        }
        if (d.team && d.team.inTeam && d.team.role === 'teammate') lost.push({ key: 'team', text: '队长那边会少一个成员，之后没法再给它发消息' })
        if (d.team && d.team.inTeam && d.team.role === 'lead') lost.push({ key: 'teamlead', text: '整个团队（' + (d.team.members || 0) + ' 个成员）的协作关系会一起消失' })
        if (d.goal && d.goal.present) lost.push({ key: 'goal', text: '有一个' + (d.goal.phase === 'active' ? '进行中' : d.goal.phase === 'paused' ? '已暂停' : '已阻塞') + '的目标会一起消失' + (d.goal.objective ? '（「' + d.goal.objective + '」）' : '') })
      }

      const cwd = (d && d.cwd) || '工作目录'
      const att = d && d.attachments
      const pct = att && att.total ? Math.max(4, Math.round((att.ownCount / att.total) * 100)) : 0
      const forksCount = (d && d.forks && d.forks.count) || 0
      const noCascade = Boolean(d && d.team && d.team.inTeam)

      return h('div', { className: 'st-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget) close() } },
        h('div', { className: 'st-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除会话' },
          h('div', { className: 'st-dlg-head' },
            h('div', null,
              h('h2', null, '删除「' + title + '」？'),
              h('div', { className: 'st-sub' }, (wsLabel ? '位于 ' + wsLabel + ' · ' : '') + (d && d.sizeMB ? '本地 ' + mbTxt(d.sizeMB) : '大小未知') + (d && d.archived ? ' · 已归档' : '') + (d && d.pinned ? ' · 已置顶' : ''))),
            h('button', { type: 'button', className: 'st-dlg-close', 'aria-label': '关闭', onClick: close }, h('span', { className: 'st-ico-svg', dangerouslySetInnerHTML: { __html: ST_ICONS.close } }))),

          s.loading ? h('div', { className: 'st-verdict st-idle' }, h('span', { className: 'st-vicon' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.dot } })), h('span', null, '正在检查影响…')) : null,
          s.error ? h('div', { className: 'st-verdict st-bad' }, h('span', { className: 'st-vicon' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.dot } })), h('span', null, s.error)) : null,
          !s.loading && d ? h('div', { className: 'st-verdict st-' + v.tone },
            h('span', { className: 'st-vicon' }, h('span', { dangerouslySetInnerHTML: { __html: v.tone === 'ok' ? ST_ICONS.check : ST_ICONS.dot } })),
            h('span', null, v.text)) : null,

          lost.length ? h('div', { className: 'st-sec st-lost' },
            h('div', { className: 'st-sec-label' }, '会失去'),
            h('ul', null, lost.map((it) => h('li', { key: it.key },
              h('span', { className: 'st-li-ico' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.dot } })),
              h('span', { className: 'st-txt' }, it.text),
              it.act ? h('button', { type: 'button', className: 'st-act', onClick: () => toast('提醒要在会话里单独处理，这里只提示') }, it.act) : null)))) : null,

          h('div', { className: 'st-sec st-kept' },
            h('div', { className: 'st-sec-label' }, '会留下'),
            h('ul', null,
              ['「' + cwd + '」里的文件不会被删', '图片和附件默认保留，其他对话共用的部分一定保留', '其他对话完全不受影响'].map((t, i) => h('li', { key: i },
                h('span', { className: 'st-li-ico' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.check } })),
                h('span', { className: 'st-txt' }, t))))),

          att && att.total ? h('div', { className: 'st-sec' },
            h('div', { className: 'st-sec-head' },
              h('span', { className: 'st-sec-label' }, '附件'),
              h('a', { className: 'st-sec-link', role: 'button', tabIndex: 0, onClick: () => patch({ attachView: true }), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') patch({ attachView: true }) } }, '查看明细')),
            h('button', { type: 'button', className: 'st-attach-summary', onClick: () => patch({ attachView: true }) },
              h('div', { className: 'st-attach-line' }, '引用了 ', h('b', null, att.total + ' 个'), '附件，共 ', h('b', null, mbTxt(att.sizeMB)), '；其中 ', h('b', null, att.ownCount + ' 个'), '只被它使用（' + mbTxt(att.ownSizeMB) + '）。'),
              h('div', { className: 'st-attach-bar' }, h('i', { style: { width: pct + '%' } })),
              h('div', { className: 'st-attach-sub' }, att.sharedCount
                ? '另外 ' + att.sharedCount + ' 个还被其他对话共用（' + mbTxt(att.sharedSizeMB) + '），会保留。'
                : '没有其他对话在用这些附件。')),
            h(AttachPickRow)) : null,

          forksCount ? h('label', { className: 'st-cascade' + (noCascade ? ' st-disabled' : '') },
            h('input', {
              type: 'checkbox',
              checked: s.includeForks === true,
              disabled: noCascade,
              onChange: (e) => patch({ includeForks: e.target.checked }),
            }),
            h('span', null,
              h('span', { className: 'st-att-cb-text' }, '连同 ', h('b', null, String(forksCount)), ' 个从它分叉出去的对话一起删除'),
              h('div', { className: 'st-cb-desc' }, noCascade
                ? '团队会话不支持连带删除分叉：分叉出去的对话会保留，先确认没有人在用。'
                : '不勾选的话，分叉出去的对话会保留，只是「来源」链接会断掉。'))) : null,

          h('div', { className: 'st-hint-line' }, '只想让它从列表消失？用 ', h('a', { role: 'button', tabIndex: 0, onClick: () => toast('归档在会话菜单里：⋯ → 归档会话') }, '「归档」'), ' 也可以。删之前想留个底，可以 ', h('a', { role: 'button', tabIndex: 0, onClick: () => { patch({ open: false }); openExport(s.sessionId, title) } }, '导出这段对话'), '。'),

          h('button', { type: 'button', className: 'st-details-toggle', 'aria-expanded': details ? 'true' : 'false', onClick: () => setDetails(!details) },
            h('span', { className: 'st-chev', dangerouslySetInnerHTML: { __html: ST_ICONS.chev } }),
            '检查范围与详情'),
          details ? h('div', { className: 'st-details-body st-show' },
            h('div', null, '检查范围只含 DSH 自己记录的关系：会话运行状态、分叉来源、子任务、提醒、目标、团队、终端占用。'),
            h('div', { className: 'st-det-gap' }, '第三方插件在会话之外保存的数据（记忆、花费账本等）不在检查范围里。'),
            h('div', { className: 'st-det-gap' }, '删除后，会话目录会移到 ', h('code', null, '~/.dsh/session-trash/payload/'), '，同时从工作区清单的三处移除（会话列表、归档列表、置顶列表）；恢复时按原工作区和原顺序放回。')) : null,

          h('div', { className: 'st-dlg-foot' },
            h('button', { type: 'button', className: 'st-btn st-plain', onClick: close, disabled: s.busy }, '取消'),
            h('button', {
              type: 'button', className: 'st-btn st-danger', disabled, onClick: doDelete,
            }, s.busy ? '正在移入…' : (s.includeForks && forksCount && !noCascade ? '移入回收站（含 ' + forksCount + ' 个）' : '移入回收站')))))
    }

    function Toast() {
      const s = useStore()
      if (!s.toast) return null
      const t = s.toast
      return h('div', { className: 'st-root' },
        h('div', { className: 'st-toast-wrap' },
          h('div', { className: 'st-toast', role: 'status' },
            h('span', null, t.text),
            t.actionLabel ? h('button', {
              type: 'button', className: 'st-toast-act',
              onClick: () => { t.action && t.action(); patch({ toast: null }) },
            }, t.actionLabel) : null)))
    }

    /** 渲染出错时兜底：至少把错误显示在弹层里，而不是让浮层整个消失。 */
    // 设置页根级兜底：任何一个子组件渲染抛错，只坏这一页，不让整个设置区白屏
    class SettingsBoundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      componentDidCatch(err, info) { try { console.error('[session-trash] 设置页渲染出错', err, info) } catch (e) {} }
      render() {
        if (this.state.err) {
          return h('div', { className: 'st-root', style: { padding: '28px 32px', color: 'var(--label-primary)' } },
            h('h2', { style: { fontSize: '15px', fontWeight: 600, margin: '0 0 8px' } }, '回收站页出错了'),
            h('div', { style: { fontSize: '12.5px', color: 'var(--label-secondary)', lineHeight: '1.8' } },
              String((this.state.err && this.state.err.message) || this.state.err || '未知错误')),
            h('button', {
              type: 'button', onClick: () => this.setState({ err: null }),
              style: { marginTop: '14px', padding: '5px 12px', borderRadius: '8px', fontSize: '12.5px', cursor: 'pointer', border: '1px solid var(--border-l2)', background: 'var(--bg-base)', color: 'var(--label-primary)' },
            }, '重试'))
        }
        return this.props.children
      }
    }

    class OverlayBoundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      componentDidCatch(err) { try { console.error('[dsh-session-trash]', err) } catch { /* ignore */ } }
      render() {
        if (this.state.err) {
          return h('div', { className: 'st-root' }, h('div', { className: 'st-backdrop' },
            h('div', { className: 'st-dialog', role: 'dialog', 'aria-modal': 'true' },
              h('div', { className: 'st-dlg-head' }, h('div', null, h('h2', null, '界面出错了'))),
              h('div', { className: 'st-att-note' }, String((this.state.err && this.state.err.message) || this.state.err)),
              h('div', { className: 'st-dlg-foot' },
                h('button', { type: 'button', className: 'st-btn st-primary', onClick: () => this.setState({ err: null }) }, '重试')))))
        }
        return this.props.children
      }
    }

    function PurgeDialog() {
      const s = useStore()
      const cp = s.confirmPurge
      if (!cp) return null
      const rows = (s.trash || []).filter((r) => cp.ids.includes(r.trashId))
      const one = rows.length === 1
      return h('div', { className: 'st-root' },
        h('div', { className: 'st-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget) patch({ confirmPurge: null }) } },
          h('div', { className: 'st-dialog', role: 'dialog', 'aria-modal': 'true' },
            h('div', { className: 'st-dlg-head' },
              h('div', null,
                h('h2', null, '彻底删除' + (one ? '「' + (rows[0].title || rows[0].sessionId) + '」' : ' ' + cp.ids.length + ' 个对话') + '？'),
                h('div', { className: 'st-sub' }, '彻底删除后不能恢复，也不会再进回收站。')),
              h('button', { type: 'button', className: 'st-dlg-close', 'aria-label': '关闭', onClick: () => patch({ confirmPurge: null }) }, h('span', { className: 'st-ico-svg', dangerouslySetInnerHTML: { __html: ST_ICONS.close } }))),
            h('div', { className: 'st-sec st-lost' },
              h('div', { className: 'st-sec-label' }, '会发生什么'),
              h('ul', null,
                h('li', null, h('span', { className: 'st-li-ico' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.dot } })), h('span', { className: 'st-txt' }, '对话记录立即删除，没有撤销')),
                cp.releaseMB
                  ? h('li', null, h('span', { className: 'st-li-ico' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.dot } })), h('span', { className: 'st-txt' }, '登记释放的 ' + (cp.releaseCount || 0) + ' 个附件（' + mbTxt(cp.releaseMB) + '）会一起删掉；后来又被其他对话引用的会保留'))
                  : h('li', null, h('span', { className: 'st-li-ico' }, h('span', { dangerouslySetInnerHTML: { __html: ST_ICONS.dot } })), h('span', { className: 'st-txt' }, '这些对话没有登记要释放的附件，不会释放空间')))) ,
            h('div', { className: 'st-hint-line' }, '如果只是想腾地方，等保留期自动清理也一样；彻底删除只是提前执行。'),
            h('div', { className: 'st-dlg-foot' },
              h('button', { type: 'button', className: 'st-btn st-plain', onClick: () => patch({ confirmPurge: null }) }, '取消'),
              h('button', { type: 'button', className: 'st-btn st-danger', onClick: () => doPurge(cp.ids) }, cp.ids.length > 1 ? '彻底删除 ' + cp.ids.length + ' 个' : '彻底删除')))))
    }

    function Overlay() {
      const s = useStore()
      const content = h('div', {
        className: 'st-overlay-root',
        style: { position: 'fixed', inset: 0, zIndex: 2147483000, pointerEvents: 'none' },
      },
        s.open ? (s.attachView
          ? h('div', { className: 'st-root' }, h(OverlayBoundary, { key: 'sheetb' }, h(AttachSheet, { key: 'attsheet' })))
          : h('div', { className: 'st-root' }, h(OverlayBoundary, { key: 'cardb' }, h(ConfirmCard, { key: 'card' })))) : null,
        s.confirmPurge ? h('div', { className: 'st-root' }, h(OverlayBoundary, { key: 'purgeb' }, h(PurgeDialog, { key: 'purge' }))) : null,
        s.orphanOpen ? h('div', { className: 'st-root' }, h(OverlayBoundary, { key: 'orphb' }, h(OrphanDialog, { key: 'orphandlg' }))) : null,
        s.exportOpen ? h('div', { className: 'st-root' }, h(ExportDialog, { key: 'export' })) : null,
        s.importOpen ? h('div', { className: 'st-root' }, h(ImportDialog, { key: 'import' })) : null,
        h('div', { className: 'st-root' }, h(AlertBanner, { key: 'alert' })),
        h('div', { className: 'st-root' }, h(Toast, { key: 'toast' })))
      return (ReactDOM && ReactDOM.createPortal)
        ? ReactDOM.createPortal(content, document.body)
        : content
    }

    /* ── 安全 / 自检（M6） ─────────────────────────────────────────────── */

    function loadSafety() {
      getJson('/precheck').then((r) => {
        if (!r || !r.ok) return
        patch({ settings: r.settings || state.settings, precheck: r.last || state.precheck })
        if (r.last && r.last.ok === false) patch({ precheckAlert: r.last })
      }).catch(() => {})
    }

    async function setSafety(key, val) {
      try {
        const r = await postJson('/config', { [key]: val })
        if (r && r.ok) patch({ settings: r.settings })
        else toast('设置没保存成功')
      } catch (e) {
        toast('设置没保存成功：' + String((e && e.message) || e))
      }
    }

    async function runPrecheck() {
      patch({ precheckBusy: true })
      try {
        const r = await postJson('/precheck', {})
        patch({ precheckBusy: false, precheck: r, precheckAlert: r && r.ok === false ? r : null })
        toast(r && r.skipped ? '退出自检已关闭，没有体检' : r && r.ok ? '体检通过，没发现问题' : '体检发现问题，可以点「修复」')
      } catch (e) {
        patch({ precheckBusy: false })
        toast('体检失败：' + String((e && e.message) || e))
      }
    }

    async function loadFuse() {
      try {
        const r = await fetch('/dsh-command-fuse/status', { credentials: 'same-origin' })
        if (!r.ok) { patch({ fuse: null }); return }
        const data = await r.json()
        patch({ fuse: data && data.ok !== false ? data : null })
      } catch { patch({ fuse: null }) }
    }

    async function setFuse(enabled) {
      patch({ fuseBusy: true })
      try {
        const r = await fetch('/dsh-command-fuse/config', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        await loadFuse()
        toast(enabled ? '命令保险丝已开启' : '命令保险丝已关闭（危险命令不再拦）')
      } catch (e) {
        toast('改不了保险丝设置：' + String((e && e.message) || e))
      } finally {
        patch({ fuseBusy: false })
      }
    }

    async function downloadDiagnostics() {
      try {
        toast('正在打包诊断信息…')
        const data = await getJson('/diagnostics')
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        a.href = url
        a.download = 'dsh-session-trash-diagnostics-' + stamp + '.json'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        toast('诊断包已下载（不含对话正文）')
      } catch (e) {
        toast('导出诊断包失败：' + String((e && e.message) || e))
      }
    }

    async function runRepair() {
      patch({ repairBusy: true })
      try {
        const r = await postJson('/repair', {})
        const moved = r && r.reconcile ? (r.reconcile.added + r.reconcile.dropped) : 0
        patch({ repairBusy: false, precheckAlert: null, precheck: null })
        toast('已修复：回收站对齐 ' + moved + ' 处，名单里摘掉 ' + ((r && r.pulledFromWorkspace) || 0) + ' 条')
        await loadTrash(true)
      } catch (e) {
        patch({ repairBusy: false })
        toast('修复失败：' + String((e && e.message) || e))
      }
    }

    function AlertBanner() {
      const s = useStore()
      const a = s.precheckAlert
      if (!a) return null
      const probs = (a.problems || []).filter((x) => x.level !== 'info')
      return h('div', {
        style: { position: 'fixed', left: '50%', top: '14px', transform: 'translateX(-50%)', width: 'min(620px, 92vw)', zIndex: 2147483001, pointerEvents: 'auto' },
      },
        h('div', { className: 'st-soon-banner', style: { display: 'block' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { className: 'st-sb-ico' }, '!'),
            h('span', { className: 'st-sb-txt', style: { fontWeight: 600 } }, '上次退出时发现 ' + probs.length + ' 项异常'),
            h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', flex: 'none' } },
              h('button', { type: 'button', className: 'st-btn st-danger', style: { padding: '3px 10px', fontSize: '12px' }, onClick: runRepair }, s.repairBusy ? '修复中…' : '修复'),
              h('button', { type: 'button', className: 'st-btn st-plain', style: { padding: '3px 10px', fontSize: '12px' }, onClick: () => patch({ precheckAlert: null }) }, '先不管'))),
          probs.slice(0, 3).map((p, i) => h('div', { key: i, style: { marginTop: '4px', fontSize: '12px', color: 'var(--label-secondary)' } }, '· ' + p.text))))
    }

    function SafetySection() {
      const s = useStore()
      const st = s.settings || { exitCheck: true, diagnostics: false }
      const fzAct = { deny: '拒绝', 'deny-frozen': '冻结期拒绝', freeze: '冻结', 'allow-noted': '放行', 'guard-error': '异常' }
      const fz = ((s.fuse && s.fuse.recent) || []).filter((it) => it && it.summary && fzAct[it.action])
      const label = (txt) => h('div', { style: { fontSize: '12.5px', fontWeight: 400, color: 'var(--label-primary)', lineHeight: '20px' } }, txt)
      const hint = (txt) => h('div', { style: { fontSize: '12px', fontWeight: 400, color: 'var(--label-secondary)', lineHeight: '1.7', marginTop: '2px' } }, txt)
      const row = (key, title, desc, control) => h('div', {
        key,
        style: {
          display: 'grid', gridTemplateColumns: '1fr auto', columnGap: '16px', alignItems: 'center',
          padding: '11px 0', borderTop: '1px solid var(--border-l1)',
        },
      },
        h('div', { style: { minWidth: 0 } }, label(title), hint(desc)),
        h('div', { style: { width: '40px', display: 'flex', justifyContent: 'flex-end', flex: 'none' } }, control))
      const sw = (on, onClick) => h('button', {
        type: 'button', role: 'switch', 'aria-checked': !!on, onClick,
        style: {
          width: '38px', height: '22px', padding: 0, border: 0, borderRadius: '11px', cursor: 'pointer', flex: 'none',
          background: on ? 'var(--label-primary)' : 'var(--border-l2)', position: 'relative', transition: 'background .15s',
        },
      },
        h('span', { style: { position: 'absolute', top: '3px', left: on ? '19px' : '3px', width: '16px', height: '16px', borderRadius: '50%', background: 'var(--bg-base)', transition: 'left .15s' } }))
      const last = s.precheck
      const lastText = last
        ? (last.checkedAt ? new Date(last.checkedAt).toLocaleString() + ' · ' : '') + (last.ok ? '没问题' : ((last.problems || []).filter((x) => x.level !== 'info').length + ' 项异常'))
        : '还没有体检记录'
      return h('div', { style: { padding: '0 32px 30px' } },
        h('h2', { style: { fontSize: '15px', fontWeight: 600, margin: '24px 0 6px' } }, '安全'),
        h('div', { style: { fontSize: '12.5px', fontWeight: 400, color: 'var(--label-secondary)', lineHeight: '1.75', marginBottom: '4px' } },
          '这些开关管的是「插件会不会把数据写坏」：写入校验固定开启不可关；自检和诊断只在排查问题时才需要调。'),
        row('guard', '数据写入校验', '写 workspace.json 前做结构和类型检查，写完回读比对；写不进去就回滚。这一项不能关闭。',
          h('span', { style: { fontSize: '12px', fontWeight: 400, color: 'var(--label-secondary)', whiteSpace: 'nowrap' } }, '已启用')),
        row('exit', '退出时自检', '关闭应用前做一次只读体检；下次启动若发现异常，会在页面顶部提示。',
          sw(st.exitCheck, () => setSafety('exitCheck', !st.exitCheck))),
        row('diag', '诊断日志', '记录更多运行细节，只在排查问题时打开。',
          sw(st.diagnostics, () => setSafety('diagnostics', !st.diagnostics))),
        s.fuse ? row('fuse', '命令保险丝',
          '拦住递归强删、磁盘操作、危险根目录这几类命令；被拦的命令不会执行，理由会回给模型。',
          sw(!!s.fuse.enabled, () => setFuse(!s.fuse.enabled))) : null,
        fz.length
          ? h('div', { style: { marginTop: '2px', paddingTop: '10px', borderTop: '1px solid var(--border-l1)' } },
              h('div', { style: { fontSize: '12px', color: 'var(--label-secondary)', marginBottom: '6px' } },
                '最近拦截 / 放行 ' + fz.length + ' 条'),
              fz.slice(0, 5).map((it, i) => h('div', {
                key: i,
                style: { fontSize: '12px', color: 'var(--label-secondary)', lineHeight: '1.7', display: 'flex', gap: '8px' },
              },
                h('span', { style: { flex: 'none', color: 'var(--label-tertiary)' } }, it.at ? new Date(it.at).toLocaleTimeString() : ''),
                h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  fzAct[it.action] + ' · ' + String(it.summary || '').slice(0, 80)))))
          : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button', disabled: s.precheckBusy, onClick: runPrecheck,
            style: { padding: '5px 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 400, cursor: 'pointer', border: '1px solid var(--border-l2)', background: 'var(--bg-base)', color: 'var(--label-primary)' },
          }, s.precheckBusy ? '体检中…' : '立即体检'),
          h('button', {
            type: 'button', onClick: downloadDiagnostics,
            style: { padding: '5px 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 400, cursor: 'pointer', border: '1px solid var(--border-l2)', background: 'var(--bg-base)', color: 'var(--label-primary)' },
          }, '导出诊断包'),
          s.precheckAlert ? h('button', {
            type: 'button', disabled: s.repairBusy, onClick: runRepair,
            style: { padding: '5px 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 400, cursor: 'pointer', border: 0, background: 'var(--danger-solid)', color: '#fff' },
          }, s.repairBusy ? '修复中…' : '修复') : null,
          h('span', { style: { fontSize: '12px', fontWeight: 400, color: 'var(--label-secondary)' } }, lastText)))
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        try {
          if (state.settings && state.settings.exitCheck === false) return
          const blob = new Blob([JSON.stringify({})], { type: 'application/json' })
          if (navigator.sendBeacon) navigator.sendBeacon(API + '/precheck', blob)
        } catch (e) { /* 退出时失败就失败，不影响关闭 */ }
      })
    }

    /* ── 回收站设置页 ─────────────────────────────────────────────────── */

    async function loadTrash(force) {
      if (state.trashLoading) return
      if (state.trashLoaded && !force) return
      patch({ trashLoading: true, trashError: '' })
      try {
        const data = await getJson('/list')
        const rows = data.entries || []
        const valid = new Set(rows.map((r) => r.trashId))
        patch({
          trash: rows,
          trashLoading: false,
          trashLoaded: true,
          trashRetention: data.retentionDays || 30,
          soonCount: data.soonCount || 0,
          orphan: data.orphan || null,
          trashSel: state.trashSel.filter((id) => valid.has(id)),
        })
      } catch (e) {
        patch({ trashLoading: false, trashError: String((e && e.message) || e) })
      }
    }

    async function setRetention(days) {
      const next = Number(days)
      try {
        await postJson('/config', { retentionDays: next })
        patch({ trashRetention: next })
        toast('保留期已改为 ' + next + ' 天')
        await loadTrash(true)
      } catch (e) {
        toast('改保留期失败：' + String((e && e.message) || e))
      }
    }

    async function extendSoon() {
      try {
        const r = await postJson('/extend', {})
        toast(r.changed ? '已把 ' + r.changed + ' 个即将过期的对话往后顺延 ' + state.trashRetention + ' 天' : '没有需要顺延的对话')
        await loadTrash(true)
      } catch (e) {
        toast('顺延失败：' + String((e && e.message) || e))
      }
    }

    async function loadOrphanDirs() {
      try {
        const r = await getJson('/orphan-dirs')
        patch({ orphanDirs: r && r.items ? r : { ok: true, count: 0, sizeMB: 0, items: [] } })
      } catch {
        patch({ orphanDirs: { ok: false, count: 0, sizeMB: 0, items: [] } })
      }
    }

    function openOrphanDialog() {
      patch({ orphanOpen: true, orphanSel: [], orphanBusy: false })
      loadOrphanDirs()
    }

    function toggleOrphanSel(sid) {
      const has = state.orphanSel.includes(sid)
      patch({ orphanSel: has ? state.orphanSel.filter((x) => x !== sid) : state.orphanSel.concat([sid]) })
    }

    async function doOrphanCleanup() {
      const ids = state.orphanSel.slice()
      if (!ids.length || state.orphanBusy) return
      patch({ orphanBusy: true })
      try {
        const r = await postJson('/orphan-dirs', { sids: ids })
        const moved = (r && r.moved) || 0
        const skipped = (r && r.skipped) || []
        if (moved) {
          toast('已把 ' + moved + ' 个会话目录移到回收站（' + mbTxt((r && r.freedMB) || 0) + '），' + state.trashRetention + ' 天内可以恢复')
        } else {
          toast('没有搬动任何目录' + (skipped.length ? '（' + skipped.length + ' 个失败）' : ''))
        }
        patch({ orphanOpen: false, orphanSel: [], orphanBusy: false })
        await loadTrash(true)
        await loadOrphanDirs()
      } catch (e) {
        patch({ orphanBusy: false })
        toast('清理失败：' + String((e && e.message) || e))
      }
    }

    function OrphanDialog() {
      const s = useStore()
      const data = s.orphanDirs || { count: 0, sizeMB: 0, items: [] }
      const items = data.items || []
      const sel = s.orphanSel || []
      const picked = items.filter((it) => sel.includes(it.sid))
      const pickedMB = Math.round(picked.reduce((a, it) => a + (it.sizeMB || 0), 0) * 10) / 10
      const allPicked = items.length > 0 && picked.length === items.length
      const somePicked = picked.length > 0 && !allPicked
      const refAll = React.useRef(null)
      React.useEffect(() => { if (refAll.current) refAll.current.indeterminate = somePicked }, [somePicked])
      const close = () => patch({ orphanOpen: false })
      return h('div', {
        className: 'st-backdrop',
        onMouseDown: (ev) => { if (ev.target === ev.currentTarget) close() },
      },
        h('div', { className: 'st-dialog st-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': '清理孤儿会话目录' },
          h('div', { className: 'st-dlg-head' },
            h('h2', {}, '清理孤儿会话目录'),
            h('button', { type: 'button', className: 'st-dlg-close', onClick: close, 'aria-label': '关闭' },
              h('span', { className: 'st-ico-svg', dangerouslySetInnerHTML: { __html: ST_ICONS.close } }))),
          h('p', { className: 'st-sub' }, '这些目录还在磁盘上，但不属于任何工作区，侧栏里也看不到——通常是以前删掉工作区或异常退出留下的。'),
          h('div', { className: 'st-listhead' },
            h('label', { className: 'st-selall' },
              h('input', {
                type: 'checkbox', ref: refAll, checked: allPicked, disabled: !items.length,
                onChange: () => patch({ orphanSel: allPicked ? [] : items.map((it) => it.sid) }),
              }),
              h('span', {}, '全选')),
            h('span', { className: 'st-selinfo' },
              picked.length ? (allPicked ? '已全选 ' + picked.length + ' 个' : '已选 ' + picked.length + ' / ' + items.length + ' 个') : '共 ' + items.length + ' 个' + (data.sizeMB ? ' · ' + mbTxt(data.sizeMB) : ''))),
          items.length
            ? h('div', { className: 'st-trash-list', style: { maxHeight: '320px', overflowY: 'auto' } },
              items.map((it) => h('div', { className: 'st-trash-row', key: it.sid },
                h('input', {
                  className: 'st-cb', type: 'checkbox', checked: sel.includes(it.sid),
                  onChange: () => toggleOrphanSel(it.sid),
                }),
                h('div', { className: 'st-tw' },
                  h('div', { className: 'st-tt' }, it.title || it.sid),
                  h('div', { className: 'st-tm' },
                    mbTxt(it.sizeMB || 0) + (it.mtime ? ' · ' + fmtDate(it.mtime) + ' 最后修改' : '') + ' · 目录不在任何工作区')),
                h('div', { className: 'st-acts' },
                  h('button', {
                    type: 'button', className: 'st-mini',
                    onClick: () => patch({ orphanSel: [it.sid] }),
                  }, '选这个')))))
            : h('div', { className: 'st-empty' }, '没有孤儿目录，磁盘和 workspace.json 是对得上的。'),
          h('div', { className: 'st-hint-line' }, '移到回收站不会真删数据：30 天内可以在回收站里恢复（恢复后仍然是一个孤儿目录）；想要空间就在回收站里彻底删除。'),
          h('div', { className: 'st-dlg-foot' },
            h('button', { type: 'button', className: 'st-btn st-plain', onClick: close }, '取消'),
            h('button', {
              type: 'button', className: 'st-btn st-danger',
              disabled: !picked.length || s.orphanBusy,
              onClick: doOrphanCleanup,
            }, s.orphanBusy ? '处理中…' : (picked.length ? '移到回收站（' + picked.length + ' 个 · ' + mbTxt(pickedMB) + '）' : '移到回收站')))))
    }

    async function cleanOrphans() {
      try {
        const r = await postJson('/orphans', { clean: true })
        toast(r.freed ? '已清理 ' + r.freed + ' 个无引用附件（' + mbTxt(r.freedMB) + '）' : '没有可清理的附件')
        await loadTrash(true)
      } catch (e) {
        toast('清理失败：' + String((e && e.message) || e))
      }
    }

    function toggleSel(trashId) {
      const has = state.trashSel.includes(trashId)
      patch({ trashSel: has ? state.trashSel.filter((x) => x !== trashId) : state.trashSel.concat([trashId]) })
    }

    async function restoreEntry(trashId) {
      try {
        await postJson('/restore', { trashId })
        toast('已恢复到原来的位置', '刷新页面', () => { softRefresh() })
        await loadTrash(true)
      } catch (e) {
        toast('恢复失败：' + String((e && e.message) || e))
      }
    }

    function openPurge(ids) {
      const picked = (state.trash || []).filter((r) => ids.includes(r.trashId))
      const releaseMB = picked.reduce((sum, r) => sum + ((r.attachments && r.attachments.selectedMB) || 0), 0)
      const releaseCount = picked.reduce((sum, r) => sum + ((r.attachments && r.attachments.selectedCount) || 0), 0)
      patch({ confirmPurge: { ids, releaseMB: Math.round(releaseMB * 10) / 10, releaseCount } })
    }

    async function doPurge(ids) {
      try {
        const r = ids.length > 1 ? await postJson('/purge-batch', { trashIds: ids }) : await postJson('/purge', { trashId: ids[0] })
        patch({ confirmPurge: null, trashSel: [] })
        const rel = r.release || {}
        const freed = rel.freed ? '，释放 ' + rel.freed + ' 个附件（' + mbTxt(rel.freedMB) + '）' : ''
        const kept = rel.keptBecause && rel.keptBecause.length ? '；' + rel.keptBecause.length + ' 个后来又被其他对话引用，保留' : ''
        toast('已彻底删除，无法恢复' + freed + kept)
        await loadTrash(true)
      } catch (e) {
        toast('彻底删除失败：' + String((e && e.message) || e))
      }
    }

    async function restoreSelected() {
      const ids = state.trashSel
      if (!ids.length) return
      try {
        const r = ids.length > 1 ? await postJson('/restore-batch', { trashIds: ids }) : await postJson('/restore', { trashId: ids[0] })
        const restored = r.restored !== undefined ? r.restored : 1
        patch({ trashSel: [] })
        toast('已恢复 ' + restored + ' 个对话', '刷新页面', () => { softRefresh() })
        await loadTrash(true)
      } catch (e) {
        toast('批量恢复失败：' + String((e && e.message) || e))
      }
    }

    async function loadArchive() {
      try {
        const r = await getJson('/archive')
        if (!r || r.ok === false) throw new Error((r && (r.error || r.code)) || '读取失败')
        patch({ archive: r.entries || r.items || [], archiveTotalMB: r.totalMB || 0, archiveMaxMB: r.maxMB || 2048, archiveLoaded: true, archiveBusy: false })
      } catch (e) {
        patch({ archiveLoaded: true, archiveBusy: false })
        toast('读不出文件留档：' + (e && e.message ? e.message : e))
      }
    }

    async function snapshotNow() {
      patch({ archiveBusy: true })
      try {
        const r = await postJson('/archive/snapshot', { scope: 'metadata' })
        if (r && r.ok) { toast('已留档一份元数据快照'); await loadArchive() } else toast('留档失败：' + ((r && (r.error || r.code)) || '未知错误'))
      } catch (e) { toast('留档失败：' + (e && e.message ? e.message : e)) } finally { patch({ archiveBusy: false }) }
    }

    function downloadArchive(a) {
      const url = API + '/archive/download?archiveId=' + encodeURIComponent(a.archiveId)
      fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob() }).then((blob) => {
        const u = URL.createObjectURL(blob)
        const el = document.createElement('a')
        el.href = u
        el.download = (a.kind || 'archive') + '-' + String(a.archiveId).slice(-8) + '.zst'
        document.body.appendChild(el); el.click(); el.remove()
        setTimeout(() => URL.revokeObjectURL(u), 4000)
      }).catch((e) => toast('下载失败：' + (e && e.message ? e.message : e)))
    }

    async function peekArchive(a) {
      try {
        const r = await getJson('/archive/peek?archiveId=' + encodeURIComponent(a.archiveId))
        if (!r || r.ok === false) throw new Error((r && (r.error || r.code)) || '读取失败')
        const names = (r.files || []).map((f) => String(f.path || '').split('/').pop()).slice(0, 6)
        toast('包里有 ' + (r.files || []).length + ' 个文件：' + names.join('、') + ((r.files || []).length > 6 ? ' 等' : ''))
      } catch (e) { toast('看不了：' + (e && e.message ? e.message : e)) }
    }

    async function restoreArchiveNow(a) {
      if (a.kind === 'boot') { toast('启动快照是整库元数据，只用于下载对照，不能直接还原'); return }
      if (state.archiveArm !== a.archiveId) { patch({ archiveArm: a.archiveId }); toast('再点一次「还原」，会把这段对话放回原工作区'); return }
      patch({ archiveArm: '', archiveBusy: true })
      try {
        const r = await postJson('/archive/restore', { archiveId: a.archiveId })
        if (r && r.ok) { toast('已还原' + (r.sessionId ? '，会话 ' + String(r.sessionId).slice(-8) : '')); await loadArchive(); await refreshSessionList() }
        else if (r && (r.code === 'TARGET_EXISTS')) toast('没有还原：原位置已经有这段对话了')
        else if (r && (r.code === 'BOOT_NOT_RESTORABLE')) toast('启动快照不能直接还原')
        else toast('还原失败：' + ((r && (r.error || r.code)) || '未知错误'))
      } catch (e) { toast('还原失败：' + (e && e.message ? e.message : e)) } finally { patch({ archiveBusy: false }) }
    }

    async function purgeArchiveNow(a) {
      if (state.archiveArm !== a.archiveId) { patch({ archiveArm: a.archiveId }); toast('再点一次「删除」，留档包会真的删掉'); return }
      patch({ archiveArm: '', archiveBusy: true })
      try {
        const r = await postJson('/archive/purge', { archiveIds: [a.archiveId] })
        if (r && r.ok) { toast('已删除留档包' + (r.freedMB ? '，释放 ' + mbTxt(r.freedMB) : '')); await loadArchive() }
        else toast('删除失败：' + ((r && (r.error || r.code)) || '未知错误'))
      } catch (e) { toast('删除失败：' + (e && e.message ? e.message : e)) } finally { patch({ archiveBusy: false }) }
    }

    function archiveSection(s) {
      const all = s.archive || []
      const q = String(s.archiveQuery || '').trim().toLowerCase()
      const kind = s.archiveKind || 'all'
      const items = all.filter((a) => {
        if (kind !== 'all' && a.kind !== kind) return false
        if (!q) return true
        return String(a.title || '').toLowerCase().includes(q) || String(a.sessionId || '').toLowerCase().includes(q) || String(a.reason || '').toLowerCase().includes(q)
      })
      const used = Number(s.archiveTotalMB || 0)
      const cap = Number(s.archiveMaxMB || 2048)
      const kindLabel = (k) => k === 'boot' ? '启动快照' : (k === 'predelete' ? '删除前快照' : '留档')
      const rows = items.map((a) => {
        const arm = s.archiveArm === a.archiveId
        const isBoot = a.kind === 'boot'
        return h('div', { className: 'st-trash-row', key: a.archiveId },
          h('div', { className: 'st-tw' },
            h('div', { className: 'st-tt' }, a.title || (isBoot ? '元数据整库快照' : String(a.sessionId || a.archiveId).slice(-8)),
              h('span', { className: 'st-soon' }, kindLabel(a.kind))),
            h('div', { className: 'st-tm' },
              (a.reason || (isBoot ? '当天首次启动时自动留档' : '删除前自动留档')) + ' · ' + fmtDate(a.createdAt) + ' · ' + mbTxt(a.sizeMB || 0)
                + (a.daysLeft !== undefined ? ' · 还剩 ' + a.daysLeft + ' 天' : '')
                + (a.broken ? ' · 文件缺失' : ''))),
          h('div', { className: 'st-acts' },
            h('button', { type: 'button', className: 'st-mini', onClick: () => downloadArchive(a) }, '下载'),
            h('button', { type: 'button', className: 'st-mini', onClick: () => peekArchive(a) }, '查看'),
            isBoot ? null : h('button', { type: 'button', className: 'st-mini' + (arm ? ' st-confirm' : ''), onClick: () => restoreArchiveNow(a) }, arm ? '确认还原' : '还原'),
            h('button', { type: 'button', className: 'st-mini st-danger' + (arm ? ' st-confirm' : ''), onClick: () => purgeArchiveNow(a) }, arm ? '确认删除' : '删除')))
      })
      return h(React.Fragment, null,
        h('p', { className: 'st-sub', style: { marginTop: 8 } },
          '每次启动、以及每次彻底删除之前，插件会把相关元数据（会话日志、workspace.json、回收站索引）打包留档在这里；',
          '留档不占回收站的保留期，按同样的保留天数单独过期。只覆盖元数据，不备份工作目录里的文件。'),
        h('div', { className: 'st-hint-line', style: { marginTop: 8 } },
          '留档包里是完整的对话内容（未加密），下载后请自行保管，别随手转发。'),
        h('div', { className: 'st-trash-toolbar' },
          h('label', { className: 'st-search' },
            h('input', { type: 'search', placeholder: '搜索留档', value: s.archiveQuery || '', onChange: (e) => patch({ archiveQuery: e.target.value }) })),
          h('div', { className: 'st-segctl', role: 'tablist', 'aria-label': '筛选留档' },
            h('button', { type: 'button', role: 'tab', 'aria-selected': kind === 'all' ? 'true' : 'false', className: kind === 'all' ? 'st-on' : '', onClick: () => patch({ archiveKind: 'all' }) }, '全部'),
            h('button', { type: 'button', role: 'tab', 'aria-selected': kind === 'predelete' ? 'true' : 'false', className: kind === 'predelete' ? 'st-on' : '', onClick: () => patch({ archiveKind: 'predelete' }) }, '删除前'),
            h('button', { type: 'button', role: 'tab', 'aria-selected': kind === 'boot' ? 'true' : 'false', className: kind === 'boot' ? 'st-on' : '', onClick: () => patch({ archiveKind: 'boot' }) }, '启动快照')),
          h('span', { className: 'st-grow' }),
          h('span', { className: 'st-selinfo' }, '已用 ' + mbTxt(used) + ' / ' + Math.round(cap) + ' MB'),
          h('button', { type: 'button', className: 'st-mini', disabled: !!s.archiveBusy, onClick: snapshotNow }, s.archiveBusy ? '留档中…' : '现在留档')),
        items.length
          ? h('div', { className: 'st-trash-list', style: { marginTop: 10 } }, rows)
          : h('div', { className: 'st-empty' }, !s.archiveLoaded ? '读取中…' : (all.length ? '没有匹配的留档包。' : '还没有留档。插件会在启动时自动留档一份元数据快照。')),
        h('div', { className: 'st-trash-foot' },
          h('span', { className: 'st-count' }, '共 ' + all.length + ' 个留档包' + (items.length !== all.length ? ' · 匹配 ' + items.length + ' 个' : '')),
          h('span', null)))
    }

    function TrashPage() {
      const s = useStore()
      React.useEffect(() => { loadTrash(); loadOrphanDirs(); loadSafety(); loadFuse() }, [])
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [page, setPage] = React.useState(1)
      const [pageSize, setPageSize] = React.useState(10)

      const all = s.trash || []
      const q = query.trim().toLowerCase()
      const items = all.filter((r) => {
        if (q && !(String(r.title || '').toLowerCase().includes(q) || String(r.sessionId || '').toLowerCase().includes(q))) return false
        if (filter === 'week' && (r.daysLeft || 0) <= (s.trashRetention || 30) - 7) return false
        if (filter === 'expiring' && !(r.soon || (r.daysLeft || 99) <= 3)) return false
        return true
      })
      const pages = Math.max(1, Math.ceil(items.length / pageSize))
      const cur = Math.min(Math.max(1, page), pages)
      const start = (cur - 1) * pageSize
      const pageItems = items.slice(start, start + pageSize)
      const sel = s.trashSel || []
      const selCount = items.filter((r) => sel.includes(r.trashId)).length
      const allPicked = items.length > 0 && selCount === items.length
      const somePicked = selCount > 0 && !allPicked
      const refAll = React.useRef(null)
      React.useEffect(() => { if (refAll.current) refAll.current.indeterminate = somePicked }, [somePicked])

      const soon = all.filter((r) => r.soon || (r.daysLeft || 99) <= 3)
      const minDays = soon.length ? Math.min.apply(null, soon.map((r) => (r.daysLeft === undefined ? 3 : r.daysLeft))) : 0

      const tab = s.tab === 'archive' ? 'archive' : 'sessions'
      const head = h('div', { className: 'st-settings-body' },
        h('h2', null, '回收站'),
        h('div', { className: 'st-tabs' },
          h('button', { type: 'button', className: 'st-tab' + (tab === 'sessions' ? ' st-on' : ''), onClick: () => patch({ tab: 'sessions' }) }, '会话'),
          h('button', { type: 'button', className: 'st-tab' + (tab === 'archive' ? ' st-on' : ''), onClick: () => { patch({ tab: 'archive' }); if (!s.archiveLoaded) loadArchive() } }, '文件留档')),
        tab === 'archive' ? archiveSection(s) : h(React.Fragment, null,
        h('p', { className: 'st-sub' },
          '删除的对话会在保留期（当前 ', h('b', null, s.trashRetention + ' 天'), '，只对之后删除的生效）内留在这里，之后自动清理，过期不可恢复。',
          h('br', null),
          '「归档」只是把对话从列表里藏起来，不占回收站，也不会删除任何数据。'),
        soon.length ? h('div', { className: 'st-soon-banner' },
          h('span', { className: 'st-sb-ico', dangerouslySetInnerHTML: { __html: '!' } }),
          h('span', { className: 'st-sb-txt' }, soon.length + ' 个对话即将过期（还剩 ' + Math.max(1, minDays) + ' 天），过期后无法恢复'),
          h('span', { className: 'st-grow' }),
          h('button', { type: 'button', className: 'st-mini', onClick: extendSoon }, '延长保留')) : null,
        s.orphan && s.orphan.count ? h('div', { className: 'st-soon-banner' },
          h('span', { className: 'st-sb-ico', dangerouslySetInnerHTML: { __html: '!' } }),
          h('span', { className: 'st-sb-txt' }, '另有 ' + s.orphan.count + ' 个附件文件（' + mbTxt(s.orphan.sizeMB) + '）已经不属任何对话'),
          h('span', { className: 'st-grow' }),
          h('button', { type: 'button', className: 'st-mini', onClick: cleanOrphans }, '清理')) : null,
        s.orphanDirs && s.orphanDirs.count ? h('div', { className: 'st-soon-banner' },
          h('span', { className: 'st-sb-ico', dangerouslySetInnerHTML: { __html: '!' } }),
          h('span', { className: 'st-sb-txt' }, '有 ' + s.orphanDirs.count + ' 个会话目录不属于任何工作区（' + mbTxt(s.orphanDirs.sizeMB) + '），可以清理'),
          h('span', { className: 'st-grow' }),
          h('button', { type: 'button', className: 'st-mini', onClick: openOrphanDialog }, '查看')) : null,
        h('div', { className: 'st-trash-toolbar' },
          h('label', { className: 'st-search' },
            h('input', { type: 'search', placeholder: '搜索回收站', value: query, onChange: (e) => { setQuery(e.target.value); setPage(1) } })),
          h('div', { className: 'st-segctl', role: 'tablist', 'aria-label': '筛选回收站' },
            h('button', { type: 'button', role: 'tab', 'aria-selected': filter === 'all' ? 'true' : 'false', className: filter === 'all' ? 'st-on' : '', onClick: () => { setFilter('all'); setPage(1) } }, '全部'),
            h('button', { type: 'button', role: 'tab', 'aria-selected': filter === 'week' ? 'true' : 'false', className: filter === 'week' ? 'st-on' : '', onClick: () => { setFilter('week'); setPage(1) } }, '近 7 天'),
            h('button', { type: 'button', role: 'tab', 'aria-selected': filter === 'expiring' ? 'true' : 'false', className: filter === 'expiring' ? 'st-on' : '', onClick: () => { setFilter('expiring'); setPage(1) } }, '即将过期')),
          h('label', { className: 'st-retention' }, '保留',
            h('select', { value: String(s.trashRetention), onChange: (e) => setRetention(e.target.value) },
              [7, 30, 90].map((d) => h('option', { key: d, value: String(d) }, d + ' 天')))),
          h('button', { type: 'button', className: 'st-mini', onClick: openImport }, '从文件导入…')),
        h('div', { className: 'st-listhead' },
          h('label', { className: 'st-selall' }, h('input', { type: 'checkbox', ref: refAll, checked: allPicked, disabled: !items.length, onChange: () => patch({ trashSel: allPicked ? [] : items.map((r) => r.trashId) }) }), h('span', null, '全选')),
          h('span', { className: 'st-selinfo' }, selCount ? (selCount === items.length ? '已全选 ' + selCount + ' 个' : '已选 ' + selCount + ' / ' + items.length + ' 个') : '共 ' + items.length + ' 个'),
          h('span', { className: 'st-grow' }),
          h('button', { type: 'button', className: 'st-mini', disabled: !sel.length, onClick: restoreSelected }, '恢复'),
          h('button', { type: 'button', className: 'st-mini st-danger', disabled: !sel.length, onClick: () => openPurge(sel.slice()) }, '彻底删除'),
          h('button', { type: 'button', className: 'st-tiny', disabled: !sel.length, onClick: () => patch({ trashSel: [] }) }, '取消')),
        s.trashError
          ? h('div', { className: 'st-verdict st-bad' }, h('span', { className: 'st-txt' }, '读不出来：' + s.trashError))
          : items.length
            ? h('div', { className: 'st-trash-list' }, pageItems.map((r) => h('div', { className: 'st-trash-row', key: r.trashId },
              h('input', { className: 'st-cb', type: 'checkbox', checked: sel.includes(r.trashId), onChange: () => toggleSel(r.trashId) }),
              h('div', { className: 'st-tw' },
                h('div', { className: 'st-tt' }, r.title || r.sessionId,
                  (r.soon || (r.daysLeft || 99) <= 3) ? h('span', { className: 'st-soon' }, '即将过期') : null),
                h('div', { className: 'st-tm' },
                  (r.workspaceTitle || r.workspaceId || '未分组') + ' · ' + fmtDate(r.deletedAt) + ' 删除 · 还剩 ' + (r.daysLeft || 0) + ' 天',
                  r.withForks ? ' · 含 ' + r.withForks + ' 个分叉（一起恢复 / 彻底删除）' : '',
                  r.group ? ' · 随父对话一起处理' : '',
                  r.attachments && r.attachments.selectedCount ? ' · 附件 ' + r.attachments.selectedCount + ' 个待释放（' + mbTxt(r.attachments.selectedMB) + '）' : (r.attachments && r.attachments.count ? ' · 附件 ' + r.attachments.count + ' 个，未选择释放' : ''))),
              h('div', { className: 'st-acts' },
                h('button', { type: 'button', className: 'st-mini', onClick: () => restoreEntry(r.trashId) }, '恢复'),
                h('button', { type: 'button', className: 'st-mini st-danger', onClick: () => openPurge([r.trashId]) }, '彻底删除')))))
            : h('div', { className: 'st-empty' }, s.trashLoading ? '读取中…' : (q ? '没有匹配「' + query + '」的对话。换个关键词或筛选试试。' : '回收站是空的。删除的对话会在这里保留 ' + s.trashRetention + ' 天，随时可以恢复。')),
        h('div', { className: 'st-trash-foot' },
          h('span', { className: 'st-count' }, '共 ' + all.length + ' 个对话' + (items.length !== all.length ? ' · 匹配 ' + items.length + ' 个' : '') + (items.length ? ' · 第 ' + cur + '/' + pages + ' 页' : '')),
          h('div', { className: 'st-pager' },
            h('select', { className: 'st-psize', value: String(pageSize), onChange: (e) => { setPageSize(Number(e.target.value)); setPage(1) } },
              [10, 20, 50].map((n) => h('option', { key: n, value: String(n) }, n + ' / 页'))),
            h('button', { type: 'button', disabled: cur <= 1, onClick: () => setPage(cur - 1), 'aria-label': '上一页' }, '‹'),
            Array.from({ length: pages }, (_, i) => i + 1).map((p) => h('button', { key: p, type: 'button', className: p === cur ? 'st-on' : '', onClick: () => setPage(p) }, String(p))),
            h('button', { type: 'button', disabled: cur >= pages, onClick: () => setPage(cur + 1), 'aria-label': '下一页' }, '›')),
          h('button', { type: 'button', className: 'st-mini st-ghost', disabled: !all.length, onClick: () => openPurge(all.map((r) => r.trashId)) }, '清空回收站'))))

      return h('div', { className: 'st-root' }, head)
    }

    /* ── 样式 ─────────────────────────────────────────────────────────── */

    const CSS = "/* 菜单项（插进宿主菜单，跟着宿主的尺寸） */\n.st-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;text-align:left;border-radius:6px;cursor:pointer}\n.st-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}\n.st-menu-ico{display:inline-flex;width:14px;height:14px;flex:none;opacity:.9}\n.st-menu-ico svg{width:14px;height:14px}\n.st-menu-text{white-space:nowrap}\n\n/* 导出 / 导入弹层（这两个还没按原型重画，先用独立前缀，不跟移植样式抢类名） */\n.stx-backdrop{position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.34);backdrop-filter:blur(2px)}\n.stx-dialog{width:min(460px,100%);max-height:calc(100vh - 48px);overflow:auto;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.28);padding:18px 20px 14px}\n.stx-head{display:flex;align-items:flex-start;gap:10px}\n.stx-title{flex:1;font-size:15px;font-weight:600;line-height:1.5}\n.stx-x{flex:none;width:24px;height:24px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer;border-radius:6px}\n.stx-x:hover{background:var(--dsw-alias-bg-layer-2)}\n.stx-body{padding:2px 0 0}\n.stx-hint{margin-top:8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}\n.stx-verdict{margin-top:10px;padding:9px 12px;border-radius:8px;font-size:12.5px;line-height:1.6}\n.stx-verdict.idle{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}\n.stx-verdict.danger{background:rgba(214,72,60,.12);color:var(--dsw-alias-state-error-primary)}\n.stx-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}\n.stx-btn{height:30px;padding:0 14px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}\n.stx-btn:hover{background:var(--dsw-alias-bg-layer-2)}\n.stx-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}\n.stx-btn:disabled{opacity:.45;cursor:default}\n.stx-fmt-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}\n.stx-chip{padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}\n.stx-chip.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}\n.stx-textarea{width:100%;box-sizing:border-box;margin-top:10px;padding:9px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;resize:vertical;font-family:inherit}\n.stx-file-row{display:flex;gap:8px;margin-top:8px}\n.stx-imp-preview{margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1)}\n.stx-imp-title{margin:0 0 4px;font-size:12.5px;color:var(--dsw-alias-label-primary);word-break:break-all}\n\n/* ===== 以下从 HTML 原型移植（dsh-delete-session-prototype.html），类名统一 st- 前缀 ===== */\n/* 从 HTML 原型移植的样式：类名统一 st- 前缀，颜色全部走 DSH 主题 token */\n.st-root{\n  --bg-base:var(--dsw-alias-bg-base);\n  --bg-layer-1:var(--dsw-alias-bg-layer-1);\n  --bg-layer-2:var(--dsw-alias-bg-layer-2);\n  --bg-overlay:var(--dsw-alias-bg-overlay);\n  --border-l1:var(--dsw-alias-border-l1);\n  --border-l2:var(--dsw-alias-border-l2);\n  --label-primary:var(--dsw-alias-label-primary);\n  --label-secondary:var(--dsw-alias-label-secondary);\n  --label-tertiary:color-mix(in srgb, var(--dsw-alias-label-secondary) 72%, transparent);\n  --brand:var(--dsw-alias-brand-primary);\n  --brand-soft:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);\n  --danger:var(--dsw-alias-state-error-primary);\n  --danger-solid:var(--dsw-alias-state-error-primary);\n  --warn:var(--dsw-alias-state-warn-primary);\n  --success:var(--dsw-alias-state-success-primary);\n  --idle:var(--dsw-alias-state-idle-primary);\n  --row-hover:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);\n  --row-active:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);\n  --tint-success:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);\n  --tint-warn:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);\n  --tint-danger:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);\n  --tint-idle:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);\n  --shadow-menu:0 8px 24px rgba(0,0,0,.12),0 1px 3px rgba(0,0,0,.08);\n  --shadow-modal:0 24px 64px rgba(0,0,0,.18),0 4px 12px rgba(0,0,0,.08);\n  --shadow-toast:0 10px 28px rgba(0,0,0,.22);\n  --code-bg:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);\n  font:13px/1.5 system-ui,-apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;\n  color:var(--label-primary);\n}\n.st-root button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}\n.st-root svg{width:16px;height:16px;flex:none;display:block}\n.st-details-toggle .st-chev svg{width:12px;height:12px}\n.st-root a{color:inherit}\n\n  .st-root,.st-root *,.st-root *::before,.st-root *::after{box-sizing:border-box}\n  .st-proto-bar{\n    height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;\n    background:var(--bg-layer-1);border-bottom:1px solid var(--border-l1);\n    font-size:12.5px;color:var(--label-secondary);\n  }\n  .st-proto-bar b{color:var(--label-primary);font-weight:600;font-size:13px}\n  .st-proto-bar .st-spacer{flex:1}\n  .st-seg{display:flex;background:var(--bg-layer-2);border-radius:8px;padding:2px}\n  .st-seg button{padding:3px 10px;border-radius:6px;color:var(--label-secondary);font-size:12px}\n  .st-seg button.st-on{background:var(--bg-overlay);color:var(--label-primary);box-shadow:0 1px 2px rgba(0,0,0,.1)}\n  .st-ghost-btn{padding:4px 10px;border-radius:7px;border:1px solid var(--border-l2);font-size:12px;color:var(--label-secondary)}\n  .st-ghost-btn:hover{background:var(--row-hover);color:var(--label-primary)}\n\n  .st-app{display:grid;grid-template-columns:272px 1fr;height:calc(100% - 48px)}\n\n  /* ---------- sidebar ---------- */\n  .st-sidebar{background:var(--bg-layer-1);border-right:1px solid var(--border-l1);padding:10px 8px;overflow-y:auto}\n  .st-brand{display:flex;align-items:center;gap:8px;padding:4px 8px 12px;font-weight:600;font-size:13px}\n  .st-brand .st-dot{width:18px;height:18px;border-radius:6px;background:var(--brand);opacity:.9}\n  .st-ws-label{display:flex;align-items:center;gap:6px;padding:10px 8px 4px;font-size:11.5px;color:var(--label-tertiary);letter-spacing:.02em}\n  .st-row{\n    display:flex;align-items:center;gap:6px;height:32px;padding:0 6px 0 10px;border-radius:8px;\n    font-size:12.8px;color:var(--label-primary);cursor:default;position:relative;\n  }\n  .st-row:hover{background:var(--row-hover)}\n  .st-row.st-active{background:var(--row-active);font-weight:600}\n  .st-row .st-title{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n  .st-row .st-more{\n    width:24px;height:24px;border-radius:6px;display:grid;place-items:center;\n    color:var(--label-secondary);opacity:0;flex:none;\n  }\n  .st-row:hover .st-more,.st-row.st-active .st-more,.st-row.st-menu-open .st-more{opacity:1}\n  .st-row .st-more:hover{background:var(--border-l1);color:var(--label-primary)}\n  .st-row .st-badge{font-size:10.5px;color:var(--label-tertiary);border:1px solid var(--border-l1);padding:0 5px;border-radius:5px}\n  .st-row .st-spin{width:6px;height:6px;border-radius:50%;background:var(--success);flex:none;margin-right:2px}\n\n  .st-list-head{display:flex;align-items:center;justify-content:space-between;padding:10px 8px 4px}\n  .st-list-head .st-lt{font-size:11.5px;color:var(--label-tertiary);letter-spacing:.03em}\n  .st-tiny{padding:2px 8px;border-radius:6px;font-size:11.5px;color:var(--label-secondary)}\n  .st-list-head .st-grow{flex:1}\n  .st-list-head .st-lh-actions{display:flex;align-items:center;gap:2px}\n  .st-drop{border:1.5px dashed var(--border-l2);border-radius:12px;padding:24px 18px;text-align:center;cursor:pointer;\n    transition:background .12s ease,border-color .12s ease}\n  .st-drop:hover,.st-drop.st-over{background:var(--brand-soft);border-color:var(--brand)}\n  .st-drop-ico{color:var(--label-tertiary);display:grid;place-items:center;margin-bottom:7px}\n  .st-drop-ico svg{width:20px;height:20px}\n  .st-drop-title{font-size:13px;color:var(--label-primary)}\n  .st-drop-sub{font-size:12px;color:var(--label-secondary);margin-top:4px}\n  .st-drop-sub a{color:var(--label-primary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}\n  .st-file-card{display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px 12px;\n    border:1px solid var(--border-l1);border-radius:10px;background:var(--bg-layer-1)}\n  .st-file-card .st-att-thumb{background:var(--bg-overlay);cursor:default}\n  .st-file-name{font-size:12.6px;color:var(--label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .st-file-meta{font-size:11.6px;color:var(--label-tertiary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .st-dup-note{margin-top:10px;padding:9px 11px;border-radius:9px;background:var(--tint-warn);color:var(--warn);\n    font-size:12px;line-height:1.6}\n  .st-field{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:12.4px;color:var(--label-secondary)}\n  .st-field select{height:28px;border-radius:7px;border:1px solid var(--border-l2);background:var(--bg-overlay);\n    color:var(--label-primary);padding:0 8px;font-size:12.4px;cursor:pointer}\n  .st-field .st-fl{white-space:nowrap}\n  .st-field .st-fp{font-size:11.8px;color:var(--label-tertiary)}\n  .st-fh{margin-top:6px;font-size:11.6px;color:var(--label-tertiary)}\n  .st-conflict{margin-top:12px;padding:10px 12px;border:1px solid var(--border-l1);border-radius:10px;background:var(--bg-layer-1)}\n  .st-conflict .st-cf-head{font-size:12.6px;color:var(--label-primary)}\n  .st-conflict .st-cf-sub{font-size:11.8px;color:var(--label-secondary);margin-top:2px}\n  .st-conflict .st-segline{margin-top:8px}\n  .st-conflict .st-cf-desc{font-size:11.8px;color:var(--label-secondary);margin-top:7px;line-height:1.55}\n  .st-conflict .st-cf-stat{display:flex;gap:16px;margin-top:9px;padding-top:8px;border-top:1px solid var(--border-l1);\n    font-size:11.8px;color:var(--label-secondary)}\n  .st-conflict .st-cf-stat b{font-weight:600;color:var(--label-primary)}\n  .st-conflict .st-cf-stat .st-sk{color:var(--label-tertiary)}\n  .st-conflict .st-cf-note{margin-top:7px;font-size:11.6px;color:var(--label-tertiary);line-height:1.55}\n  .st-conflict .st-cf-note b{font-weight:600;color:var(--label-secondary)}\n  .st-conflict .st-cf-stat .st-lnk{font-size:11.8px;color:var(--brand);border:0;background:none;padding:0;cursor:pointer}\n  .st-conflict .st-cf-stat .st-lnk b{color:var(--brand)}\n  .st-skip-list{margin-top:9px;padding:8px 10px;border-radius:9px;background:var(--bg-overlay);border:1px solid var(--border-l1)}\n  .st-skip-row{display:flex;gap:8px;font-size:11.5px;line-height:1.6;padding:2px 0}\n  .st-skip-row .st-sk-t{color:var(--label-tertiary);white-space:nowrap;flex:none}\n  .st-skip-row .st-sk-r{color:var(--label-tertiary);flex:none}\n  .st-skip-row .st-sk-x{color:var(--label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n  .st-skip-foot{margin-top:6px;font-size:11px;color:var(--label-tertiary);line-height:1.55}\n  .st-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}\n  .st-stale{margin-top:12px;padding:9px 11px;border-radius:9px;background:var(--tint-warn);color:var(--warn);font-size:12px;line-height:1.6}\n  .st-stale b{font-weight:600}\n  .st-soon-banner{display:flex;align-items:center;gap:8px;margin-top:12px;padding:9px 12px;border-radius:10px;\n    background:var(--tint-warn);color:var(--warn);font-size:12px}\n  .st-soon-banner[hidden]{display:none}\n  .st-soon-banner .st-sb-ico{width:16px;height:16px;border-radius:50%;border:1.4px solid currentColor;\n    font-size:10px;font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;flex:none}\n  .st-soon-banner .st-sb-txt{color:var(--label-primary)}\n  .st-bi-list{display:flex;flex-direction:column;gap:2px;margin-top:6px}\n  .st-bi-row{display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12px}\n  .st-bi-row .st-bi-t{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--label-primary)}\n  .st-bi-row .st-bi-k{flex:none;font-size:11px;color:var(--label-tertiary)}\n  .st-bi-row .st-lnk{flex:none}\n  .st-lnk{font-size:11.8px;color:var(--brand);border:0;background:none;padding:0;cursor:pointer}\n  .st-more-row{display:block;width:100%;margin:6px 0 2px;padding:7px 10px;border-radius:8px;border:1px dashed var(--border-l2);\n    background:none;color:var(--label-tertiary);font-size:11.8px;cursor:pointer;text-align:center}\n  .st-more-row:hover{color:var(--label-primary);border-color:var(--border-l1)}\n  .st-soon{display:inline-block;margin-left:6px;padding:0 6px;border-radius:5px;background:var(--tint-warn);\n    color:var(--warn);font-size:10.5px;line-height:16px;font-weight:500;vertical-align:1px}\n  .st-imp-sub{padding:0 6px 8px 40px}\n  .st-imp-sub .st-skip-list{margin-top:4px}\n  .st-skip-note{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:11.8px;color:var(--success)}\n  .st-skip-note .st-ic{width:13px;height:13px;flex:none}\n  .st-new-tag{margin-top:10px;font-size:11.8px;color:var(--success)}\n  .st-imp-list{display:flex;flex-direction:column;gap:2px;margin-top:12px}\n  .st-imp-row{display:flex;align-items:center;gap:10px;padding:8px 6px;border-radius:9px}\n  .st-imp-row:hover{background:var(--row-hover)}\n  .st-imp-row .st-att-meta{min-width:0;flex:1}\n  .st-imp-row .st-file-name,.st-imp-row .st-file-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .st-imp-row .st-file-meta.st-wrap{white-space:normal;overflow:visible;line-height:1.6}\n  .st-segline.st-tight .st-chip{font-size:11.4px;padding:3px 8px}\n  .st-imp-tag{flex:none;font-size:10.8px;padding:2px 8px;border-radius:20px;background:var(--tint-success);color:var(--success)}\n  .st-imp-x{width:22px;height:22px;border-radius:6px;flex:none;display:grid;place-items:center;color:var(--label-tertiary)}\n  .st-imp-x svg{width:12px;height:12px}\n  .st-imp-x:hover{background:var(--row-hover);color:var(--label-primary)}\n  .st-imp-add{margin-top:8px;font-size:12px;color:var(--brand);padding:2px 4px;border-radius:6px}\n  .st-imp-add:hover{background:var(--brand-soft)}\n  .st-imp-summary{font-size:12px;color:var(--label-secondary)}\n  .st-dlg-actions{display:flex;gap:12px}\n  .st-tiny:hover{background:var(--row-hover);color:var(--label-primary)}\n  .st-bulk-bar{display:flex;align-items:center;gap:8px;margin:6px 0 4px;padding:7px 9px;border-radius:8px;background:var(--bg-layer-2);font-size:12px}\n  .st-bulk-bar .st-grow{flex:1}\n  .st-bulk-bar b{color:var(--label-primary)}\n  .st-bulk-bar button{padding:3px 8px;border-radius:6px;font-size:12px;color:var(--label-secondary)}\n  .st-bulk-bar button:hover{background:var(--row-hover);color:var(--label-primary)}\n  .st-bulk-bar button.st-danger{color:var(--danger)}\n  .st-bulk-bar button.st-danger:hover{background:var(--tint-danger)}\n  .st-bulk-bar button:disabled{opacity:.4;cursor:default}\n  .st-cb{width:14px;height:14px;flex:none;margin:0 2px 0 0;accent-color:var(--brand);cursor:pointer}\n\n  /* ---------- main ---------- */\n  .st-main{display:flex;flex-direction:column;overflow:hidden}\n  .st-cv{padding:26px 32px;overflow-y:auto;flex:1}\n  .st-cv h1{font-size:15px;margin:0 0 4px}\n  .st-cv .st-sub{color:var(--label-secondary);font-size:12.5px;margin:0 0 20px}\n  .st-cv .st-note{\n    border:1px solid var(--border-l1);background:var(--bg-layer-1);border-radius:10px;\n    padding:14px 16px;font-size:12.5px;color:var(--label-secondary);line-height:1.8;max-width:760px;\n  }\n  .st-cv .st-note b{color:var(--label-primary);font-weight:600}\n  .st-kbd{font:11px/1 ui-monospace,Consolas,monospace;background:var(--code-bg);border:1px solid var(--border-l1);border-radius:4px;padding:2px 5px;color:var(--label-primary)}\n\n  /* ---------- menu ---------- */\n  .st-menu{\n    position:fixed;z-index:60;width:236px;padding:6px;border-radius:12px;\n    background:var(--bg-overlay);border:1px solid var(--border-l1);box-shadow:var(--shadow-menu);\n    opacity:0;transform:scale(.97) translateY(-2px);transform-origin:top left;\n    transition:opacity .1s ease,transform .1s ease;pointer-events:none;\n  }\n  .st-menu.st-show{opacity:1;transform:none;pointer-events:auto}\n  .st-menu-item{\n    display:flex;align-items:center;gap:9px;width:100%;height:32px;padding:0 9px;border-radius:7px;\n    font-size:12.8px;color:var(--label-primary);text-align:left;\n  }\n  .st-menu-item:hover,.st-menu-item:focus-visible{background:var(--row-hover);outline:none}\n  .st-menu-item .st-ico{width:16px;height:16px;flex:none;color:var(--label-secondary)}\n  .st-menu-item .st-label{flex:1}\n  .st-menu-item .st-sc{font-size:11px;color:var(--label-tertiary)}\n  .st-menu-item.st-danger{color:var(--danger)}\n  .st-menu-item.st-danger .st-ico{color:var(--danger)}\n  .st-menu-sep{height:1px;background:var(--border-l1);margin:5px 6px}\n\n  /* ---------- overlay / dialog ---------- */\n  .st-backdrop{\n    position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.34);\n    backdrop-filter:blur(2px);display:grid;place-items:center;padding:24px;\n    animation:fade .12s ease;\n  }\n  .st-backdrop.st-stacked{background:rgba(0,0,0,.16);backdrop-filter:none}\n  @keyframes fade{from{opacity:0}to{opacity:1}}\n  @keyframes pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}\n  .st-dialog{\n    width:min(452px,94vw);background:var(--dsw-alias-bg-layer-1);border-radius:16px;\n    border:1px solid var(--border-l1);box-shadow:var(--shadow-modal);\n    padding:20px 20px 16px;animation:pop .16s cubic-bezier(.2,.8,.3,1);\n  }\n  .st-dlg-head{display:flex;align-items:flex-start;gap:12px}\n  .st-dialog:focus{outline:none}\n  .st-btn:disabled{opacity:.45;cursor:default;filter:none}\n  .st-dlg-head h2{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}\n  .st-dlg-head .st-sub{font-size:12px;color:var(--label-secondary);margin-top:3px}\n  .st-dlg-close{margin-left:auto;width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:var(--label-tertiary);flex:none}\n  .st-dlg-close:hover{background:var(--row-hover);color:var(--label-primary)}\n\n  .st-verdict{display:flex;gap:9px;align-items:flex-start;margin-top:16px;padding:10px 12px;border-radius:10px;font-size:12.8px;line-height:1.5}\n  .st-verdict .st-vicon{width:16px;height:16px;flex:none;margin-top:1px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:700;color:#fff}\n  .st-verdict.st-ok{background:var(--tint-success)} .st-verdict.st-ok .st-vicon{background:var(--success)}\n  .st-verdict.st-warn{background:var(--tint-warn)} .st-verdict.st-warn .st-vicon{background:var(--warn)}\n  .st-verdict.st-bad{background:var(--tint-danger)} .st-verdict.st-bad .st-vicon{background:var(--danger)}\n  .st-verdict.st-fail{background:var(--tint-idle)} .st-verdict.st-fail .st-vicon{background:var(--idle)}\n\n  .st-sec{margin-top:15px}\n  .st-sec-label{font-size:11px;letter-spacing:.06em;color:var(--label-tertiary);margin-bottom:6px}\n  .st-sec ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}\n  .st-sec li{display:flex;gap:8px;align-items:flex-start;font-size:12.6px;line-height:1.55}\n  .st-sec li .st-li-ico{width:13px;height:13px;flex:none;margin-top:2px;color:var(--label-tertiary)}\n  .st-sec.st-kept li .st-li-ico{color:var(--success);opacity:.8}\n  .st-sec li .st-txt{flex:0 1 auto}\n  .st-sec li .st-act{flex:none;margin-left:6px;font-size:12px;color:var(--brand);padding:0 2px;border-radius:4px}\n  .st-sec li .st-act:hover{text-decoration:underline}\n\n  .st-hint-line{\n    margin-top:14px;padding:9px 12px;border-radius:9px;background:var(--dsw-alias-bg-overlay);\n    font-size:12.2px;color:var(--label-secondary);display:flex;gap:6px;align-items:center;flex-wrap:wrap;\n  }\n  .st-hint-line a{color:var(--label-primary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}\n  .st-hint-line a:hover{color:var(--brand)}\n  .st-cascade{display:flex;gap:9px;align-items:flex-start;margin-top:10px;padding:9px 12px;\n    border:1px solid var(--border-l1);border-radius:9px;font-size:12.4px;line-height:1.5;cursor:pointer;color:var(--label-primary)}\n  .st-cascade:hover{background:var(--row-hover)}\n  .st-cascade input{margin-top:1px;accent-color:var(--brand);cursor:pointer}\n  .st-cascade .st-cb-desc{color:var(--label-secondary);font-size:11.8px;margin-top:2px}\n  .st-cascade.st-disabled{opacity:.62;cursor:default}\n  .st-cascade.st-disabled:hover{background:none}\n  .st-cascade.st-disabled input{cursor:not-allowed}\n  .st-attach-line{font-size:12.4px;color:var(--label-primary);line-height:1.55}\n  .st-attach-line b{font-weight:600}\n  .st-attach-bar{height:6px;border-radius:3px;background:var(--bg-layer-2);overflow:hidden;margin-top:7px}\n  .st-attach-bar i{display:block;height:100%;background:var(--brand);border-radius:3px}\n  .st-attach-sub{font-size:11.6px;color:var(--label-tertiary);margin-top:5px}\n  .st-attach-summary{display:block;width:calc(100% + 16px);margin:0 -8px;padding:6px 8px;border:0;border-radius:8px;\n    background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}\n  .st-attach-summary:hover{background:var(--row-hover)}\n  .st-attach-summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px}\n  .st-sec-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}\n  .st-sec-head .st-sec-label{margin-bottom:0}\n  .st-sec-link{font-size:11.6px;color:var(--label-secondary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}\n  .st-sec-link:hover{color:var(--brand)}\n  .st-dialog.st-wide{width:min(560px,94vw)}\n  .st-att-note{margin-top:14px;font-size:12px;color:var(--label-secondary);line-height:1.65;background:var(--dsw-alias-bg-overlay);border-radius:9px;padding:9px 11px}\n  .st-att-list{margin-top:8px;max-height:322px;overflow:auto;padding-right:2px}\n  .st-att-row{display:flex;align-items:center;gap:10px;padding:7px 6px;border-radius:8px;cursor:pointer}\n  .st-att-row:hover{background:var(--row-hover)}\n  .st-att-row.st-shared{cursor:default}\n  .st-att-row input{accent-color:var(--brand);flex:none;margin:0;cursor:pointer}\n  .st-att-row.st-shared input{cursor:default}\n  .st-att-thumb{width:34px;height:34px;border-radius:7px;flex:none;display:grid;place-items:center;\n    background:var(--bg-layer-2);color:var(--label-secondary);border:1px solid var(--border-l1);cursor:zoom-in}\n  .st-att-thumb svg{width:17px;height:17px}\n  .st-att-thumb.st-t-img{color:#4058d8;background:rgba(77,107,254,.1);border-color:transparent}\n  .st-att-thumb.st-t-sheet{color:#1f7a4d;background:rgba(6,118,71,.1);border-color:transparent}\n  .st-att-thumb.st-t-zip{color:#a15c1c;background:rgba(181,71,8,.1);border-color:transparent}\n  html[data-theme=dark] .st-att-thumb.st-t-img{color:#a8b7ff;background:rgba(133,152,255,.16)}\n  html[data-theme=dark] .st-att-thumb.st-t-sheet{color:#7fe0ae;background:rgba(50,213,131,.14)}\n  html[data-theme=dark] .st-att-thumb.st-t-zip{color:#fdc58a;background:rgba(253,176,34,.14)}\n  .st-att-meta{flex:1;min-width:0}\n  .st-att-name{font-size:12.6px;color:var(--label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .st-att-meta .st-attach-sub{margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .st-att-tag{flex:none;font-size:10.8px;padding:2px 7px;border-radius:20px}\n  .st-att-tag.st-own{background:var(--tint-success);color:var(--success)}\n  .st-att-tag.st-shared{background:var(--tint-idle);color:var(--label-secondary)}\n  .st-att-lock{width:13px;height:13px;flex:none;color:var(--label-tertiary);opacity:.75}\n  .st-dlg-foot.st-split{justify-content:space-between}\n  .st-att-selinfo{font-size:12px;color:var(--label-secondary)}\n  .st-att-preview{position:fixed;inset:0;z-index:110;display:grid;place-items:center;padding:5vh 4vw;\n    background:rgba(0,0,0,.6);animation:fade .12s ease}\n  .st-att-preview .st-frame{position:relative;width:min(680px,86vw);border-radius:14px;overflow:hidden;\n    box-shadow:var(--shadow-modal);background:var(--bg-overlay);animation:pop .16s ease}\n  .st-att-preview .st-preview-close{position:absolute;top:8px;right:8px;z-index:2;background:rgba(0,0,0,.35);color:#fff}\n  .st-att-preview .st-preview-close:hover{background:rgba(0,0,0,.55);color:#fff}\n  .st-att-preview .st-canvas{height:min(56vh,380px);display:grid;place-items:center;overflow:hidden;color:#5a6bc9;font-size:12.5px;\n    background:linear-gradient(135deg,#e7ebff,#f6f7ff) center/cover no-repeat}\n  .st-att-preview .st-canvas svg{display:block}\n  html[data-theme=dark] .st-att-preview .st-canvas{color:#a8b7ff;background:linear-gradient(135deg,#2a2f4a,#20222c)}\n  .st-att-preview .st-cap{padding:11px 15px;font-size:12.2px;color:var(--label-secondary);display:flex;gap:12px;justify-content:space-between}\n  .st-details-toggle{display:flex;align-items:center;gap:5px;margin-top:12px;font-size:12px;color:var(--label-tertiary);padding:2px 0}\n  .st-details-toggle:hover{color:var(--label-secondary)}\n  .st-details-toggle .st-chev{transition:transform .15s ease}\n  .st-details-toggle[aria-expanded=true] .st-chev{transform:rotate(90deg)}\n  .st-details-body{margin-top:8px;font-size:12.2px;color:var(--label-secondary);line-height:1.7;\n    border-left:2px solid var(--border-l2);padding-left:10px;display:none}\n  .st-det-gap{margin-top:6px}\n  .st-details-body.st-show{display:block}\n  .st-details-body code{background:var(--code-bg);border-radius:4px;padding:1px 5px;font:11.5px ui-monospace,Consolas,monospace;color:var(--label-primary)}\n\n  .st-dlg-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border-l1)}\n  .st-btn{height:32px;padding:0 14px;border-radius:8px;font-size:12.8px;font-weight:500;display:inline-flex;align-items:center;gap:6px}\n  .st-btn.st-plain{border:1px solid var(--border-l2);color:var(--label-primary);background:var(--bg-overlay)}\n  .st-btn.st-plain:hover{background:var(--row-hover)}\n  .st-btn.st-danger{background:var(--danger-solid);color:#fff}\n  .st-btn.st-danger:hover{filter:brightness(1.08)}\n  .st-btn.st-danger:disabled{opacity:.55;cursor:default;filter:none}\n  .st-btn.st-primary{background:var(--brand);color:#fff}\n  .st-btn.st-primary:hover{filter:brightness(1.06)}\n  .st-field input{width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--border-l2);\n    background:var(--bg-base);color:var(--label-primary);font:inherit;font-size:12.6px;outline:none}\n  .st-field input:focus{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent)}\n  .st-segline{display:flex;gap:8px}\n  .st-loclist{display:flex;flex-direction:column;gap:6px}\n  .st-loc{display:flex;gap:9px;align-items:flex-start;padding:8px 11px;border:1px solid var(--border-l1);\n    border-radius:9px;font-size:12.4px;cursor:pointer;line-height:1.45}\n  .st-loc:hover{background:var(--row-hover)}\n  .st-loc.st-on{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 6%,transparent)}\n  .st-loc input{margin-top:1px;accent-color:var(--brand)}\n  .st-loc .st-lp{display:block;font-size:11.4px;color:var(--label-tertiary);margin-top:2px;\n    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n  .st-btn.st-plain:focus-visible,.st-btn.st-danger:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 32%,transparent)}\n  .st-btn.st-loading{position:relative;color:transparent!important}\n  .st-btn.st-loading::after{\n    content:\"\";position:absolute;left:50%;top:50%;width:13px;height:13px;margin:-7px 0 0 -7px;\n    border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;\n  }\n  @keyframes spin{to{transform:rotate(360deg)}}\n\n  /* ---------- toast ---------- */\n  .st-toast-wrap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:90;display:flex;flex-direction:column;gap:8px;align-items:center}\n  .st-toast{\n    display:flex;align-items:center;gap:14px;background:#242428;color:#fff;border-radius:10px;\n    padding:10px 14px;font-size:12.8px;box-shadow:var(--shadow-toast);animation:pop .16s ease;\n  }\n  html[data-theme=dark] .st-toast{background:#3a3a40}\n  .st-toast button{color:#a9b6ff;font-weight:600;font-size:12.8px}\n\n  /* ---------- settings ---------- */\n  .st-settings{display:grid;grid-template-columns:196px 1fr;height:100%;overflow:hidden}\n  .st-settings-nav{background:var(--bg-layer-1);border-right:1px solid var(--border-l1);padding:14px 8px;overflow-y:auto}\n  .st-settings-nav .st-snav-title{padding:0 10px 10px;font-size:11.5px;color:var(--label-tertiary);letter-spacing:.04em}\n  .st-snav{display:flex;align-items:center;height:30px;padding:0 10px;border-radius:7px;color:var(--label-secondary);font-size:12.5px}\n  .st-snav:hover{background:var(--row-hover);color:var(--label-primary)}\n  .st-snav.st-on{background:var(--row-active);color:var(--label-primary);font-weight:600}\n  .st-settings-body{padding:28px 32px;overflow-y:auto}\n  .st-settings-body h2{font-size:15px;margin:0 0 6px}\n  .st-settings-body .st-sub{color:var(--label-secondary);font-size:12.5px;margin:0 0 18px;line-height:1.75}\n  .st-trash-list{border:1px solid var(--border-l1);border-radius:12px;overflow:hidden;max-width:720px}\n  .st-trash-row{display:flex;align-items:center;gap:12px;padding:9px 14px;border-bottom:1px solid var(--border-l1)}\n  .st-trash-row:last-child{border-bottom:0}\n  .st-trash-row .st-tw{flex:1;min-width:0}\n  .st-trash-row .st-tt{font-size:12.8px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n  .st-trash-row .st-tm{font-size:11.5px;color:var(--label-secondary);margin-top:2px}\n  .st-trash-row .st-acts{display:flex;gap:6px;flex:none}\n  .st-mini{height:26px;padding:0 10px;border-radius:7px;font-size:12px;border:1px solid var(--border-l2);color:var(--label-primary)}\n  .st-mini:hover{background:var(--row-hover)}\n  .st-mini.st-danger{color:var(--danger);border-color:transparent}\n  .st-mini.st-danger:hover{background:var(--tint-danger)}\n  .st-mini.st-confirm{background:var(--danger-solid);color:#fff;border-color:transparent}\n  .st-trash-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px;max-width:720px;flex-wrap:wrap}\n  .st-search{display:flex;align-items:center;gap:6px;flex:1;min-width:150px;height:30px;padding:0 10px;\n    background:var(--bg-layer-1);border:1px solid var(--border-l1);border-radius:8px;font-size:12.5px;color:var(--label-tertiary)}\n  .st-search input{border:0;background:none;outline:none;font:inherit;color:var(--label-primary);width:100%}\n  .st-chip{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--border-l1);color:var(--label-secondary)}\n  .st-chip.st-on{background:var(--row-active);color:var(--label-primary);border-color:transparent}\n  .st-retention{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--label-secondary)}\n  .st-retention select{font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;\n    background:var(--bg-overlay);color:var(--label-primary);border:1px solid var(--border-l2)}\n  .st-listhead{display:flex;align-items:center;gap:10px;max-width:720px;padding:6px 2px 10px;margin-bottom:0;\n    font-size:12px;color:var(--label-secondary)}\n  .st-listhead .st-grow{flex:1}\n  .st-selall{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--label-secondary);cursor:pointer;user-select:none}\n  .st-selall input{accent-color:var(--brand);width:14px;height:14px;cursor:pointer}\n  .st-selinfo{font-size:11.8px;color:var(--label-tertiary)}\n  .st-listhead .st-mini:disabled{opacity:.35;cursor:default}\n  .st-listhead .st-tiny:disabled{opacity:.35;cursor:default}\n  .st-pager{display:flex;align-items:center;gap:4px}\n  .st-pager button{min-width:26px;height:26px;padding:0 6px;border-radius:6px;font-size:12px;\n    color:var(--label-secondary);border:1px solid transparent}\n  .st-pager button:hover:not(:disabled){background:var(--row-hover);color:var(--label-primary)}\n  .st-pager button.st-on{background:var(--row-active);color:var(--label-primary);font-weight:600}\n  .st-pager button:disabled{opacity:.35;cursor:default}\n  .st-pager .st-psize{font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;\n    background:var(--bg-overlay);color:var(--label-primary);border:1px solid var(--border-l2)}\n  .st-empty{padding:36px 14px;text-align:center;color:var(--label-secondary);font-size:12.5px;line-height:1.8}\n  .st-trash-foot{display:flex;justify-content:space-between;align-items:center;margin-top:14px;max-width:720px}\n  .st-trash-foot .st-count{font-size:12px;color:var(--label-tertiary)}\n  .st-mini.st-ghost{border-color:var(--border-l2);color:var(--label-secondary)}\n  .st-mini.st-ghost:hover{color:var(--label-primary)}\n\n  /* legend */\n  .st-legend{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:var(--label-tertiary)}\n  .st-legend span{display:inline-flex;gap:5px;align-items:center}\n  .st-legend i{width:7px;height:7px;border-radius:50%;display:inline-block}\n\n/* 补充：原型里只是 JS 钩子、没有样式的类，在这里补齐 */\n.st-att-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}\n.st-verdict.st-idle{background:var(--tint-idle)} .st-verdict.st-idle .st-vicon{background:var(--idle)}\n.st-att-list.st-pick{max-height:340px}\n.st-att-list.st-pick .st-att-row:hover{background:var(--row-hover)}\n.st-toast-act{border:0;background:transparent;padding:0;cursor:pointer;font:inherit;color:#a9b6ff;font-weight:600;font-size:12.8px}\n/* 浮层在宿主 overlay 槽里要自己接管指针事件（槽本身可能穿透） */\n.st-backdrop,.st-att-preview,.st-toast-wrap{pointer-events:auto}\n\n.st-ico-svg{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center}\n.st-ico-svg svg{width:16px;height:16px}\n\n/* 回收站页：黄条与工具栏之间留出呼吸，两个黄条叠放时也不要贴死 */\n.st-soon-banner{margin-top:16px;padding:10px 12px}\n.st-soon-banner + .st-soon-banner{margin-top:8px}\n.st-trash-toolbar{margin-top:16px;margin-bottom:10px}\n.st-listhead{margin-top:2px}\n.st-tabs{display:flex;gap:2px;margin:14px 0 4px;padding:4px;align-self:flex-start;border:1px solid var(--border-l2);border-radius:12px;background:var(--bg-layer-1);width:fit-content;box-shadow:inset 0 1px 2px rgba(0,0,0,.05)}\n.st-tab{padding:5px 16px;border-radius:8px;font-size:12.5px;line-height:20px;color:var(--label-secondary)}\n.st-tab.st-on{background:var(--label-primary);color:var(--bg-base);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.18)}\n.st-segctl{display:inline-flex;align-items:center;gap:2px;padding:3px;background:var(--bg-layer-1);border:1px solid var(--border-l2);border-radius:10px;box-shadow:inset 0 1px 2px rgba(0,0,0,.05);flex:none}\n.st-segctl button{padding:3px 12px;border-radius:8px;font-size:12px;line-height:18px;color:var(--label-secondary);white-space:nowrap}\n.st-segctl button:hover{color:var(--label-primary)}\n.st-segctl button.st-on{background:var(--label-primary);color:var(--bg-base);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.18)}\n.st-segctl button.st-on:hover{color:var(--bg-base)}"

    /* ── 注册 ─────────────────────────────────────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        const styleEl = document.createElement('style')
        styleEl.setAttribute('data-plugin-css', 'dsh-session-trash')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        ctx.effect(() => () => styleEl.remove(), 'dsh-session-trash: styles')

        clientCtx = ctx
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        slots.inject('sidebar.workspaces.session.menu.item', () => slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-trash-delete', order: 500 },
          MenuDeleteItem,
        ))

        slots.inject('sidebar.workspaces.session.menu.item', () => slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-trash-export', order: 510 },
          MenuExportItem,
        ))

        slots.inject('conversation.session.header.utilities', () => slots.register(
          { name: 'conversation.session.header.utilities', id: 'session-trash-import', order: 500 },
          HeaderImportButton,
        ))

        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'session-trash-overlay' },
          Overlay,
        ))

        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'session-trash', order: 55, label: '回收站' },
          () => h(SettingsBoundary, null, h('div', { className: 'st-root' }, h(TrashPage), h(SafetySection))),
        ))
      },
    }
  },
})
