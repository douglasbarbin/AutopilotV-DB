import { app, BrowserWindow, shell, nativeTheme, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { Channels } from '@shared/types/ipc'
import { join } from 'path'
import { existsSync } from 'fs'
import { fixPath } from './fixPath'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { log } from './log'
import { getDb, closeDb } from './db'
import * as store from './store'
import { registerIpc } from './ipc'
import { brain } from './brain/brain'
import { sessionManager } from './sessions/manager'
import { stopAll as stopLocalModels } from './localmodel/manager'
import { pushState } from './state'
import { initTray, destroyTray } from './tray'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let quitting = false

const openAbout = () => mainWindow?.webContents.send(Channels.evtOpenAbout)
const REPO_URL = 'https://github.com/JustinWoodring/AutopilotV'

/** Application menu with a custom "About" that opens our in-app dialog. */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'AutopilotV',
            submenu: [
              { label: 'About AutopilotV', click: openAbout },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'AutopilotV on GitHub', click: () => void shell.openExternal(REPO_URL) },
        ...(!isMac ? [{ label: 'About AutopilotV', click: openAbout }] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const iconPath = join(__dirname, '../../build/icon.png')
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'AutopilotV',
    backgroundColor: '#2d2d2d',
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setName('AutopilotV')

const ICON_PNG = join(__dirname, '../../build/icon.png')

app.whenReady().then(() => {
  log.info('AutopilotV starting', { version: app.getVersion() })
  fixPath() // import the user's real PATH so CLIs (gh, claude, pi, …) resolve
  // Tell the OS whether native chrome (window controls, scrollbars, menus) should
  // render light or dark, following the user's selected theme.
  nativeTheme.themeSource = store.getSettings().theme === 'tomorrow' ? 'light' : 'dark'
  app.setAboutPanelOptions({
    applicationName: 'AutopilotV',
    applicationVersion: app.getVersion(),
    ...(existsSync(ICON_PNG) ? { iconPath: ICON_PNG } : {})
  })
  // Show our icon (not Electron's) on the macOS dock in dev; packaged builds use the bundle icns.
  if (process.platform === 'darwin' && app.dock && existsSync(ICON_PNG)) {
    app.dock.setIcon(ICON_PNG)
  }
  getDb()
  store.seedIfEmpty()
  store.applyModelDefaults()
  store.normalizeReviewDefault()
  store.purgeEpicTasks()
  registerIpc()
  buildAppMenu()
  createWindow()

  // On Windows/Linux, closing the window hides it to the tray instead of quitting.
  if (process.platform !== 'darwin') {
    mainWindow?.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        mainWindow?.hide()
      }
    })
  }

  // Push fresh state once the renderer has loaded.
  mainWindow?.webContents.on('did-finish-load', () => pushState())

  // System tray (Windows/Linux — macOS already has the dock menu).
  if (process.platform !== 'darwin') {
    initTray()
  }

  // Smoke mode: boot, verify core wiring, then exit (used by CI / quick checks).
  if (process.env.AUTOPILOTV_SMOKE) {
    const harnesses = store.listHarnesses()
    const s = store.getSettings()
    log.info('SMOKE: boot ok', {
      harnesses: harnesses.length,
      reviewDefault: store.getReviewHarness()?.id ?? null,
      brain: `${s.llmProvider}:${s.llmModel}`,
      coder: store.getHarness('pi')?.localModel?.name ?? null
    })
    brain.reconcile()
    log.info('SMOKE: reconcile ok')
    setTimeout(() => app.exit(0), 200)
    return
  }

  // Brain starts running by default; it reconciles before its first tick.
  brain.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  log.info('graceful shutdown starting')
  brain.stop()
  // Release leases for any unfinished work owned by live sessions.
  store.reclaimExpiredLeases()
  await sessionManager.killAll('app_quit')
  stopLocalModels()
  destroyTray()
  closeDb()
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
