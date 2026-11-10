/**
 * DeepSeek Harness floating input — Host plugin.
 *
 * Owns a small loopback-only HTTP API for the always-on-top companion window
 * (`helper/DSHFloatingInput.exe`) and starts/stops that companion with the
 * Harness host.  The companion is deliberately a separate native process: a
 * Web page can draw a floating card inside the Harness window, but only a
 * native window can stay above every other application.
 */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const OVERLAY_DIR = join(PLUGIN_DIR, 'overlay')
const HELPER_DIR = join(PLUGIN_DIR, 'helper')
const HELPER_EXE = join(HELPER_DIR, 'DSHFloatingInput.exe')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, '.dsh-floating-input.json')
const LOG_FILE = join(DSH_HOME, 'dsh-floating-input.log')
const ROUTE_ROOT = '/dsh-floating'
const TOKEN = process.env.DSH_FLOATING_TOKEN || randomBytes(24).toString('hex')
const VERSION = readPackageVersion()
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 30_000
const MAX_BODY = 32 * 1024 * 1024
const MAX_SESSIONS = 60
const MAX_MESSAGES = 50

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '0.1.0'
  } catch {
    return '0.1.0'
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack || p.message : String(p))).join(' ')}\n`
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 512 * 1024) {
      try { renameSync(LOG_FILE, `${LOG_FILE}.old`) } catch {}
    }
    appendFileSync(LOG_FILE, line, 'utf8')
  } catch {}
  try { console.log('[dsh-floating-input]', ...parts) } catch {}
}

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function clampFontScale(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0.8 || n > 1.6) return 1
  return Math.round(n * 100) / 100
}

function loadState() {
  const raw = readJsonFile(STATE_FILE)
  return {
    seen: raw && raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
    colors: raw && raw.colors && typeof raw.colors === 'object' ? raw.colors : {},
    colorScopes: raw && raw.colorScopes && typeof raw.colorScopes === 'object' ? raw.colorScopes : {},
    lastSessionId: raw && typeof raw.lastSessionId === 'string' ? raw.lastSessionId : null,
    desktopSessionId: raw && typeof raw.desktopSessionId === 'string' ? raw.desktopSessionId : null,
    desktopSessionAt: raw && Number.isFinite(Number(raw.desktopSessionAt)) ? Number(raw.desktopSessionAt) : 0,
    desktopFontScale: clampFontScale(raw?.desktopFontScale),
  }
}

const state = loadState()
let stateSaveTimer = null
function saveStateSoon() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer)
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null
    try {
      mkdirSync(DSH_HOME, { recursive: true })
      const tmp = `${STATE_FILE}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: 1, seen: state.seen, colors: state.colors, colorScopes: state.colorScopes, lastSessionId: state.lastSessionId, desktopSessionId: state.desktopSessionId, desktopSessionAt: state.desktopSessionAt, desktopFontScale: state.desktopFontScale }), 'utf8')
      renameSync(tmp, STATE_FILE)
    } catch (error) {
      log('state write failed:', error)
    }
  }, 150)
}

const SESSION_COLORS = [
  '#ff5d5d', '#ff8f3f', '#ffc43d', '#b6d94c', '#59d98c', '#35c9b1',
  '#38bdf8', '#5b8cff', '#8b7cff', '#c084fc', '#f472b6', '#fb7185',
  '#e8793c', '#a3b83f', '#2ec4a6', '#22a7d8', '#4f7cff', '#a66cff',
  '#e05fc4', '#ff6b9d',
]

function colorForSession(sessionId, workspaceId) {
  const id = String(sessionId || '')
  if (!id) return '#6b7280'
  const scope = String(workspaceId || '')
  const existing = state.colors[id]
  const used = new Set()
  for (const [otherId, color] of Object.entries(state.colors)) {
    if (otherId === id) continue
    if (String(state.colorScopes[otherId] || '') === scope) used.add(color)
  }
  if (typeof existing === 'string' && existing && !used.has(existing)) {
    state.colorScopes[id] = scope
    return existing
  }
  const available = SESSION_COLORS.filter((color) => !used.has(color))
  let color
  if (available.length > 0) {
    color = available[Math.floor(Math.random() * available.length)]
  } else {
    let attempt = 0
    do {
      color = `hsl(${Math.floor(Math.random() * 360)} 68% 56%)`
      attempt += 1
    } while (used.has(color) && attempt < 40)
  }
  state.colors[id] = color
  state.colorScopes[id] = scope
  saveStateSoon()
  return color
}

function extractText(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function displayError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return String(error) }
}

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function tokenMatches(candidate) {
  const supplied = Buffer.from(String(candidate || ''))
  const expected = Buffer.from(TOKEN)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function authorized(req, url) {
  if (!isLoopback(req)) return false
  return tokenMatches(req.headers['x-dsh-floating-token'] || url.searchParams.get('token'))
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

async function readBody(req) {
  return await new Promise((resolvePromise, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (total === 0) return resolvePromise({})
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

const staticCache = new Map()
function readAsset(relativePath) {
  const file = resolve(OVERLAY_DIR, `.${sep}${relativePath}`)
  if (!file.startsWith(OVERLAY_DIR + sep)) return null
  let stat
  try { stat = statSync(file) } catch { return null }
  if (!stat.isFile()) return null
  const cached = staticCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
  const body = readFileSync(file)
  const entry = { body, mtimeMs: stat.mtimeMs, size: stat.size, type: MIME[extname(file).toLowerCase()] || 'application/octet-stream' }
  staticCache.set(file, entry)
  return entry
}

function serveAsset(req, res, pathname) {
  let rel = pathname.slice(ROUTE_ROOT.length).replace(/^\/+/, '')
  if (!rel) rel = 'index.html'
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  if (rel === 'index.html' && !authorized(req, new URL(req.url || '/', 'http://127.0.0.1'))) {
    return sendText(res, 403, 'Forbidden')
  }
  const asset = readAsset(rel)
  if (!asset) return sendText(res, 404, 'Not found')
  const headers = {
    'content-type': asset.type,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  if (asset.type.startsWith('text/html')) {
    headers['content-security-policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
  }
  res.writeHead(200, headers)
  res.end(asset.body)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ autoStart?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  log(`host plugin loading (version ${VERSION})`)

  // The Windows caption menubar is rendered by the Desktop shell, not the Web
  // UI.  Its shadow root is open, so one small injected script can add the
  // "快捷栏" entry beside 应用/编辑 without replacing any shell code.
  const miniMenuScript = `(function(){try{
    if(location.protocol!=='dsh-app:')return;
    if(document.documentElement.dataset.dshMiniMenu)return;
    document.documentElement.dataset.dshMiniMenu='1';
    var token=${JSON.stringify(TOKEN)};
    function install(){
      var host=document.querySelector('[data-windows-menu]');
      if(!host||!host.shadowRoot)return false;
      var bar=host.shadowRoot.querySelector('[role="menubar"]');
      if(!bar)return false;
      var zh=(document.documentElement.lang||'').toLowerCase().indexOf('zh')===0;
      if(!bar.querySelector('[data-dsh-mini-menu]')){
        var b=document.createElement('button');
        b.type='button';
        b.setAttribute('role','menuitem');
        b.setAttribute('data-dsh-mini-menu','');
        b.tabIndex=0;
        b.textContent=zh?'快捷栏':'Quick Bar';
        b.title=zh?'打开快捷栏（与桌面版共存）':'Open the quick bar alongside the desktop app';
        b.addEventListener('click',function(event){
          event.preventDefault();
          fetch('/dsh-floating/api/mini?token='+encodeURIComponent(token),{method:'POST',cache:'no-store'}).catch(function(){});
        });
        bar.appendChild(b);
      }
      if(!bar.querySelector('[data-dsh-reset-menu]')){
        var reset=document.createElement('button');
        reset.type='button';
        reset.setAttribute('role','menuitem');
        reset.setAttribute('data-dsh-reset-menu','');
        reset.tabIndex=0;
        reset.textContent=zh?'重置快捷栏':'Reset Quick Bar';
        reset.title=zh?'把快捷栏放回屏幕底部中间并显示':'Move the quick bar back to the bottom center';
        reset.addEventListener('click',function(event){
          event.preventDefault();
          fetch('/dsh-floating/api/mini/reset?token='+encodeURIComponent(token),{method:'POST',cache:'no-store'}).catch(function(){});
        });
        bar.appendChild(reset);
      }
      return true;
    }
    if(!install()){
      var observer=new MutationObserver(function(){if(install())observer.disconnect()});
      observer.observe(document.documentElement,{childList:true,subtree:true});
    }
  }catch(e){}})()`

  const desktopSeenScript = `(function(){try{
    if(location.protocol!=='dsh-app:')return;
    if(document.documentElement.dataset.dshDesktopSeen)return;
    document.documentElement.dataset.dshDesktopSeen='1';
    var token=${JSON.stringify(TOKEN)};
    var last='';
    function post(path,id){
      if(!id)return;
      fetch('/dsh-floating/api/'+path+'?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:id})}).catch(function(){});
    }
    function mark(id){
      if(!id)return;
      last=id;
      post('desktop-session',id);
    }
    function selected(){
      var row=document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
      if(!row)return '';
      return row.getAttribute('data-row-key').slice(8);
    }
    function sync(){
      if(document.visibilityState==='hidden')return;
      var id=selected();
      if(id&&id!==last)mark(id);
    }
    document.addEventListener('visibilitychange',function(){if(!document.hidden)sync();});
    sync();
    setInterval(sync,1000);
    setInterval(function(){
      if(document.visibilityState==='hidden')return;
      var id=selected();
      if(id)post('seen',id);
    },5000);
  }catch(e){}})()`

  // 桌面版字号：窗外的快捷栏改一个数字，桌面应用这边轮询后整体缩放
  const desktopFontScript = `(function(){try{
    if(document.documentElement.dataset.dshDesktopFont)return;
    document.documentElement.dataset.dshDesktopFont='1';
    var token=${JSON.stringify(TOKEN)};
    var el=document.documentElement;
    function apply(scale){
      var s=Number(scale);
      if(!(s>0))return;
      if(Math.abs(s-1)<0.001){if(el.style.zoom)el.style.zoom='';return;}
      var v=String(s);
      if(el.style.zoom!==v)el.style.zoom=v;
    }
    function tick(){
      fetch('/dsh-floating/api/desktop-font?token='+encodeURIComponent(token),{cache:'no-store'})
        .then(function(r){return r.json()})
        .then(function(d){if(d&&typeof d.scale==='number')apply(d.scale)})
        .catch(function(){});
    }
    tick();setInterval(tick,2000);
  }catch(e){}})()`
  const desktopStatusScript = `(function(){try{
    if(location.protocol!=='dsh-app:')return;
    if(document.documentElement.dataset.dshTaskDots)return;
    document.documentElement.dataset.dshTaskDots='1';
    var token=${JSON.stringify(TOKEN)};
    var states={};
    function ensureStyle(){
      if(document.getElementById('dsh-task-dot-style'))return;
      var style=document.createElement('style');
      style.id='dsh-task-dot-style';
      style.textContent='.dsh-task-slot{width:10px!important;justify-content:flex-start!important;overflow:visible!important}.dsh-task-slot>*:not(.dsh-task-dot){display:none!important}.dsh-task-dot{width:5px;height:5px;flex:0 0 5px;margin-left:-3px;border-radius:50%;background:#6b7280}.dsh-task-dot.running{background:#4c9bff;animation:dshTaskPulseBlue 1.9s ease-in-out infinite}.dsh-task-dot.approval{background:#ff453a;animation:dshTaskPulseRed 1.8s ease-in-out infinite}.dsh-task-dot.done{background:#32d74b;box-shadow:0 0 0 2px rgba(50,215,75,.16),0 0 5px rgba(50,215,75,.28)}@keyframes dshTaskPulseBlue{0%,100%{opacity:.62;transform:scale(.92);box-shadow:0 0 0 1px rgba(76,155,255,.14),0 0 2px rgba(76,155,255,.2)}50%{opacity:1;transform:scale(1.08);box-shadow:0 0 0 2px rgba(76,155,255,.24),0 0 4px rgba(76,155,255,.5)}}@keyframes dshTaskPulseRed{0%,100%{opacity:.62;transform:scale(.92);box-shadow:0 0 0 1px rgba(255,69,58,.16),0 0 2px rgba(255,69,58,.22)}50%{opacity:1;transform:scale(1.1);box-shadow:0 0 0 2px rgba(255,69,58,.26),0 0 4px rgba(255,69,58,.56)}}';
      document.head.appendChild(style);
    }
    function apply(){
      var rows=document.querySelectorAll('[data-row-key^="session:"]');
      rows.forEach(function(row){
        var slot=row.querySelector('[class*="_slot"]');
        if(!slot)return;
        var id=row.getAttribute('data-row-key').slice(8);
        var state=states[id];
        slot.classList.add('dsh-task-slot');
        var dot=slot.querySelector('.dsh-task-dot');
        if(!state){
          if(dot)dot.remove();
          return;
        }
        if(!dot){
          dot=document.createElement('span');
          dot.className='dsh-task-dot';
          slot.appendChild(dot);
        }
        dot.className='dsh-task-dot '+state;
      });
    }
    function refresh(){
      fetch('/dsh-floating/api/activity?token='+encodeURIComponent(token)).then(function(r){return r.json()}).then(function(data){
        var next={};
        (data&&data.items?data.items:[]).forEach(function(item){next[item.id]=item.state});
        states=next;
        ensureStyle();
        apply();
      }).catch(function(){});
    }
    ensureStyle();
    refresh();
    setInterval(refresh,1000);
    setInterval(apply,1000);
  }catch(e){}})()`

  const sessionColorScript = `(function(){try{
    if(location.protocol!=='dsh-app:')return;
    if(document.documentElement.dataset.dshSessionColors)return;
    document.documentElement.dataset.dshSessionColors='1';
    var token=${JSON.stringify(TOKEN)};
    var cache={};
    function ensureStyle(){
      if(document.getElementById('dsh-session-color-style'))return;
      var style=document.createElement('style');
      style.id='dsh-session-color-style';
      style.textContent='.dsh-session-color{width:8px;height:8px;border-radius:2px;flex:0 0 8px;margin-right:5px;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.18)}';
      document.head.appendChild(style);
    }
    function paint(){
      var rows=document.querySelectorAll('[data-row-key^="session:"]');
      var ids=[];
      rows.forEach(function(row){
        var id=row.getAttribute('data-row-key').slice(8);
        var color=cache[id];
        if(/(^|\\s)\\S*archived/.test(row.className))color='#6b7280';
        if(!color){ids.push(id);return;}
        var title=row.querySelector('[class*="title"]');
        if(!title)return;
        var square=row.querySelector('.dsh-session-color');
        if(!square){square=document.createElement('span');square.className='dsh-session-color';row.insertBefore(square,title);}
        square.style.background=color;
      });
      if(ids.length===0)return;
      fetch('/dsh-floating/api/colors?token='+encodeURIComponent(token)+'&ids='+encodeURIComponent(ids.join(','))).then(function(r){return r.json()}).then(function(data){
        if(!data||!data.colors)return;
        var changed=false;
        Object.keys(data.colors).forEach(function(id){if(!cache[id]){cache[id]=data.colors[id];changed=true;}});
        if(changed)setTimeout(paint,0);
      }).catch(function(){});
    }
    var timer=null;
    var observer=new MutationObserver(function(){if(timer)clearTimeout(timer);timer=setTimeout(function(){ensureStyle();paint();},60);});
    observer.observe(document.documentElement,{childList:true,subtree:true});
    ensureStyle();paint();
    setInterval(function(){ensureStyle();paint();},3000);
  }catch(e){}})()`

  ctx.effect(() => {
    const off = ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      if (!table.some((row) => row?.kind === 'script' && typeof row.text === 'string' && row.text.includes('data-dsh-mini-menu'))) {
        table.push({ kind: 'script', placement: 'body', text: miniMenuScript })
      }
      if (!table.some((row) => row?.kind === 'script' && typeof row.text === 'string' && row.text.includes('dshDesktopSeen'))) {
        table.push({ kind: 'script', placement: 'body', text: desktopSeenScript })
      }
      if (!table.some((row) => row?.kind === 'script' && typeof row.text === 'string' && row.text.includes('dshDesktopFont'))) {
        table.push({ kind: 'script', placement: 'body', text: desktopFontScript })
      }
    })
    return () => { try { off() } catch {} }
  })

  ctx.inject(['webServer', 'sessionQuery', 'workspaceRegistry', 'sessionController'], (c) => {
    const runtime = {
      origin: '',
      autoStart: config?.autoStart === true,
      helper: null,
      helperStopping: false,
      helperRestarts: 0,
      helperTimer: null,
      events: new Map(),
      streams: new Map(),
      statuses: new Map(),
      titles: new Map(),
      surfaces: new Map(),
      sessionsCache: null,
      balance: null,
      error: null,
    }

    const eventFor = (sessionId) => {
      let entry = runtime.events.get(sessionId)
      if (!entry) {
        entry = { running: false, active: false, doneAt: 0, startedAt: 0, error: null }
        runtime.events.set(sessionId, entry)
      }
      return entry
    }

    const agentSessionId = (agent) => String(agent?.session?.id || agent?.sessionId || '')

    const setStatus = (sessionId, phase, label, detail = '') => {
      if (!sessionId) return
      const previous = runtime.statuses.get(sessionId)
      runtime.statuses.set(sessionId, {
        phase,
        label,
        detail: String(detail || '').replace(/\s+/g, ' ').trim().slice(-160),
        since: previous?.phase === phase ? previous.since : Date.now(),
      })
    }

    const clearStatus = (sessionId) => {
      if (sessionId) runtime.statuses.delete(sessionId)
    }

    const reasoningPreview = (text) => {
      const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#-]+/g, ' ').replace(/\s+/g, ' ').trim()
      return clean.length > 120 ? clean.slice(-120) : clean
    }

    const workspaceFor = (workspaceId) => {
      const list = c.workspaceRegistry.list()
      if (workspaceId) {
        const found = list.find((workspace) => String(workspace.id) === String(workspaceId))
        if (found) return found
      }
      return list[0] || null
    }

    const titleFor = async (sessionId) => {
      const cached = runtime.titles.get(sessionId)
      if (cached && Date.now() - cached.at < 10_000) return cached
      let title = null
      let createdAt = 0
      let updatedAt = 0
      try {
        const live = c.get('sessions')?.get?.(sessionId)
        if (live) {
          const snapshot = c.get('sessionTitle')?.get?.(live)
          if (snapshot && snapshot.title) title = snapshot.title
        }
        if (!title) {
          const observation = await c.sessionQuery.readTitleSnapshot(sessionId)
          const snapshot = observation?.title
          if (snapshot && snapshot.title) {
            title = snapshot.title
            updatedAt = Number(snapshot.updatedAt) || 0
          }
          createdAt = Number(observation?.session?.createdAt) || 0
          if (!updatedAt) updatedAt = createdAt
        }
      } catch {}
      const value = {
        title: title || '未命名对话',
        createdAt,
        updatedAt,
        at: Date.now(),
      }
      runtime.titles.set(sessionId, value)
      return value
    }

    const listSessions = async () => {
      if (runtime.sessionsCache && Date.now() - runtime.sessionsCache.at < 3_000) return runtime.sessionsCache.value
      const registry = c.workspaceRegistry
      const archived = new Set((registry.archivedSessionIds || []).map(String))
      const workspaces = registry.list().map((workspace) => ({
        id: String(workspace.id),
        title: workspace.title,
        path: workspace.path,
        sessionIds: workspace.sessionIds.map(String),
      }))
      const entries = []
      const seen = new Set()
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds) {
          if (archived.has(sessionId) || seen.has(sessionId)) continue
          seen.add(sessionId)
          entries.push({
            id: sessionId,
            workspaceId: workspace.id,
            workspaceTitle: workspace.title,
            path: workspace.path,
          })
          if (entries.length >= MAX_SESSIONS) break
        }
        if (entries.length >= MAX_SESSIONS) break
      }
      const titles = new Map()
      if (entries.length > 0) {
        try {
          const observations = await c.sessionQuery.readTitleSnapshots(entries.map((entry) => entry.id))
          for (const observation of observations) {
            if (observation.status !== 'fulfilled') continue
            const sessionId = String(observation.sessionId)
            const value = observation.value
            const snapshot = value?.title
            titles.set(sessionId, {
              title: snapshot?.title || '未命名对话',
              createdAt: Number(value?.session?.createdAt) || 0,
              updatedAt: Number(snapshot?.updatedAt) || Number(value?.session?.createdAt) || 0,
            })
          }
        } catch (error) {
          log('readTitleSnapshots failed:', displayError(error))
        }
      }
      const pinned = new Set((registry.pinnedSessionIds || []).map(String))
      const value = entries.map((entry) => {
        const meta = titles.get(entry.id) || {}
        const activity = runtime.events.get(entry.id)
        const status = runtime.statuses.get(entry.id)
        const seenAt = Number(state.seen[entry.id]) || 0
        return {
          ...entry,
          title: meta.title || '未命名对话',
          createdAt: meta.createdAt || 0,
          updatedAt: meta.updatedAt || 0,
          running: !!activity?.running || !!status,
          approval: status?.phase === 'approval',
          pinned: pinned.has(entry.id),
          color: colorForSession(entry.id, entry.workspaceId),
          unread: !!activity?.doneAt && activity.doneAt > seenAt,
        }
      })
      runtime.sessionsCache = { at: Date.now(), value }
      return value
    }

    const surfaceFor = async (sessionId) => {
      const live = c.get('sessions')?.get?.(sessionId) || null
      const seq = live && typeof live.seq === 'number' ? live.seq : null
      const cached = runtime.surfaces.get(sessionId)
      if (cached && cached.seq === seq) return cached
      const surface = await c.sessionQuery.readSurface(sessionId)
      const messages = []
      let lastAssistantSeq = 0
      for (const event of surface.events || []) {
        if (event.type === 'user/message') {
          if (event.data?.source?.kind !== 'user') continue
          const text = extractText(event.data?.content).trim()
          if (!text) continue
          messages.push({ role: 'user', text, seq: Number(event.seq) || 0, time: Number(event.time) || 0 })
        } else if (event.type === 'assistant/message') {
          const text = extractText(event.data?.message?.content).trim()
          lastAssistantSeq = Math.max(lastAssistantSeq, Number(event.seq) || 0)
          if (!text) continue
          messages.push({ role: 'assistant', text, seq: Number(event.seq) || 0, time: Number(event.time) || 0 })
        }
      }
      const entry = {
        seq,
        messages: messages.slice(-MAX_MESSAGES),
        lastAssistantSeq,
        at: Date.now(),
      }
      runtime.surfaces.set(sessionId, entry)
      return entry
    }

    const aggregateActivity = () => {
      const ids = new Set([...runtime.statuses.keys(), ...runtime.events.keys()])
      let running = false
      let approval = false
      const unreadIds = []
      const items = []
      for (const id of ids) {
        const status = runtime.statuses.get(id)
        const event = runtime.events.get(id)
        const active = !!status || !!event?.running
        if (active) running = true
        if (status?.phase === 'approval') approval = true
        const seenAt = Number(state.seen[id]) || 0
        const unread = !!event?.doneAt && event.doneAt > seenAt
        if (unread) unreadIds.push(id)
        if (!active && !unread) continue
        if (active && event && !event.startedAt) event.startedAt = status?.since || Date.now()
        items.push({
          id,
          state: status?.phase === 'approval' ? 'approval' : active ? 'running' : 'done',
          startedAt: event?.startedAt || event?.doneAt || status?.since || 0,
        })
      }
      items.sort((left, right) => (left.startedAt || 0) - (right.startedAt || 0) || left.id.localeCompare(right.id))
      return {
        ok: true,
        running,
        approval,
        unreadIds,
        items,
        desktopSessionId: state.desktopSessionId,
        desktopSessionAt: state.desktopSessionAt,
      }
    }

    const snapshotFor = async (requestedSessionId) => {
      const sessionId = String(requestedSessionId || state.lastSessionId || '')
      if (!sessionId) {
        return { ok: true, session: null, messages: [], running: false, streaming: '', unread: false, lastAssistantSeq: 0, error: null }
      }
      const live = c.get('sessions')?.get?.(sessionId) || null
      if (!live) {
        try { await c.sessionQuery.readTitleSnapshot(sessionId) } catch {
          return { ok: false, code: 'SESSION_NOT_FOUND', error: '对话不存在或尚未持久化', sessionId }
        }
      }
      const [surface, title] = await Promise.all([surfaceFor(sessionId), titleFor(sessionId)])
      const activity = runtime.events.get(sessionId) || { running: false, doneAt: 0, error: null }
      const running = live ? live.status === 'running' : !!activity.running
      const stream = runtime.streams.get(sessionId)
      const status = runtime.statuses.get(sessionId)
      const active = running || !!status
      const streaming = active && stream && typeof stream.text === 'string' ? stream.text : ''
      const seenAt = Number(state.seen[sessionId]) || 0
      return {
        ok: true,
        session: { id: sessionId, title: title.title, workspaceId: null },
        status: status
          ? {
              phase: status.phase || 'thinking',
              label: status.label || '正在思考…',
              detail: status.detail || '',
              since: status.since || Date.now(),
            }
          : (running ? { phase: 'thinking', label: '正在思考…', detail: '', since: Date.now() } : null),
        messages: surface.messages,
        running: active,
        streaming,
        unread: !!activity.doneAt && activity.doneAt > seenAt,
        lastAssistantSeq: surface.lastAssistantSeq,
        error: activity.error || null,
      }
    }

    const balanceFallback = () => {
      const ledger = readJsonFile(join(DSH_HOME, '.dshw-usage.json'))
      if (ledger && Number.isFinite(Number(ledger.lastBalance))) {
        return {
          value: Number(ledger.lastBalance),
          currency: 'CNY',
          source: 'whale-ledger',
          stale: true,
          todayUsage: Number(ledger.todayUsage) || 0,
          updatedAt: Number(ledger.updatedAt) || null,
        }
      }
      return { value: null, currency: 'CNY', source: 'none', stale: true, todayUsage: null }
    }

    const fetchBalance = async (force = false) => {
      if (!force && runtime.balance && Date.now() - runtime.balance.at < BALANCE_TTL_MS) return runtime.balance
      let result = null
      try {
        const credentials = c.get('credentials')
        const credential = await credentials?.resolve?.('DEEPSEEK_API_KEY')
        if (credential?.value) {
          const response = await fetch(BALANCE_URL, {
            headers: { Authorization: `Bearer ${credential.value}` },
            signal: AbortSignal.timeout(8_000),
          })
          if (response.ok) {
            const document = await response.json()
            const infos = Array.isArray(document?.balance_infos) ? document.balance_infos : []
            const info = infos.find((item) => String(item?.currency || '').toUpperCase() === 'CNY') || infos[0]
            if (info && Number.isFinite(Number(info.total_balance))) {
              result = {
                value: Number(info.total_balance),
                currency: String(info.currency || 'CNY'),
                source: 'api',
                stale: false,
                todayUsage: null,
              }
            }
          }
        }
      } catch (error) {
        log('balance API failed:', displayError(error))
      }
      if (!result) {
        try {
          const account = c.get('deepseekAccount')
          if (account && typeof account.getBalance === 'function') {
            const payload = await account.getBalance({
              version: VERSION,
              locale: 'zh_CN',
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            })
            if (payload && payload.status === 'ready') {
              const wallets = [
                ...(Array.isArray(payload.value) ? payload.value : []),
                ...(Array.isArray(payload.bonusWallets) ? payload.bonusWallets : []),
              ].filter((wallet) => wallet && Number.isFinite(Number(wallet.balance)))
              if (wallets.length > 0) {
                const currency = String(wallets.find((wallet) => String(wallet.currency || 'CNY').toUpperCase() === 'CNY')?.currency || wallets[0].currency || 'CNY')
                const total = wallets
                  .filter((wallet) => String(wallet.currency || 'CNY').toUpperCase() === currency.toUpperCase())
                  .reduce((sum, wallet) => sum + Number(wallet.balance), 0)
                if (Number.isFinite(total)) {
                  result = {
                    value: Number(total.toFixed(6)),
                    currency,
                    source: 'account',
                    stale: false,
                    todayUsage: null,
                  }
                }
              }
            }
          }
        } catch (error) {
          log('account balance failed:', displayError(error))
        }
      }
      if (!result) result = balanceFallback()
      result.at = Date.now()
      runtime.balance = result
      return result
    }

    const queueMessage = async (body) => {
      const text = String(body?.text || '').trim()
      const supportedImages = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      const images = []
      const rawImages = Array.isArray(body?.images) ? body.images.slice(0, 4) : []
      for (const image of rawImages) {
        const mediaType = String(image?.mediaType || '')
        const data = String(image?.data || '')
        if (!supportedImages.has(mediaType) || !data) {
          throw Object.assign(new Error('不支持的图片格式'), { status: 400 })
        }
        if (data.length > 20_000_000) throw Object.assign(new Error('图片过大'), { status: 413 })
        const bytes = Buffer.from(data, 'base64')
        if (bytes.length === 0 || bytes.toString('base64') !== data) {
          throw Object.assign(new Error('图片数据无效'), { status: 400 })
        }
        images.push({
          type: 'image',
          mediaType,
          data,
          name: String(image?.name || '粘贴图片').slice(0, 120),
        })
      }
      if (!text && images.length === 0) throw Object.assign(new Error('消息不能为空'), { status: 400 })
      if (text.length > 32_000) throw Object.assign(new Error('消息过长'), { status: 413 })
      let sessionId = body?.sessionId ? String(body.sessionId) : ''
      let workspaceId = body?.workspaceId ? String(body.workspaceId) : null

      if (!sessionId) {
        const workspace = workspaceFor(body?.workspaceId)
        if (!workspace) throw Object.assign(new Error('还没有可用的工作区，请先在 DSH 中打开一个项目'), { status: 409 })
        workspaceId = String(workspace.id)
        const created = await c.sessionController.create({ workspaceId })
        sessionId = String(created.sessionId)
      }

      state.lastSessionId = sessionId
      state.seen[sessionId] = Date.now()
      saveStateSoon()
      runtime.surfaces.delete(sessionId)
      runtime.titles.delete(sessionId)
      runtime.streams.delete(sessionId)
      const activity = eventFor(sessionId)
      activity.running = true
      activity.active = true
      activity.doneAt = 0
      activity.startedAt = Date.now()
      activity.error = null
      setStatus(sessionId, 'thinking', '正在思考…')

      try {
        await c.sessionController.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [...(text ? [{ type: 'text', text }] : []), ...images],
        }, AbortSignal.timeout(30_000))
      } catch (error) {
        activity.running = false
        activity.active = false
        activity.error = displayError(error)
        throw error
      }
      return { sessionId, workspaceId }
    }

    const hideMainWindow = () => {
      const mainPid = Number(process.ppid)
      if (!Number.isSafeInteger(mainPid) || mainPid <= 0) return
      try {
        const hide = spawn(HELPER_EXE, ['--hide-main', String(mainPid)], {
          cwd: HELPER_DIR,
          windowsHide: true,
          detached: false,
          stdio: 'ignore',
        })
        hide.once('error', (error) => log('hide main failed:', displayError(error)))
      } catch (error) {
        log('hide main failed:', displayError(error))
      }
    }

    const openMiniWindow = () => {
      try {
        const show = spawn(HELPER_EXE, ['--toggle'], {
          cwd: HELPER_DIR,
          windowsHide: true,
          detached: false,
          stdio: 'ignore',
        })
        let handled = false
        const settle = (code) => {
          if (handled) return
          handled = true
          if (code === 0) {
            return
          }
          if (runtime.helperStopping) return
          startHelper()
        }
        show.once('error', (error) => {
          log('mini show failed:', displayError(error))
          settle(-1)
        })
        show.once('exit', settle)
      } catch (error) {
        log('mini window failed:', displayError(error))
      }
    }

    const resetMiniWindow = () => {
      try {
        const reset = spawn(HELPER_EXE, ['--reset'], {
          cwd: HELPER_DIR,
          windowsHide: true,
          detached: false,
          stdio: 'ignore',
        })
        reset.once('error', (error) => log('mini reset failed:', displayError(error)))
        reset.once('exit', (code) => {
          if (code === 2) startHelper()
        })
      } catch (error) {
        log('mini reset failed:', displayError(error))
      }
    }

    const handler = async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const pathname = url.pathname
      try {
        if (pathname === `${ROUTE_ROOT}/api/health`) {
          return sendJson(res, 200, { ok: true, version: VERSION, helper: !!runtime.helper })
        }
        // The Desktop shell calls this through its dsh-app protocol.  The
        // unguessable token is the authorization; the socket may be proxied.
        if (pathname === `${ROUTE_ROOT}/api/mini` && req.method === 'POST') {
          if (!tokenMatches(url.searchParams.get('token'))) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN' })
          openMiniWindow()
          return sendJson(res, 200, { ok: true })
        }
        if (pathname === `${ROUTE_ROOT}/api/mini/reset` && req.method === 'POST') {
          if (!tokenMatches(url.searchParams.get('token'))) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN' })
          resetMiniWindow()
          return sendJson(res, 200, { ok: true })
        }
        if (!authorized(req, url)) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'forbidden' })
        if (pathname === `${ROUTE_ROOT}/api/desktop-font`) {
          if (req.method === 'POST') {
            const body = await readBody(req)
            state.desktopFontScale = clampFontScale(body?.scale)
            saveStateSoon()
            log('desktop font scale ->', state.desktopFontScale)
            return sendJson(res, 200, { ok: true, scale: state.desktopFontScale })
          }
          return sendJson(res, 200, { ok: true, scale: state.desktopFontScale })
        }        if (pathname === `${ROUTE_ROOT}/api/session/pin` && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body?.sessionId || '')
          if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          if (body?.pinned) await c.workspaceRegistry.pinSession(sessionId)
          else await c.workspaceRegistry.unpinSession(sessionId)
          runtime.sessionsCache = null
          return sendJson(res, 200, { ok: true, pinned: !!body?.pinned })
        }
        if (pathname === `${ROUTE_ROOT}/api/session/archive` && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body?.sessionId || '')
          if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          await c.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
          runtime.sessionsCache = null
          return sendJson(res, 200, { ok: true })
        }
        if (pathname === `${ROUTE_ROOT}/api/meta`) {
          const [balance, sessions] = await Promise.all([fetchBalance(), listSessions()])
          return sendJson(res, 200, {
            ok: true,
            version: VERSION,
            product: 'DEEPSEEK HARNESS',
            features: { pin: true, archive: true },
            balance,
            workspaces: c.workspaceRegistry.list().map((workspace) => ({ id: String(workspace.id), title: workspace.title, path: workspace.path })),
            lastSessionId: state.lastSessionId,
            sessionCount: sessions.length,
          })
        }
        if (pathname === `${ROUTE_ROOT}/api/sessions`) {
          const sessions = await listSessions()
          return sendJson(res, 200, {
            ok: true,
            sessions,
            lastSessionId: state.lastSessionId,
            workspaces: c.workspaceRegistry.list().map((workspace) => ({ id: String(workspace.id), title: workspace.title, path: workspace.path })),
          })
        }
        if (pathname === `${ROUTE_ROOT}/api/snapshot`) {
          const snapshot = await snapshotFor(url.searchParams.get('sessionId'))
          return sendJson(res, snapshot.ok ? 200 : 404, snapshot)
        }
        if (pathname === `${ROUTE_ROOT}/api/activity`) {
          return sendJson(res, 200, aggregateActivity())
        }
        if (pathname === `${ROUTE_ROOT}/api/colors`) {
          const ids = String(url.searchParams.get('ids') || '').split(',').map((id) => id.trim()).filter(Boolean)
          const colors = {}
          if (ids.length > 0) {
            const workspaceBySession = new Map()
            for (const workspace of c.workspaceRegistry.list()) {
              for (const sessionId of workspace.sessionIds || []) {
                workspaceBySession.set(String(sessionId), String(workspace.id))
              }
            }
            for (const id of ids) colors[id] = colorForSession(id, workspaceBySession.get(id) || '')
          } else {
            for (const [id, color] of Object.entries(state.colors)) colors[id] = color
          }
          return sendJson(res, 200, { ok: true, colors })
        }
        if (pathname === `${ROUTE_ROOT}/api/send` && req.method === 'POST') {
          const body = await readBody(req)
          const result = await queueMessage(body)
          runtime.sessionsCache = null
          return sendJson(res, 200, { ok: true, ...result })
        }
        if (pathname === `${ROUTE_ROOT}/api/seen` && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body?.sessionId || '')
          if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          state.seen[sessionId] = Date.now()
          state.lastSessionId = sessionId
          const activity = runtime.events.get(sessionId)
          if (activity) activity.doneAt = 0
          saveStateSoon()
          return sendJson(res, 200, { ok: true })
        }
        if (pathname === `${ROUTE_ROOT}/api/desktop-session` && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body?.sessionId || '')
          if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          state.desktopSessionId = sessionId
          state.desktopSessionAt = Date.now()
          state.lastSessionId = sessionId
          state.seen[sessionId] = state.desktopSessionAt
          const activity = runtime.events.get(sessionId)
          if (activity) activity.doneAt = 0
          saveStateSoon()
          return sendJson(res, 200, { ok: true })
        }
        if (pathname === `${ROUTE_ROOT}/api/balance`) {
          return sendJson(res, 200, { ok: true, balance: await fetchBalance(true) })
        }
        if (pathname === `${ROUTE_ROOT}/api/workspaces`) {
          return sendJson(res, 200, {
            ok: true,
            workspaces: c.workspaceRegistry.list().map((workspace) => ({ id: String(workspace.id), title: workspace.title, path: workspace.path })),
          })
        }
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'not found' })
      } catch (error) {
        const status = Number(error?.status) || 500
        log('request failed:', pathname, displayError(error))
        return sendJson(res, status, { ok: false, code: status === 500 ? 'INTERNAL' : 'REQUEST', error: displayError(error) })
      }
    }

    const startHelper = () => {
      if (runtime.helperStopping) return
      if (!existsSync(HELPER_EXE)) {
        runtime.error = `companion executable missing: ${HELPER_EXE}`
        log(runtime.error)
        return
      }
      const overlayUrl = `${runtime.origin}${ROUTE_ROOT}/index.html?token=${encodeURIComponent(TOKEN)}`
      const args = ['--url', overlayUrl, '--parent-pid', String(process.pid)]
      const mainPid = Number(process.ppid)
      if (Number.isSafeInteger(mainPid) && mainPid > 0) args.push('--main-pid', String(mainPid))
      try {
        const child = spawn(HELPER_EXE, args, {
          cwd: HELPER_DIR,
          windowsHide: true,
          detached: false,
          stdio: 'ignore',
        })
        runtime.helper = child
        runtime.helperRestarts = 0
        log('companion started, pid', child.pid)
        child.once('error', (error) => {
          runtime.error = displayError(error)
          log('companion spawn failed:', error)
          runtime.helper = null
        })
        child.once('exit', (code, signal) => {
          if (runtime.helper === child) runtime.helper = null
          log('companion exited:', code, signal)
          if (code === 42) {
            runtime.helperRestarts = 0
            return
          }
          if (runtime.helperStopping) return
          if (runtime.helperRestarts >= 5) return
          runtime.helperRestarts += 1
          if (runtime.helperTimer) clearTimeout(runtime.helperTimer)
          runtime.helperTimer = setTimeout(startHelper, 2_000)
        })
      } catch (error) {
        runtime.error = displayError(error)
        log('companion launch failed:', error)
      }
    }

    c.effect(() => {
      runtime.origin = c.webServer.getOrigin()
      const disposers = []
      try {
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/health`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/meta`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/sessions`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/snapshot`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/activity`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/colors`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/send`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/seen`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/desktop-font`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/desktop-session`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/mini`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/session/pin`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/session/archive`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/balance`, handler }))
        disposers.push(c.webServer.register({ kind: 'exact', path: `${ROUTE_ROOT}/api/workspaces`, handler }))
        disposers.push(c.webServer.register({ kind: 'prefix', path: ROUTE_ROOT, handler: (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          if (url.pathname.startsWith(`${ROUTE_ROOT}/api/`)) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' })
          return serveAsset(req, res, url.pathname)
        } }))
        disposers.push(c.on('agent/status', (payload) => {
          const sessionId = agentSessionId(payload?.agent)
          if (!sessionId) return
          const activity = eventFor(sessionId)
          if (payload.status === 'running') {
            if (!activity.running || activity.doneAt) activity.startedAt = Date.now()
            activity.running = true
            activity.active = true
            activity.error = null
            if (!runtime.statuses.has(sessionId)) setStatus(sessionId, 'thinking', '正在思考…')
          } else {
            activity.running = false
            if (activity.active) {
              activity.active = false
              activity.doneAt = Date.now()
            }
            // Keep the phase visible through tool execution; turn/end clears it.
          }
          runtime.sessionsCache = null
        }))
        disposers.push(c.on('agent/assistant-stream', (payload) => {
          const sessionId = agentSessionId(payload?.agent)
          const frame = payload?.frame
          if (!sessionId || !frame) return
          if (frame.type === 'start') {
            runtime.streams.set(sessionId, { attemptId: String(frame.attemptId || ''), text: '', reasoning: '' })
            setStatus(sessionId, 'thinking', '正在思考…')
            return
          }
          if (frame.type === 'chunk') {
            const chunk = frame.chunk
            let stream = runtime.streams.get(sessionId)
            if (!stream) {
              stream = { attemptId: String(frame.attemptId || ''), text: '', reasoning: '' }
              runtime.streams.set(sessionId, stream)
            }
            if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              stream.reasoning = (stream.reasoning || '') + chunk.text
              setStatus(sessionId, 'thinking', '正在思考…', reasoningPreview(stream.reasoning))
              return
            }
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
              stream.text += chunk.text
              setStatus(sessionId, 'replying', '正在生成回复…')
              return
            }
            if (chunk?.type === 'tool-call-delta') {
              setStatus(sessionId, 'tool', '正在准备工具…')
              return
            }
            if (chunk?.type === 'finish') {
              setStatus(sessionId, 'replying', '正在整理回复…')
            }
            return
          }
          if (frame.type === 'end') {
            const stream = runtime.streams.get(sessionId)
            if (stream) stream.endedAt = Date.now()
          }
        }))
        disposers.push(c.on('agent/error', (payload) => {
          const sessionId = agentSessionId(payload?.agent)
          if (!sessionId) return
          const activity = eventFor(sessionId)
          activity.error = displayError(payload?.error)
          setStatus(sessionId, 'error', '生成失败')
        }))
        disposers.push(c.on('session/event', (session, event) => {
          const sessionId = String(session?.id || '')
          if (!sessionId || !event) return
          switch (event.type) {
            case 'turn/start':
            case 'step/start':
              if (event.type === 'turn/start') {
                runtime.streams.delete(sessionId)
                const activity = eventFor(sessionId)
                if (!activity.running || activity.doneAt) activity.startedAt = Date.now()
              }
              setStatus(sessionId, 'thinking', '正在思考…')
              break
            case 'tool/call': {
              const name = String(event.data?.name || '').trim()
              setStatus(sessionId, 'tool', name ? `正在调用 ${name}…` : '正在使用工具…')
              break
            }
            case 'tool/result':
              setStatus(sessionId, 'tool', '正在处理工具结果…')
              break
            case 'assistant/chunk': {
              const chunk = event.data?.chunk
              if (!chunk) break
              let stream = runtime.streams.get(sessionId)
              if (!stream) {
                stream = { attemptId: '', text: '', reasoning: '' }
                runtime.streams.set(sessionId, stream)
              }
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                stream.text += chunk.text
                setStatus(sessionId, 'replying', '正在生成回复…')
              } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                stream.reasoning += chunk.text
                setStatus(sessionId, 'thinking', '正在思考…', reasoningPreview(stream.reasoning))
              } else if (chunk.type === 'tool-call-delta') {
                setStatus(sessionId, 'tool', '正在准备工具…')
              }
              break
            }
            case 'assistant/message':
              setStatus(sessionId, 'replying', '正在整理回复…')
              break
            case 'llm/retry':
            case 'llm/retry-started':
              setStatus(sessionId, 'retry', '正在重试模型请求…')
              break
            case 'approval/asked':
              setStatus(sessionId, 'approval', '等待你的确认…')
              break
            case 'approval/decided':
              setStatus(sessionId, 'thinking', '继续处理…')
              break
            case 'compaction/start':
              setStatus(sessionId, 'compaction', '正在压缩上下文…')
              break
            case 'compaction/end':
              setStatus(sessionId, 'thinking', '正在继续…')
              break
            case 'turn/end':
              clearStatus(sessionId)
              break
            default:
              break
          }
        }))
        disposers.push(c.effect(() => {
          if (runtime.autoStart) startHelper()
          return () => {
            runtime.helperStopping = true
            if (runtime.helperTimer) clearTimeout(runtime.helperTimer)
            const child = runtime.helper
            runtime.helper = null
            if (child && child.exitCode === null) {
              try { child.kill() } catch {}
            }
          }
        }))
        log('routes registered on', runtime.origin)
      } catch (error) {
        runtime.error = displayError(error)
        log('route registration failed:', error)
      }
      return () => {
        for (const dispose of disposers.reverse()) {
          try { dispose() } catch {}
        }
      }
    })
  })
}

export const name = 'dsh-floating-input'
