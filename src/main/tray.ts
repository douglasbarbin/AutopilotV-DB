import { Tray, Menu, app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { log } from './log'
import * as store from './store'
import { brain } from './brain/brain'
import { sessionManager } from './sessions/manager'
import { Channels } from '@shared/types/ipc'
import { pushState } from './state'

const __dirname = dirname(fileURLToPath(import.meta.url))

let tray: Tray | null = null

/** Resolve the best available tray icon for the current platform. */
function resolveTrayIcon(): string | null {
  // In packaged builds the icon lives inside the app bundle; in dev it's under build/.
  const candidates: string[] = [
    // Packaged: resources/ is where electron-builder copies buildResources/
    join(process.resourcesPath, 'build', 'icon.png'),
    // Dev: project root /build/
    join(__dirname, '../../build/icon.png'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Build the tray context menu. */
function buildTrayMenu(): Electron.Menu {
  const isBrainRunning = brain.state.running
  const activeSessions = store.countActiveSessions()

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Show',
      click: () => showWindow()
    },
    { type: 'separator' },
    {
      label: isBrainRunning ? '⏸  Pause Brain' : '▶  Start Brain',
      click: async () => {
        const next = !isBrainRunning
        brain.setRunning(next)
        pushState()
        updateTrayTooltip()
        log.info(`brain ${next ? 'started' : 'paused'} via tray`)
      }
    },
    {
      label: 'Tick Now',
      click: async () => {
        log.info('tick now via tray')
        await brain.tick()
        pushState()
      }
    },
    { type: 'separator' },
    {
      label: `${activeSessions} Active Session${activeSessions !== 1 ? 's' : ''}`,
      enabled: false
    },
    {
      label: `Brain ${isBrainRunning ? 'Running' : 'Paused'}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open Settings',
      click: () => {
        showWindow()
        // Signal renderer to navigate to Settings tab
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(Channels.evtTrayOpenSettings)
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ]

  return Menu.buildFromTemplate(template)
}

/** Update the tray tooltip with live status. */
function updateTrayTooltip(): void {
  if (!tray) return
  const isRunning = brain.state.running
  const sessions = store.countActiveSessions()
  const tick = brain.state.lastTickAt
    ? `Last tick: ${new Date(brain.state.lastTickAt).toLocaleTimeString()}`
    : 'No ticks yet'

  tray.setToolTip(
    `AutopilotV\nBrain: ${isRunning ? 'Running' : 'Paused'}\nActive sessions: ${sessions}\n${tick}`
  )
}

/** Show the main window (or create it if missing). */
function showWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) {
    // Main process should have created this during boot, but be defensive.
    log.warn('showWindow: no windows exist — cannot show')
    return
  }
  const win = windows[0]
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Initialise the system-tray icon.
 * Call this once during app boot after the main window is created.
 */
export function initTray(): void {
  const iconPath = resolveTrayIcon()
  if (!iconPath) {
    log.warn('tray icon not found — tray disabled')
    return
  }

  tray = new Tray(iconPath)
  tray.setToolTip('AutopilotV — Agent Orchestrator')
  tray.setContextMenu(buildTrayMenu())

  // Click on tray → show window
  tray.on('click', () => showWindow())

  // Keep tooltip and menu in sync with brain state.
  // brain emits 'changed' on every state transition.
  brain.on('changed', () => {
    updateTrayTooltip()
    tray?.setContextMenu(buildTrayMenu())
  })

  // Also update when session counts change.
  sessionManager.on('status', () => {
    updateTrayTooltip()
    tray?.setContextMenu(buildTrayMenu())
  })

  // Follow native theme for the tray icon appearance (some platforms support this).
  nativeTheme.on('updated', () => {
    // Re-init icon if needed (mainly for platforms that distinguish dark/light tray icons).
    updateTrayTooltip()
  })

  log.info('tray initialised')
}

/** Destroy the tray (cleanup on quit). */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
