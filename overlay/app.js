(() => {
  'use strict'

  const API = '/dsh-floating/api'
  const DEFAULT_PANEL_HEIGHT = { sessions: 330, reply: 430 }
  const MIN_PANEL_HEIGHT = 120
  const MAX_PANEL_HEIGHT = 820
  const BASE_HEIGHT = 98
  const AUTO_COLLAPSED_HEIGHT = 42
  const STORE_SESSION = 'dsh-floating-input:session'
  const STORE_COLLAPSED = 'dsh-floating-input:collapsed-workspaces'
  const STORE_PANEL_HEIGHTS = 'dsh-floating-input:panel-heights'
  const STORE_PREFS = 'dsh-floating-input:prefs'
  const SETTINGS_HEIGHT = 450
  const CN_HOLIDAYS_2026 = [
    ['2026-01-01', '2026-01-03'],
    ['2026-02-15', '2026-02-23'],
    ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'],
    ['2026-06-19', '2026-06-21'],
    ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07'],
  ]

  const $ = (selector) => document.querySelector(selector)
  const el = {
    app: $('#app'),
    dragbar: $('#dragbar'),
    liveDots: $('#liveDots'),
    balanceBtn: $('#balanceBtn'),
    balanceValue: $('#balanceValue'),
    balanceTrend: $('#balanceTrend'),
    pinBtn: $('#pinBtn'),
    settingsBtn: $('#settingsBtn'),
    settingsOverlay: $('#settingsOverlay'),
    settingsClose: $('#settingsClose'),
    brandBtn: $('#brandBtn'),
    dockGroup: $('#dockGroup'),
    hotkeyBtn: $('#hotkeyBtn'),
    hideHotkeyBtn: $('#hideHotkeyBtn'),
    extraPrompt: $('#extraPrompt'),
    returnBtn: $('#returnBtn'),
    sessionsPanel: $('#sessionsPanel'),
    sessionList: $('#sessionList'),
    newBtn: $('#newBtn'),
    replyPanel: $('#replyPanel'),
    transcript: $('#transcript'),
    sessionBtn: $('#sessionBtn'),
    sessionName: $('#sessionName'),
    sessionColorBar: $('#sessionColorBar'),
    prompt: $('#prompt'),
    replyBtn: $('#replyBtn'),
    toast: $('#toast'),
    sessionMenu: $('#sessionMenu'),
  }

  const token = new URLSearchParams(location.search).get('token') || ''
  let panel = 'none'
  let reopenReplyAfterPick = false
  let sessions = []
  let meta = { balance: null, workspaces: [], lastSessionId: null }
  let currentId = null
  let currentTitle = '新对话'
  let currentWorkspaceId = null
  let pendingNew = false
  let pendingWorkspaceId = null
  let snapshot = null
  let sending = false
  let refreshing = false
  let authFailed = false
  let pollCount = 0
  let seenRequestSeq = 0
  let seenInFlight = false
  let toastTimer = null
  let lastReplyKey = ''
  let lastMetaAt = 0
  let liveStatus = null
  let activity = { running: false, approval: false, unreadIds: [], items: [], desktopSessionId: null, desktopSessionAt: 0 }
  let lastDotsKey = ''
  let lastDesktopSyncAt = 0
  let desktopSyncBusy = false
  let settingsOpen = false
  let autoCollapsed = false
  let hostPrefsLoaded = false
  const DEFAULT_PLACEHOLDER = '给 DeepSeek Harness 发消息…'
  const prefs = { expandUp: false, fontScale: 1, dock: 'float', hotkey: 'Ctrl+Alt+Space', hideHotkey: 'Ctrl+Alt+H', extraPrompt: '' }
  const collapsedWorkspaces = new Set()
  const panelHeights = { ...DEFAULT_PANEL_HEIGHT }
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_COLLAPSED) || '[]')
    if (Array.isArray(stored)) for (const id of stored) collapsedWorkspaces.add(String(id))
    const storedHeights = JSON.parse(localStorage.getItem(STORE_PANEL_HEIGHTS) || '{}')
    for (const name of ['sessions', 'reply']) {
      const value = Number(storedHeights?.[name])
      if (Number.isFinite(value)) panelHeights[name] = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, value))
    }
    const storedPrefs = JSON.parse(localStorage.getItem(STORE_PREFS) || '{}')
    prefs.expandUp = !!storedPrefs?.expandUp
    prefs.fontScale = Math.min(1.25, Math.max(0.85, Number(storedPrefs?.fontScale) || 1))
    prefs.dock = ['center', 'left'].includes(storedPrefs?.dock) ? storedPrefs.dock : 'float'
    prefs.hotkey = typeof storedPrefs?.hotkey === 'string' && storedPrefs.hotkey ? storedPrefs.hotkey : 'Ctrl+Alt+Space'
    prefs.hideHotkey = typeof storedPrefs?.hideHotkey === 'string' && storedPrefs.hideHotkey ? storedPrefs.hideHotkey : 'Ctrl+Alt+H'
    prefs.extraPrompt = typeof storedPrefs?.extraPrompt === 'string' ? storedPrefs.extraPrompt : ''
  } catch {}
  document.body.classList.toggle('expand-up', prefs.expandUp)

  function postNative(message) {
    try {
      window.chrome?.webview?.postMessage(message)
    } catch {
      // Running in a normal browser for design iteration.
    }
  }

  function reportHeight() {
    const height = settingsOpen
      ? SETTINGS_HEIGHT
      : autoCollapsed
        ? AUTO_COLLAPSED_HEIGHT
        : BASE_HEIGHT + (panel === 'none' ? 0 : panelHeights[panel] || 0)
    postNative({
      type: 'resize',
      height,
      direction: prefs.expandUp ? 'up' : 'down',
      collapsed: autoCollapsed && !settingsOpen,
    })
  }

  function updateResizeHandles() {
    const open = panel !== 'none' && !settingsOpen && !autoCollapsed
    document.body.classList.toggle('panel-open', open)
    document.body.classList.toggle('expand-up', prefs.expandUp)
    for (const handle of document.querySelectorAll('.resize-edge.bottom, .resize-corner.bl, .resize-corner.br')) {
      handle.hidden = !open || prefs.expandUp
    }
    for (const handle of document.querySelectorAll('.resize-edge.top, .resize-corner.tl, .resize-corner.tr')) {
      handle.hidden = !open || !prefs.expandUp
    }
  }

  function setAutoCollapsed(value) {
    autoCollapsed = !!value
    document.body.classList.toggle('auto-collapsed', autoCollapsed && !settingsOpen)
    if (el.brandBtn) el.brandBtn.title = autoCollapsed ? '展开输入框' : '收起快捷栏'
    updateResizeHandles()
    reportHeight()
  }

  function savePrefs() {
    try { localStorage.setItem(STORE_PREFS, JSON.stringify(prefs)) } catch {}
    if (!hostPrefsLoaded) return
    postNative({
      type: 'prefs',
      expandUp: prefs.expandUp,
      fontScale: prefs.fontScale,
      dock: prefs.dock,
      hotkey: prefs.hotkey,
      hideHotkey: prefs.hideHotkey,
      extraPrompt: prefs.extraPrompt,
    })
  }

  function syncSettingsUI() {
    for (const button of document.querySelectorAll('[data-expand]')) {
      button.classList.toggle('active', (button.dataset.expand === 'up') === prefs.expandUp)
    }
    for (const button of document.querySelectorAll('[data-font]')) {
      button.classList.toggle('active', Number(button.dataset.font) === prefs.fontScale)
    }
    for (const button of document.querySelectorAll('[data-dock]')) {
      button.classList.toggle('active', button.dataset.dock === prefs.dock)
    }
    if (el.hotkeyBtn && !el.hotkeyBtn.classList.contains('capturing')) el.hotkeyBtn.textContent = prefs.hotkey
    if (el.hideHotkeyBtn && !el.hideHotkeyBtn.classList.contains('capturing')) el.hideHotkeyBtn.textContent = prefs.hideHotkey
    if (el.extraPrompt && el.extraPrompt.value !== prefs.extraPrompt) el.extraPrompt.value = prefs.extraPrompt
  }

  function applyPrefs() {
    document.documentElement.style.setProperty('--font-scale', String(prefs.fontScale))
    document.body.classList.toggle('expand-up', prefs.expandUp)
    document.body.classList.toggle('auto-collapsed', autoCollapsed && !settingsOpen)
    savePrefs()
    syncSettingsUI()
    updateResizeHandles()
    postNative({
      type: 'settings',
      dock: prefs.dock,
    })
    reportHeight()
  }

  function openSettings() {
    if (autoCollapsed) {
      setAutoCollapsed(false)
      postNative({ type: 'expand' })
    }
    settingsOpen = true
    document.body.classList.remove('auto-collapsed')
    if (el.settingsOverlay) el.settingsOverlay.hidden = false
    syncSettingsUI()
    updateResizeHandles()
    reportHeight()
    setTimeout(() => el.extraPrompt?.focus(), 50)
  }

  function closeSettings() {
    if (!settingsOpen) return
    settingsOpen = false
    if (el.settingsOverlay) el.settingsOverlay.hidden = true
    document.body.classList.toggle('auto-collapsed', autoCollapsed)
    updateResizeHandles()
    reportHeight()
    el.prompt.focus()
  }

  function setPanel(next) {
    panel = panel === next ? 'none' : next
    el.sessionsPanel.hidden = panel !== 'sessions'
    el.replyPanel.hidden = panel !== 'reply'
    el.sessionBtn.setAttribute('aria-expanded', String(panel === 'sessions'))
    el.replyBtn.setAttribute('aria-expanded', String(panel === 'reply'))
    el.replyBtn.classList.toggle('active', panel === 'reply')
    el.replyBtn.title = panel === 'reply' ? '收起回复' : '展开回复'
    updateUnread()
    updateResizeHandles()
    reportHeight()
    if (panel === 'sessions') {
      loadSessions().catch(reportError)
    } else if (panel === 'reply') {
      if (!currentId) {
        renderReply(true)
      } else {
        refreshSnapshot({ force: true }).catch(reportError)
        markSeen()
      }
    }
  }

  function openSessionsPanel() {
    if (panel === 'sessions') {
      reopenReplyAfterPick = false
      setPanel('none')
      return
    }
    reopenReplyAfterPick = panel === 'reply'
    setPanel('sessions')
  }

  function startNewFromSessions() {
    const restoreReply = reopenReplyAfterPick
    reopenReplyAfterPick = false
    newConversation()
    if (restoreReply) setPanel('reply')
    el.prompt.focus()
  }

  async function api(path, options = {}) {
    if (authFailed) throw new Error('连接已失效，请重启 DeepSeek Harness')
    const headers = { 'x-dsh-floating-token': token }
    let body
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    let response
    try {
      response = await fetch(API + path, {
        method: options.method || 'GET',
        headers,
        body,
        cache: 'no-store',
      })
    } catch {
      throw new Error('无法连接 DeepSeek Harness，请确认主程序正在运行')
    }
    let data = null
    try {
      data = await response.json()
    } catch {
      throw new Error(`接口返回异常 (HTTP ${response.status})`)
    }
    if (response.status === 403) {
      authFailed = true
      throw new Error('连接已失效，请重启 DeepSeek Harness')
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `请求失败 (HTTP ${response.status})`)
    }
    return data
  }

  function showToast(message) {
    el.toast.textContent = String(message || '')
    el.toast.hidden = false
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      el.toast.hidden = true
      toastTimer = null
    }, 2800)
  }

  function reportError(error) {
    console.error(error)
    showToast(error?.message || '操作失败')
  }

  function formatMoney(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
    const symbol = String(currency || 'CNY').toUpperCase() === 'USD' ? '$' : '¥'
    return symbol + Number(value).toFixed(2)
  }

  let pricePeak = null

  function inCnHoliday(dateKey) {
    return CN_HOLIDAYS_2026.some(([start, end]) => dateKey >= start && dateKey <= end)
  }

  function pricePeriod(date = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(date)
      const get = (type) => parts.find((part) => part.type === type)?.value || ''
      const dateKey = `${get('year')}-${get('month')}-${get('day')}`
      if (['Sat', 'Sun'].includes(get('weekday')) || inCnHoliday(dateKey)) return false
      const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
    } catch {
      return false
    }
  }

  function nextPriceTransition(from = new Date()) {
    const current = pricePeriod(from)
    const started = from.getTime()
    const limit = started + 14 * 24 * 60 * 60 * 1000
    const step = 5 * 60 * 1000
    for (let cursor = started + step; cursor <= limit; cursor += step) {
      if (pricePeriod(new Date(cursor)) === current) continue
      let edge = cursor
      while (edge > started && pricePeriod(new Date(edge - 60_000)) !== current) edge -= 60_000
      return edge
    }
    return 0
  }

  function updatePricePeriod() {
    pricePeak = pricePeriod()
    const href = pricePeak ? '#i-price-peak' : '#i-price-valley'
    el.balanceTrend?.querySelector('use')?.setAttribute('href', href)
    el.balanceBtn.classList.toggle('price-peak', pricePeak)
    el.balanceBtn.classList.toggle('price-valley', !pricePeak)
    const next = nextPriceTransition()
    const hours = next ? Math.round(((next - Date.now()) / 3_600_000) * 10) / 10 : null
    el.balanceBtn.title = hours !== null ? `峰谷倒计时 ${Math.max(0.1, hours).toFixed(1)}h` : '峰谷倒计时 —'
  }

  function renderBalance() {
    const balance = meta.balance
    el.balanceBtn.classList.remove('stale', 'empty', 'low')
    if (!balance || balance.value === null || balance.value === undefined) {
      el.balanceValue.textContent = '—'
      el.balanceBtn.classList.add('empty')
      updatePricePeriod()
      return
    }
    el.balanceValue.textContent = formatMoney(balance.value, balance.currency)
    if (balance.stale) el.balanceBtn.classList.add('stale')
    const amount = Number(balance.value)
    el.balanceBtn.classList.toggle('low', Number.isFinite(amount) && amount < 10)
    updatePricePeriod()
  }

  function relativeTime(timestamp) {
    if (!timestamp) return ''
    const delta = Date.now() - Number(timestamp)
    if (!Number.isFinite(delta)) return ''
    if (delta < 45_000) return '刚刚'
    if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`
    if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`
    if (delta < 172_800_000) return '昨天'
    const date = new Date(Number(timestamp))
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }

  function updateComposer() {
    const title = currentTitle || '新对话'
    el.sessionName.textContent = title
    el.sessionBtn.title = currentId ? `当前对话：${title}` : '选择一个对话，或直接输入开始新对话'
  }

  function updateComposerStatus() {
    let text = DEFAULT_PLACEHOLDER
    const status = liveStatus
    if (status?.label) {
      if (status.phase === 'thinking' && status.detail) {
        const clean = String(status.detail).replace(/\s+/g, ' ').trim()
        const tail = clean.length > 56 ? clean.slice(-56) : clean
        text = tail ? `正在思考：${tail}` : '正在思考…'
      } else {
        text = status.label
      }
    }
    if (el.prompt.placeholder !== text) el.prompt.placeholder = text
    el.prompt.classList.toggle('busy', !!status?.label)
  }

  function renderStatusDots() {
    if (!el.liveDots) return
    let items = Array.isArray(activity.items) ? activity.items.slice() : []
    if (items.length === 0 && currentId && snapshot?.unread) {
      items = [{ id: currentId, state: 'done' }]
    }
    if (items.length === 0 && (snapshot?.running || snapshot?.status || activity.running || activity.approval)) {
      const approval = snapshot?.status?.phase === 'approval' || activity.approval
      items = [{ id: 'current', state: approval ? 'approval' : 'running' }]
    }
    if (items.length === 0) items = [{ id: 'idle', state: 'idle' }]
    const key = items.map((item) => `${item.id}:${item.state}`).join('|')
    if (key === lastDotsKey) return
    lastDotsKey = key
    const dots = items.map((item) => {
      const dot = document.createElement('span')
      dot.className = 'live-dot ' + item.state
      dot.title = item.state === 'approval'
        ? '有任务等待确认'
        : item.state === 'running'
          ? '任务运行中'
          : item.state === 'done'
            ? '任务已完成，打开对话后消失'
            : '空闲'
      return dot
    })
    el.liveDots.replaceChildren(...dots)
    el.liveDots.title = items.length > 1 ? `${items.length} 个任务` : dots[0]?.title || '空闲'
  }

  function updateLive() {
    renderStatusDots()
  }

  function updateUnread() {
    renderStatusDots()
  }

  async function loadMeta() {
    const data = await api('/meta')
    meta = data
    renderBalance()
    lastMetaAt = Date.now()
    if (!currentWorkspaceId && pendingNew) {
      const first = data.workspaces?.[0]
      if (first) pendingWorkspaceId = pendingWorkspaceId || first.id
    }
    if (panel === 'sessions') renderSessions()
    syncSettingsUI()
  }

  async function syncDesktopSession(sessionId, at) {
    if (!sessionId || !at || at <= lastDesktopSyncAt || sending || desktopSyncBusy) return
    lastDesktopSyncAt = at
    if (sessionId === currentId) return
    desktopSyncBusy = true
    try {
      await selectSession(sessionId)
    } catch (error) {
      lastDesktopSyncAt = 0
      throw error
    } finally {
      desktopSyncBusy = false
    }
  }

  async function refreshActivity() {
    if (authFailed) return
    const data = await api('/activity')
    activity = {
      running: !!data?.running,
      approval: !!data?.approval,
      unreadIds: Array.isArray(data?.unreadIds) ? data.unreadIds : [],
      items: Array.isArray(data?.items) ? data.items : [],
      desktopSessionId: typeof data?.desktopSessionId === 'string' ? data.desktopSessionId : null,
      desktopSessionAt: Number(data?.desktopSessionAt) || 0,
    }
    syncDesktopSession(activity.desktopSessionId, activity.desktopSessionAt).catch(() => {})
    updateLive()
    updateUnread()
  }

  async function loadSessions() {
    const data = await api('/sessions')
    sessions = Array.isArray(data.sessions) ? data.sessions : []
    meta.lastSessionId = data.lastSessionId || meta.lastSessionId
    if (Array.isArray(data.workspaces)) meta.workspaces = data.workspaces
    if (currentId) {
      const match = sessions.find((session) => session.id === currentId)
      if (match) {
        currentWorkspaceId = match.workspaceId || currentWorkspaceId
        if (match.title && match.title !== '未命名对话') currentTitle = match.title
      }
    }
    if (!currentId && !pendingNew && sessions.length > 0) {
      const stored = localStorage.getItem(STORE_SESSION)
      const candidate = sessions.find((session) => session.id === (stored || meta.lastSessionId)) || sessions[0]
      currentId = candidate.id
      currentTitle = candidate.title || '未命名对话'
      currentWorkspaceId = candidate.workspaceId || null
      pendingNew = false
    }
    renderSessions()
    updateComposer()
    if (!currentId && !pendingNew) {
      updateLive(false)
      updateUnread()
    }
  }

  function renderSessionColor() {
    if (!el.sessionColorBar) return
    const match = sessions.find((session) => session.id === currentId)
    if (match?.color) {
      el.sessionColorBar.style.background = match.color
      el.sessionColorBar.classList.add('visible')
    } else {
      el.sessionColorBar.classList.remove('visible')
      el.sessionColorBar.style.background = ''
    }
  }

  function renderSessions() {
    renderSessionColor()
    el.sessionList.replaceChildren()
    if (sessions.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty-list'
      const strong = document.createElement('strong')
      strong.textContent = '还没有对话'
      const span = document.createElement('span')
      span.textContent = '输入一句话，创建第一个悬浮对话'
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '开始新对话'
      button.addEventListener('click', startNewFromSessions)
      empty.append(strong, span, button)
      el.sessionList.appendChild(empty)
      return
    }

    const pinnedSessions = sessions.filter((session) => session.pinned)
    const groups = new Map()
    for (const session of sessions) {
      if (session.pinned) continue
      const key = String(session.workspaceId || session.workspaceTitle || 'ungrouped')
      let group = groups.get(key)
      if (!group) {
        const known = (meta.workspaces || []).find((workspace) => String(workspace.id) === key)
        group = { key, title: session.workspaceTitle || known?.title || '未分组', sessions: [] }
        groups.set(key, group)
      }
      group.sessions.push(session)
    }

    const orderedGroups = []
    if (pinnedSessions.length > 0) {
      orderedGroups.push({ key: '__pinned__', title: '置顶对话', pinned: true, sessions: pinnedSessions })
    }
    for (const group of groups.values()) orderedGroups.push(group)

    const fragment = document.createDocumentFragment()
    for (const group of orderedGroups) {
      const collapsed = collapsedWorkspaces.has(group.key)
      const section = document.createElement('div')
      section.className = 'workspace-group' + (collapsed ? ' collapsed' : '')

      const header = document.createElement('button')
      header.type = 'button'
      header.className = 'workspace-header'
      header.setAttribute('aria-expanded', String(!collapsed))
      header.title = collapsed ? `展开 ${group.title}` : `收起 ${group.title}`
      header.innerHTML = '<svg class="workspace-chevron"><use href="#i-chevron-down"></use></svg>'
      const name = document.createElement('span')
      name.className = 'workspace-name'
      name.textContent = group.title
      const count = document.createElement('span')
      count.className = 'workspace-count'
      count.textContent = String(group.sessions.length)
      header.append(name, count)
      header.addEventListener('click', () => {
        if (collapsedWorkspaces.has(group.key)) collapsedWorkspaces.delete(group.key)
        else collapsedWorkspaces.add(group.key)
        try { localStorage.setItem(STORE_COLLAPSED, JSON.stringify([...collapsedWorkspaces])) } catch {}
        renderSessions()
      })

      const rows = document.createElement('div')
      rows.className = 'workspace-sessions'
      for (const session of group.sessions) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'session-row' + (session.id === currentId ? ' active' : '')
        row.dataset.id = session.id
        row.title = session.title || '未命名对话'

        const colorSquare = document.createElement('span')
        colorSquare.className = 'session-color-square'
        if (session.color) colorSquare.style.background = session.color
        const main = document.createElement('span')
        main.className = 'session-main'
        const title = document.createElement('span')
        title.className = 'session-title'
        title.textContent = session.title || '未命名对话'
        const metaLine = document.createElement('span')
        metaLine.className = 'session-meta'
        const meta = []
        if (group.pinned && session.workspaceTitle) meta.push(session.workspaceTitle)
        meta.push(session.running ? '正在运行…' : relativeTime(session.updatedAt || session.createdAt))
        metaLine.textContent = meta.filter(Boolean).join(' · ')
        main.append(title, metaLine)

        row.append(colorSquare, main)
        if (session.unread) {
          const dot = document.createElement('span')
          dot.className = 'row-unread'
          row.append(dot)
        }
        row.addEventListener('click', () => {
          const restoreReply = reopenReplyAfterPick
          reopenReplyAfterPick = false
          selectSession(session.id)
          if (restoreReply) setPanel('reply')
          else setPanel('none')
          el.prompt.focus()
        })
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          event.stopPropagation()
          showSessionMenu(session, event.clientX, event.clientY)
        })
        rows.appendChild(row)
      }

      section.append(header, rows)
      fragment.appendChild(section)
    }
    el.sessionList.appendChild(fragment)
  }

  function isSessionMenuOpen() {
    return !!el.sessionMenu && !el.sessionMenu.hidden
  }

  function hideSessionMenu() {
    if (!el.sessionMenu) return
    el.sessionMenu.hidden = true
    el.sessionMenu.replaceChildren()
  }

  function showSessionMenu(session, x, y) {
    if (!el.sessionMenu) return
    el.sessionMenu.replaceChildren()

    const item = (label, hint, action, danger = false) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'context-menu-item' + (danger ? ' danger' : '')
      button.setAttribute('role', 'menuitem')
      const text = document.createElement('span')
      text.textContent = label
      button.append(text)
      if (hint) {
        const suffix = document.createElement('span')
        suffix.className = 'context-menu-hint'
        suffix.textContent = hint
        button.append(suffix)
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        hideSessionMenu()
        action().catch(reportError)
      })
      el.sessionMenu.append(button)
    }

    const actionsReady = !!meta.features?.pin
    const unavailable = () => {
      showToast('重启 DeepSeek Harness 后生效')
      return Promise.resolve()
    }
    item(session.pinned ? '取消置顶' : '置顶对话', actionsReady ? '' : '重启后', actionsReady ? () => setSessionPinned(session, !session.pinned) : unavailable)
    const sep = document.createElement('div')
    sep.className = 'context-menu-sep'
    el.sessionMenu.append(sep)
    item('归档对话', actionsReady ? (session.running ? '会停止运行' : '') : '重启后', actionsReady ? () => archiveSession(session) : unavailable, true)

    el.sessionMenu.hidden = false
    const rect = el.sessionMenu.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    el.sessionMenu.style.left = `${left}px`
    el.sessionMenu.style.top = `${top}px`
  }

  async function setSessionPinned(session, pinned) {
    await api('/session/pin', { method: 'POST', body: { sessionId: session.id, pinned } })
    session.pinned = pinned
    renderSessions()
    showToast(pinned ? '已置顶对话' : '已取消置顶')
  }

  async function archiveSession(session) {
    await api('/session/archive', { method: 'POST', body: { sessionId: session.id } })
    sessions = sessions.filter((item) => item.id !== session.id)
    if (currentId === session.id) {
      currentId = null
      currentTitle = '新对话'
      pendingNew = true
      snapshot = null
      liveStatus = null
      updateComposer()
      updateComposerStatus()
      updateUnread()
      updateLive(false)
    }
    renderSessions()
    showToast('已归档对话')
    await loadSessions().catch(() => {})
  }

  async function selectSession(sessionId, options = {}) {
    if (!sessionId) return
    const match = sessions.find((session) => session.id === sessionId)
    currentId = sessionId
    renderSessionColor()
    currentTitle = match?.title && match.title !== '未命名对话' ? match.title : '对话'
    currentWorkspaceId = match?.workspaceId || currentWorkspaceId
    pendingNew = false
    pendingWorkspaceId = null
    localStorage.setItem(STORE_SESSION, sessionId)
    snapshot = null
    seenRequestSeq = 0
    lastReplyKey = ''
    liveStatus = null
    updateComposer()
    updateComposerStatus()
    updateUnread()
    updateLive(false)
    if (match) {
      session.unread = false
      renderSessions()
    }
    if (!options.skipRefresh) {
      await refreshSnapshot({ force: true }).catch(reportError)
    }
    if (panel === 'reply') {
      markSeen()
      renderReply(true)
    }
  }

  function newConversation() {
    if (sending) return
    const current = sessions.find((session) => session.id === currentId)
    pendingWorkspaceId = current?.workspaceId || pendingWorkspaceId || meta.workspaces?.[0]?.id || null
    currentId = null
    currentTitle = '新对话'
    pendingNew = true
    snapshot = null
    seenRequestSeq = 0
    lastReplyKey = ''
    liveStatus = null
    localStorage.removeItem(STORE_SESSION)
    updateComposer()
    updateComposerStatus()
    updateUnread()
    updateLive(false)
    renderSessions()
    if (panel !== 'none') setPanel('none')
    el.prompt.focus()
  }

  async function refreshSnapshot(options = {}) {
    if (!currentId || refreshing || authFailed) return
    refreshing = true
    try {
      const data = await api('/snapshot?sessionId=' + encodeURIComponent(currentId))
      if (data?.session?.id && data.session.id !== currentId) return
      snapshot = data
      if (data.session?.title) {
        currentTitle = data.session.title
      }
      liveStatus = data.status || (data.running
        ? { phase: 'thinking', label: '正在思考…' }
        : (data.error ? { phase: 'error', label: '生成失败，查看回复' } : null))
      updateComposer()
      updateComposerStatus()
      updateLive(!!data.running || !!data.status, data.status?.phase)
      updateUnread()
      if (panel === 'reply') {
        if (data.unread || Number(data.lastAssistantSeq) > seenRequestSeq) markSeen()
        renderReply(!!options.force)
      }
      if (data.unread && panel !== 'reply' && !isSessionMenuOpen()) {
        renderSessions()
      }
    } finally {
      refreshing = false
    }
  }

  async function markSeen() {
    if (!currentId || authFailed || seenInFlight) return
    const seq = Number(snapshot?.lastAssistantSeq) || 0
    if (seq > 0 && seq <= seenRequestSeq && !snapshot?.unread) return
    seenInFlight = true
    try {
      await api('/seen', { method: 'POST', body: { sessionId: currentId } })
      seenRequestSeq = Math.max(seenRequestSeq, seq)
      if (snapshot) snapshot.unread = false
      const match = sessions.find((session) => session.id === currentId)
      if (match) match.unread = false
      updateUnread()
    } catch (error) {
      if (!authFailed) console.warn(error)
    } finally {
      seenInFlight = false
    }
  }

  async function sendMessage() {
    const text = el.prompt.value.trim()
    if (!text || sending) return
    if (authFailed) {
      showToast('连接已失效，请重启 DeepSeek Harness')
      return
    }
    const isNew = !currentId || pendingNew
    const workspaceId = isNew
      ? (pendingWorkspaceId || sessions.find((session) => session.id === currentId)?.workspaceId || meta.workspaces?.[0]?.id || null)
      : null
    const suffix = prefs.extraPrompt.trim()
    const outgoingText = suffix ? `${text}\n\n${suffix}` : text
    sending = true

    const optimistic = snapshot && Array.isArray(snapshot.messages) ? snapshot.messages.slice() : []
    optimistic.push({ role: 'user', text: outgoingText, seq: 0, time: Date.now() })
    snapshot = {
      ...(snapshot || {}),
      session: snapshot?.session || (currentId ? { id: currentId, title: currentTitle } : null),
      messages: optimistic,
      running: true,
      streaming: '',
      unread: false,
      error: null,
    }
    if (!currentId) currentTitle = text.length > 18 ? text.slice(0, 18) + '…' : text
    liveStatus = { phase: 'sending', label: '正在发送…' }
    updateComposer()
    updateComposerStatus()
    updateLive(true)
    updateUnread()
    if (panel === 'reply') renderReply(true)

    el.prompt.value = ''

    try {
      const result = await api('/send', {
        method: 'POST',
        body: {
          text: outgoingText,
          ...(isNew ? { workspaceId } : { sessionId: currentId }),
        },
      })
      if (result.sessionId) {
        currentId = result.sessionId
        pendingNew = false
        pendingWorkspaceId = null
        currentWorkspaceId = result.workspaceId || workspaceId || currentWorkspaceId
        localStorage.setItem(STORE_SESSION, currentId)
      }
      updateComposer()
      await loadSessions().catch(() => {})
      await refreshSnapshot({ force: true }).catch(reportError)
    } catch (error) {
      snapshot = {
        ...(snapshot || {}),
        running: false,
        streaming: '',
        error: error?.message || '发送失败',
      }
      liveStatus = { phase: 'error', label: '发送失败，请重试' }
      updateComposerStatus()
      updateLive(false)
      if (panel === 'reply') renderReply(true)
      reportError(error)
    } finally {
      sending = false
      refreshSnapshot().catch(() => {})
    }
  }

  function renderReply(forceScroll = false) {
    if (panel !== 'reply') return
    const running = !!snapshot?.running

    const status = liveStatus || snapshot?.status || null
    const key = JSON.stringify({
      id: currentId,
      messages: snapshot?.messages || [],
      streaming: snapshot?.streaming || '',
      running,
      status: running ? { phase: status?.phase || '', label: status?.label || '', detail: status?.detail || '' } : null,
      error: snapshot?.error || null,
    })
    if (!forceScroll && key === lastReplyKey) {
      updateUnread()
      return
    }
    lastReplyKey = key

    const nearBottom = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 42
    const previousScroll = el.transcript.scrollTop
    el.transcript.replaceChildren()

    const messages = snapshot?.messages || []
    if (!currentId && messages.length === 0) {
      renderReplyEmpty('新对话', '在下方输入一句话，开始对话')
      return
    }
    if (messages.length === 0 && !running && !snapshot?.error) {
      renderReplyEmpty('还没有回复', '发送消息后，回复会显示在这里')
      return
    }

    for (const message of messages) {
      addMessage(message.role === 'user' ? 'user' : 'assistant', message.text || '')
    }
    if (running && status?.label) {
      addLiveStatus(status)
    }
    if (snapshot?.streaming) {
      addMessage('assistant', snapshot.streaming, { streaming: true })
    } else if (running && !status?.label) {
      addTyping()
    }
    if (snapshot?.error) {
      addMessage('error', snapshot.error)
    }

    requestAnimationFrame(() => {
      if (forceScroll || nearBottom) {
        el.transcript.scrollTop = el.transcript.scrollHeight
      } else {
        el.transcript.scrollTop = previousScroll
      }
    })
    updateUnread()
  }

  function renderReplyEmpty(title, subtitle) {
    const empty = document.createElement('div')
    empty.className = 'reply-empty'
    const strong = document.createElement('strong')
    strong.textContent = title
    const span = document.createElement('span')
    span.textContent = subtitle
    empty.append(strong, span)
    el.transcript.appendChild(empty)
  }

  function addMessage(role, text, options = {}) {
    const wrap = document.createElement('div')
    wrap.className = 'msg ' + (role === 'error' ? 'error' : role)
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (role === 'user') {
      bubble.textContent = text
    } else if (role === 'error') {
      bubble.textContent = text
    } else {
      bubble.innerHTML = renderMarkdown(text)
      if (options.streaming) {
        const caret = document.createElement('span')
        caret.className = 'stream-caret'
        bubble.appendChild(caret)
      }
    }
    wrap.appendChild(bubble)
    el.transcript.appendChild(wrap)
  }

  function addTyping() {
    const wrap = document.createElement('div')
    wrap.className = 'msg assistant'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const typing = document.createElement('span')
    typing.className = 'typing'
    typing.innerHTML = '<i></i><i></i><i></i>'
    bubble.appendChild(typing)
    wrap.appendChild(bubble)
    el.transcript.appendChild(wrap)
  }

  function addLiveStatus(status) {
    const wrap = document.createElement('div')
    wrap.className = 'msg assistant live-status'
    const bubble = document.createElement('div')
    bubble.className = 'bubble live-status-bubble'
    const text = document.createElement('span')
    text.className = 'live-status-text'
    const label = document.createElement('strong')
    label.textContent = status?.label || '正在处理…'
    text.appendChild(label)
    const detail = String(status?.detail || '').replace(/\s+/g, ' ').trim()
    if (detail) {
      const span = document.createElement('span')
      span.textContent = detail
      text.appendChild(span)
    }
    bubble.appendChild(text)
    wrap.appendChild(bubble)
    el.transcript.appendChild(wrap)
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function renderMarkdown(source) {
    try {
      return renderMarkdownUnsafe(source)
    } catch {
      return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`
    }
  }

  function renderMarkdownUnsafe(source) {
    const tokens = []
    let text = String(source || '').replace(/\r\n?/g, '\n')

    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, language, code) => {
      const index = tokens.length
      const lang = String(language || '').trim()
      tokens.push(`<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
      return `\u0000${index}\u0000`
    })

    text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
      const index = tokens.length
      tokens.push(`<code>${escapeHtml(code)}</code>`)
      return `\u0000${index}\u0000`
    })

    let html = escapeHtml(text)
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')

    const lines = html.split('\n')
    const output = []
    let paragraph = []
    let listType = null

    const flushParagraph = () => {
      if (paragraph.length === 0) return
      output.push(`<p>${paragraph.join('<br>')}</p>`)
      paragraph = []
    }
    const closeList = () => {
      if (!listType) return
      output.push(`</${listType}>`)
      listType = null
    }

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') {
        flushParagraph()
        closeList()
        continue
      }
      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
      if (heading) {
        flushParagraph()
        closeList()
        const level = Math.min(3, heading[1].length)
        output.push(`<h${level}>${heading[2]}</h${level}>`)
        continue
      }
      const unordered = trimmed.match(/^[-*+]\s+(.+)$/)
      if (unordered) {
        flushParagraph()
        if (listType !== 'ul') {
          closeList()
          output.push('<ul>')
          listType = 'ul'
        }
        output.push(`<li>${unordered[1]}</li>`)
        continue
      }
      const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/)
      if (ordered) {
        flushParagraph()
        if (listType !== 'ol') {
          closeList()
          output.push('<ol>')
          listType = 'ol'
        }
        output.push(`<li>${ordered[1]}</li>`)
        continue
      }
      const quote = trimmed.match(/^&gt;\s?(.*)$/)
      if (quote) {
        flushParagraph()
        closeList()
        output.push(`<blockquote>${quote[1]}</blockquote>`)
        continue
      }
      closeList()
      paragraph.push(line)
    }
    flushParagraph()
    closeList()
    let result = output.join('')
    result = result.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || '')
    return result
  }

  function tick() {
    if (authFailed) return
    pollCount += 1
    const fast = panel === 'reply' || sending || !!snapshot?.running || activity.running || activity.approval
    if (fast || pollCount % 2 === 0) {
      refreshSnapshot().catch(reportError)
    }
    refreshActivity().catch(() => {})
    if (Date.now() - lastMetaAt > 30_000) {
      loadMeta().catch(() => {})
    }
    if (panel === 'sessions' && pollCount % 3 === 0 && !isSessionMenuOpen()) {
      loadSessions().catch(() => {})
    }
  }

  function bindEvents() {
    el.dragbar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      if (autoCollapsed) {
        if (!event.target.closest('button') && !event.target.closest('#brandBtn')) {
          event.preventDefault()
          event.stopPropagation()
          postNative({ type: 'expand' })
        }
        return
      }
      if (event.target.closest('button, #brandBtn')) return
      if (event.target.closest('.resize-edge')) return
      postNative({ type: 'drag' })
    })

    for (const handle of document.querySelectorAll('[data-resize]')) {
      const edges = handle.dataset.resize || ''
      const horizontal = edges.includes('left') || edges.includes('right')
      const verticalSign = edges.includes('bottom') ? 1 : edges.includes('top') ? -1 : 0
      let drag = null
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        drag = {
          startX: event.screenX,
          startY: event.screenY,
          startPanel: panelHeights[panel] || 0,
          verticalSign,
        }
        handle.setPointerCapture(event.pointerId)
        if (horizontal) postNative({ type: 'resize-start', edges })
      })
      handle.addEventListener('pointermove', (event) => {
        if (!drag) return
        event.preventDefault()
        if (horizontal) {
          postNative({ type: 'window-resize', dx: Math.round(event.screenX - drag.startX) })
        }
        if (drag.verticalSign && panel !== 'none') {
          const delta = (event.screenY - drag.startY) * drag.verticalSign
          const next = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(drag.startPanel + delta)))
          if (next !== panelHeights[panel]) {
            panelHeights[panel] = next
            try { localStorage.setItem(STORE_PANEL_HEIGHTS, JSON.stringify(panelHeights)) } catch {}
            reportHeight()
          }
        }
      })
      const end = (event) => {
        if (!drag) return
        drag = null
        try { handle.releasePointerCapture(event.pointerId) } catch {}
        if (horizontal) postNative({ type: 'resize-end' })
        if (vertical) {
          try { localStorage.setItem(STORE_PANEL_HEIGHTS, JSON.stringify(panelHeights)) } catch {}
        }
      }
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    }

    el.prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        sendMessage()
      }
    })

    el.sessionBtn.addEventListener('click', openSessionsPanel)
    el.replyBtn.addEventListener('click', () => {
      reopenReplyAfterPick = false
      setPanel('reply')
    })
    el.newBtn.addEventListener('click', startNewFromSessions)
    el.returnBtn?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      postNative({ type: 'return' })
    })
    el.balanceBtn.addEventListener('click', () => {
      postNative({ type: 'open-external', url: 'https://platform.deepseek.com/usage' })
    })
    el.pinBtn.addEventListener('click', () => {
      const next = el.pinBtn.getAttribute('aria-pressed') !== 'true'
      setPinned(next)
      postNative({ type: 'pin', value: next })
    })
    let hotkeyCapture = null
    const hotkeyButtons = () => ({ hotkey: el.hotkeyBtn, hideHotkey: el.hideHotkeyBtn })
    const resetHotkeyCapture = () => {
      hotkeyCapture = null
      for (const button of Object.values(hotkeyButtons())) {
        if (!button) continue
        button.classList.remove('capturing')
        button.textContent = button.id === 'hideHotkeyBtn' ? prefs.hideHotkey : prefs.hotkey
      }
    }
    const beginHotkeyCapture = (field, button) => {
      if (!button) return
      hotkeyCapture = field
      button.classList.add('capturing')
      button.textContent = '按下组合键…'
    }
    el.hotkeyBtn?.addEventListener('click', () => beginHotkeyCapture('hotkey', el.hotkeyBtn))
    el.hideHotkeyBtn?.addEventListener('click', () => beginHotkeyCapture('hideHotkey', el.hideHotkeyBtn))
    document.addEventListener('keydown', (event) => {
      if (!hotkeyCapture) return
      if (!settingsOpen) {
        resetHotkeyCapture()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        resetHotkeyCapture()
        return
      }
      const keyName = (() => {
        if (event.key === ' ') return 'Space'
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return ''
        const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace' }
        if (map[event.key]) return map[event.key]
        if (event.key.length === 1) return event.key.toUpperCase()
        return event.key
      })()
      if (!keyName) return
      const modifiers = []
      if (event.ctrlKey) modifiers.push('Ctrl')
      if (event.altKey) modifiers.push('Alt')
      if (event.shiftKey) modifiers.push('Shift')
      if (event.metaKey) modifiers.push('Win')
      const targetButton = hotkeyButtons()[hotkeyCapture]
      if (modifiers.length === 0) {
        if (targetButton) targetButton.textContent = '需要带 Ctrl/Alt/Shift/Win'
        return
      }
      const field = hotkeyCapture
      prefs[field] = [...modifiers, keyName].join('+')
      resetHotkeyCapture()
      applyPrefs()
      postNative({ type: 'hotkey', target: field === 'hideHotkey' ? 'hide' : 'wake', value: prefs[field] })
    }, true)
    el.settingsBtn.addEventListener('click', openSettings)
    el.settingsClose?.addEventListener('click', closeSettings)
    el.settingsOverlay?.addEventListener('pointerdown', (event) => {
      if (event.target === el.settingsOverlay) closeSettings()
    })
    for (const button of document.querySelectorAll('[data-expand]')) {
      button.addEventListener('click', () => {
        prefs.expandUp = button.dataset.expand === 'up'
        applyPrefs()
      })
    }
    for (const button of document.querySelectorAll('[data-font]')) {
      button.addEventListener('click', () => {
        prefs.fontScale = Number(button.dataset.font) || 1
        applyPrefs()
      })
    }
    for (const button of document.querySelectorAll('[data-dock]')) {
      button.addEventListener('click', () => {
        prefs.dock = button.dataset.dock || 'float'
        applyPrefs()
      })
    }
    el.brandBtn?.addEventListener('click', () => {
      postNative({ type: autoCollapsed ? 'expand' : 'collapse' })
    })
    el.brandBtn?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      postNative({ type: autoCollapsed ? 'expand' : 'collapse' })
    })
    el.extraPrompt?.addEventListener('input', () => {
      prefs.extraPrompt = el.extraPrompt.value
      savePrefs()
    })

    document.addEventListener('pointerdown', (event) => {
      if (el.sessionMenu && !el.sessionMenu.hidden && !el.sessionMenu.contains(event.target)) hideSessionMenu()
    }, true)
    window.addEventListener('blur', hideSessionMenu)

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (settingsOpen) {
          closeSettings()
          return
        }
        if (el.sessionMenu && !el.sessionMenu.hidden) {
          hideSessionMenu()
          return
        }
        if (panel !== 'none') {
          reopenReplyAfterPick = false
          setPanel('none')
          el.prompt.focus()
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        el.prompt.focus()
      }
    })

    el.transcript.addEventListener('scroll', () => {
      // Rendering preserves the user's position when they scroll away from the bottom.
    })

    window.chrome?.webview?.addEventListener('message', (event) => {
      const message = event.data
      if (!message || typeof message !== 'object') return
      if (message.type === 'host-state') {
        setPinned(!!message.pinned)
        document.documentElement.dataset.theme = message.dark ? 'dark' : 'light'
        hostPrefsLoaded = true
        if (message.prefs && typeof message.prefs === 'object') {
          prefs.expandUp = !!message.prefs.expandUp
          prefs.fontScale = Math.min(1.25, Math.max(0.85, Number(message.prefs.fontScale) || 1))
          prefs.dock = ['center', 'left'].includes(message.prefs.dock) ? message.prefs.dock : 'float'
          prefs.hotkey = typeof message.prefs.hotkey === 'string' && message.prefs.hotkey ? message.prefs.hotkey : 'Ctrl+Alt+Space'
          prefs.hideHotkey = typeof message.prefs.hideHotkey === 'string' && message.prefs.hideHotkey ? message.prefs.hideHotkey : 'Ctrl+Alt+H'
          prefs.extraPrompt = typeof message.prefs.extraPrompt === 'string' ? message.prefs.extraPrompt : ''
          applyPrefs()
        }
        setAutoCollapsed(!!message.collapsed)
      } else if (message.type === 'collapsed') {
        setAutoCollapsed(!!message.value)
      } else if (message.type === 'focus') {
        el.prompt.focus()
      }
    })
  }

  function setPinned(pinned) {
    el.pinBtn.setAttribute('aria-pressed', String(!!pinned))
    el.pinBtn.title = pinned ? '已置顶，点击取消置顶' : '置顶到所有窗口最前方'
  }

  async function boot() {
    bindEvents()
    setPinned(true)
    applyPrefs()
    updateComposer()
    updateComposerStatus()
    updatePricePeriod()
    setInterval(updatePricePeriod, 60_000)
    reportHeight()
    postNative({ type: 'ready' })
    const previewSession = new URLSearchParams(location.search).get('session')
    if (previewSession) localStorage.setItem(STORE_SESSION, previewSession)
    try {
      await loadMeta()
      await loadSessions()
      if (currentId) {
        await selectSession(currentId, { skipRefresh: true }).catch(() => {})
        await refreshSnapshot({ force: true })
      } else {
        renderSessions()
        updateComposer()
      }
    } catch (error) {
      reportError(error)
    }
    const previewPanel = new URLSearchParams(location.search).get('panel')
    if (previewPanel === 'sessions' || previewPanel === 'reply') {
      setTimeout(() => setPanel(previewPanel), 350)
    }
    setInterval(tick, 250)
  }

  boot()
})()
