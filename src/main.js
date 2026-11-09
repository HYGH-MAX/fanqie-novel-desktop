'use strict'

/**
 * 番茄小说电脑版
 *
 * 结构：一个无边框主窗口（自绘标题栏）+ 一个 WebContentsView 承载番茄小说官网。
 * 内容、登录、书架、进度全部来自 fanqienovel.com，本程序只提供桌面外壳能力。
 */

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  Tray,
  Menu,
  shell,
  dialog,
  nativeImage,
  screen
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const HOME_URL = 'https://fanqienovel.com/'
const SITE_URL_RE = /^https?:\/\/([a-z0-9-]+\.)*fanqienovel\.com(:443|:80)?(\/|$)/i
const NOVEL_URL_RE = /fanqienovel\.com\/(page|reader|book)\//i

const TITLEBAR_HEIGHT = 40
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 860
const MIN_WIDTH = 960
const MIN_HEIGHT = 600
const RECENT_LIMIT = 12

/* ---------------------------------------------------------------- 路径与配置 */

function exeDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error('[store] 写入失败：', file, err.message)
  }
}

// exe 同级目录的 config.json 只用于指定数据目录（便携版用户最常改的一项）
const portableConfig = readJson(path.join(exeDir(), 'config.json'), {}) || {}
if (typeof portableConfig.dataDir === 'string' && portableConfig.dataDir.trim()) {
  try {
    const dir = path.resolve(portableConfig.dataDir.trim())
    fs.mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  } catch (err) {
    console.error('[config] dataDir 不可用，回退默认目录：', err.message)
  }
}

app.setName('fanqie-novel-desktop')

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const recentFile = () => path.join(app.getPath('userData'), 'recent.json')
const boundsFile = () => path.join(app.getPath('userData'), 'window-state.json')

const DEFAULT_SETTINGS = {
  zoomFactor: 1,
  eyeCare: false,
  alwaysOnTop: false,
  closeToTray: false,
  autoLaunch: false,
  startUrl: HOME_URL,
  lastUrl: HOME_URL
}

let settings = { ...DEFAULT_SETTINGS, ...(readJson(settingsFile(), {}) || {}) }
if (!SITE_URL_RE.test(settings.lastUrl)) settings.lastUrl = HOME_URL
if (!SITE_URL_RE.test(settings.startUrl)) settings.startUrl = HOME_URL

const saveSettings = () => writeJson(settingsFile(), settings)

let recent = readJson(recentFile(), [])
if (!Array.isArray(recent)) recent = []
const saveRecent = () => writeJson(recentFile(), recent)

/* ---------------------------------------------------------------- 运行状态 */

let mainWindow = null
let siteView = null
let tray = null
let settingsWindow = null
let recentWindow = null
let isQuitting = false
let eyeCareCssKey = null

/* ---------------------------------------------------------------- 窗口尺寸记忆 */

function defaultBounds() {
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
}

function loadBounds() {
  const saved = readJson(boundsFile(), null)
  const bounds = defaultBounds()
  if (!saved || typeof saved !== 'object') return bounds

  for (const key of ['x', 'y', 'width', 'height']) {
    if (Number.isFinite(saved[key])) bounds[key] = Math.round(saved[key])
  }
  bounds.width = Math.max(MIN_WIDTH, bounds.width)
  bounds.height = Math.max(MIN_HEIGHT, bounds.height)

  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return (
        bounds.x + 120 > area.x &&
        bounds.y + 40 > area.y &&
        bounds.x < area.x + area.width - 80 &&
        bounds.y < area.y + area.height - 40
      )
    })
    if (!visible) {
      delete bounds.x
      delete bounds.y
    }
  }
  return bounds
}

let saveTimer = null
function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return
  writeJson(boundsFile(), mainWindow.getNormalBounds())
}

function scheduleSaveBounds() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveBounds, 400)
}

/* ---------------------------------------------------------------- 状态广播 */

function currentState() {
  return {
    pinned: mainWindow ? mainWindow.isAlwaysOnTop() : settings.alwaysOnTop,
    maximized: mainWindow ? mainWindow.isMaximized() : false,
    fullscreen: mainWindow ? mainWindow.isFullScreen() : false,
    eyeCare: settings.eyeCare,
    zoomFactor: settings.zoomFactor,
    closeToTray: settings.closeToTray,
    autoLaunch: settings.autoLaunch,
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
    recentCount: recent.length
  }
}

function broadcast() {
  const state = currentState()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('fq:state', state)
  }
}

/* ---------------------------------------------------------------- 布局 */

function layoutSiteView() {
  if (!mainWindow || !siteView) return
  const [width, height] = mainWindow.getContentSize()
  const top = mainWindow.isFullScreen() ? 0 : TITLEBAR_HEIGHT
  siteView.setBounds({
    x: 0,
    y: top,
    width: Math.max(0, width),
    height: Math.max(0, height - top)
  })
}

/* ---------------------------------------------------------------- 护眼模式 */

function applyEyeCare() {
  if (!siteView) return
  const contents = siteView.webContents
  if (settings.eyeCare) {
    if (eyeCareCssKey == null) {
      contents
        .insertCSS('html { filter: sepia(0.26) saturate(0.94) brightness(0.96) !important; }')
        .then((key) => {
          eyeCareCssKey = key
        })
        .catch(() => {})
    }
  } else if (eyeCareCssKey != null) {
    contents.removeInsertedCSS(eyeCareCssKey).catch(() => {})
    eyeCareCssKey = null
  }
}

function applyZoom() {
  if (!siteView) return
  siteView.webContents.setZoomFactor(settings.zoomFactor)
}

/* ---------------------------------------------------------------- 最近阅读 */

function recordRecent(url, title) {
  if (!url || !NOVEL_URL_RE.test(url)) return
  const cleanTitle = (title || '').replace(/\s*-\s*番茄小说.*$/, '').trim()
  if (!cleanTitle) return
  recent = recent.filter((item) => item.url !== url)
  recent.unshift({ url, title: cleanTitle, at: Date.now() })
  recent = recent.slice(0, RECENT_LIMIT)
  saveRecent()
}

/* ---------------------------------------------------------------- 主窗口 */

function createMainWindow() {
  const bounds = loadBounds()

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    show: false,
    backgroundColor: '#ffffff',
    title: '番茄小说',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop)

  mainWindow.loadFile(path.join(__dirname, 'shell.html'))

  siteView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  mainWindow.contentView.addChildView(siteView)

  // 去掉 UA 里的 Electron 标识，避免个别页面按 Electron 走兼容分支
  const ua = siteView.webContents.getUserAgent().replace(/Electron\/\S+\s*/, '')
  siteView.webContents.setUserAgent(ua)

  siteView.webContents.loadURL(
    NOVEL_URL_RE.test(settings.lastUrl) ? settings.lastUrl : settings.startUrl || HOME_URL
  )

  siteView.webContents.on('did-finish-load', () => {
    applyZoom()
    applyEyeCare()
    broadcast()
  })

  siteView.webContents.on('page-title-updated', (_event, title) => {
    recordRecent(siteView.webContents.getURL(), title)
  })

  siteView.webContents.on('did-navigate', (_event, url) => {
    if (!SITE_URL_RE.test(url)) return
    // 只在书籍 / 阅读页记住进度，登录页、活动页不记，避免下次打开落到登录界面
    if (NOVEL_URL_RE.test(url)) {
      settings.lastUrl = url
      saveSettings()
    }
    recordRecent(url, '')
  })

  siteView.webContents.setWindowOpenHandler(({ url }) => {
    if (SITE_URL_RE.test(url)) {
      siteView.webContents.loadURL(url)
      focusMain()
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  siteView.webContents.on('will-navigate', (event, url) => {
    if (!SITE_URL_RE.test(url) && /^https?:/i.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  siteView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    showOfflinePage(errorDescription || '无法加载页面', validatedURL)
  })

  bindShortcuts(siteView.webContents)

  mainWindow.once('ready-to-show', () => {
    layoutSiteView()
    mainWindow.show()
  })

  mainWindow.on('resize', () => {
    layoutSiteView()
    scheduleSaveBounds()
    broadcast()
  })
  mainWindow.on('move', scheduleSaveBounds)
  mainWindow.on('maximize', broadcast)
  mainWindow.on('unmaximize', broadcast)
  mainWindow.on('enter-full-screen', () => {
    layoutSiteView()
    broadcast()
  })
  mainWindow.on('leave-full-screen', () => {
    layoutSiteView()
    broadcast()
  })

  mainWindow.on('close', (event) => {
    saveBounds()
    if (!isQuitting && settings.closeToTray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    siteView = null
  })

  layoutSiteView()
  broadcast()
}

function focusMain() {
  if (!mainWindow) {
    createMainWindow()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  if (mainWindow.isAlwaysOnTop()) mainWindow.moveTop()
}

function showOfflinePage(reason, url) {
  if (!siteView || siteView.webContents.isDestroyed()) return
  const safe = (value) => String(value || '').replace(/[<>&"]/g, '')
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;font-family:"Microsoft YaHei",system-ui,sans-serif;background:#fff7f2;color:#3a2418}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px}
  .emoji{font-size:56px}
  h1{font-size:20px;margin:0}
  p{max-width:640px;line-height:1.7;color:#7a5745;margin:0;font-size:14px;word-break:break-all}
  button{margin-top:8px;border:0;border-radius:10px;padding:10px 24px;font-size:14px;background:#ff5a1f;color:#fff;cursor:pointer}
</style>
<div class="wrap">
  <div class="emoji">🍅</div>
  <h1>页面暂时打不开</h1>
  <p>${safe(reason)}</p>
  <p>${safe(url)}</p>
  <p>请检查网络或代理设置后重试。</p>
  <button onclick="location.replace('${HOME_URL}')">重新加载</button>
</div>`
  siteView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

/* ---------------------------------------------------------------- 快捷键 */

async function togglePin() {
  if (!mainWindow) return false
  const next = !mainWindow.isAlwaysOnTop()
  mainWindow.setAlwaysOnTop(next)
  if (next) mainWindow.moveTop()
  settings.alwaysOnTop = next
  saveSettings()
  refreshTrayMenu()
  broadcast()
  return next
}

function toggleFullscreen() {
  if (!mainWindow) return
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
}

function bindShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key
    const ctrl = input.control || input.meta
    const shift = input.shift
    const alt = input.alt

    if (key === 'F11') {
      event.preventDefault()
      toggleFullscreen()
      return
    }
    if (key === 'Escape' && mainWindow && mainWindow.isFullScreen()) {
      event.preventDefault()
      mainWindow.setFullScreen(false)
      return
    }
    if (ctrl && shift && key.toLowerCase() === 'p') {
      event.preventDefault()
      togglePin()
      return
    }
    if (ctrl && ['0', '=', '+', '-', '_'].includes(key)) {
      event.preventDefault()
      const step = key === '-' || key === '_' ? -0.1 : 0.1
      const next = key === '0' ? 1 : settings.zoomFactor + step
      settings.zoomFactor = Math.min(2, Math.max(0.5, Number(next.toFixed(2))))
      saveSettings()
      applyZoom()
      broadcast()
      return
    }
    if (key === 'F5' || (ctrl && key.toLowerCase() === 'r')) {
      event.preventDefault()
      contents.reload()
      return
    }
    if (alt && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      event.preventDefault()
      if (key === 'ArrowLeft') {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      } else if (contents.navigationHistory.canGoForward()) {
        contents.navigationHistory.goForward()
      }
    }
  })
}

/* ---------------------------------------------------------------- 子窗口 */

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    parent: mainWindow || undefined,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'))
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

function createRecentWindow() {
  if (recentWindow && !recentWindow.isDestroyed()) {
    recentWindow.show()
    recentWindow.focus()
    recentWindow.webContents.send('fq:recent', recent)
    return
  }
  recentWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    parent: mainWindow || undefined,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  recentWindow.loadFile(path.join(__dirname, 'recent.html'))
  recentWindow.once('ready-to-show', () => {
    recentWindow.show()
    recentWindow.webContents.send('fq:recent', recent)
  })
  recentWindow.on('closed', () => {
    recentWindow = null
  })
}

/* ---------------------------------------------------------------- 托盘 */

function refreshTrayMenu() {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: focusMain },
      { label: '最近阅读', click: createRecentWindow },
      { label: '设置', click: createSettingsWindow },
      { type: 'separator' },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: !!(mainWindow && mainWindow.isAlwaysOnTop()),
        click: togglePin
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('番茄小说 电脑版')
  tray.on('click', focusMain)
  refreshTrayMenu()
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('app:state', () => currentState())
  ipcMain.handle('app:settings', () => ({ ...settings, dataDir: app.getPath('userData') }))
  ipcMain.handle('app:recent', () => recent)

  ipcMain.handle('win:pin', () => togglePin())
  ipcMain.handle('win:fullscreen', () => {
    toggleFullscreen()
    return currentState()
  })
  ipcMain.handle('win:toggle-max', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })
  ipcMain.on('win:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
  })

  ipcMain.on('win:settings', () => createSettingsWindow())
  ipcMain.on('win:recent', () => createRecentWindow())

  ipcMain.handle('recent:open', (_event, url) => {
    if (!SITE_URL_RE.test(String(url || ''))) return false
    if (siteView && !siteView.webContents.isDestroyed()) {
      siteView.webContents.loadURL(url)
      focusMain()
      if (recentWindow && !recentWindow.isDestroyed()) recentWindow.close()
      return true
    }
    return false
  })

  ipcMain.handle('settings:set', (event, key, value) => {
    if (!(key in DEFAULT_SETTINGS)) return currentState()
    if (key === 'zoomFactor') {
      const num = Number(value)
      settings.zoomFactor = Math.min(2, Math.max(0.5, Number.isFinite(num) ? num : 1))
      saveSettings()
      applyZoom()
    } else if (key === 'eyeCare') {
      settings.eyeCare = !!value
      saveSettings()
      applyEyeCare()
    } else if (key === 'alwaysOnTop') {
      settings.alwaysOnTop = !!value
      saveSettings()
      if (mainWindow) mainWindow.setAlwaysOnTop(settings.alwaysOnTop)
      refreshTrayMenu()
    } else if (key === 'closeToTray') {
      settings.closeToTray = !!value
      saveSettings()
    } else if (key === 'autoLaunch') {
      settings.autoLaunch = !!value
      saveSettings()
      applyAutoLaunch()
    } else {
      return currentState()
    }
    broadcast()
    return currentState()
  })

  ipcMain.on('app:open-data-dir', () => {
    shell.openPath(app.getPath('userData'))
  })

  ipcMain.handle('app:choose-data-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined
    const result = await dialog.showOpenDialog(win, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { changed: false }
    const dir = result.filePaths[0]
    writePortableConfig(dir)
    return { changed: true, dir }
  })

  ipcMain.on('app:restart', () => {
    app.relaunch()
    isQuitting = true
    app.quit()
  })
}

function writePortableConfig(dataDir) {
  const file = path.join(exeDir(), 'config.json')
  const current = readJson(file, {}) || {}
  current.dataDir = dataDir
  writeJson(file, current)
}

function applyAutoLaunch() {
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.autoLaunch,
      path: process.execPath,
      args: []
    })
  } catch (err) {
    console.error('[autoLaunch] 设置失败：', err.message)
  }
}

/* ---------------------------------------------------------------- 生命周期 */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', focusMain)

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerIpc()
    createMainWindow()
    createTray()
    applyAutoLaunch()

    // 首次启动时把开机自启的真实状态同步回来
    try {
      const info = app.getLoginItemSettings({ path: process.execPath, args: [] })
      if (settings.autoLaunch !== info.openAtLogin) {
        settings.autoLaunch = info.openAtLogin
        saveSettings()
      }
    } catch {}
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
