import * as Path from 'path'
import type { IPty } from 'node-pty'
import { WebContents } from 'electron'
import * as ipcMain from './ipc-main'
import * as ipcWebContents from './ipc-webcontents'

interface IPtySession {
  readonly pty: IPty
  readonly owner: WebContents
  pending: string
  flushTimer: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<number, IPtySession>()
const watchedOwners = new WeakSet<WebContents>()
let nextId = 1

function getShell(): { file: string; args: string[] } {
  if (__WIN32__) {
    return { file: process.env.COMSPEC || 'cmd.exe', args: [] }
  }
  const file = process.env.SHELL || (__DARWIN__ ? '/bin/zsh' : '/bin/bash')
  // Apps started from the Dock or Finder don't get the user's PATH, which
  // a login shell picks up from the profile files.
  const name = Path.basename(file)
  const supportsLogin = ['zsh', 'bash', 'fish', 'sh', 'ksh'].includes(name)
  return { file, args: supportsLogin ? ['-l'] : [] }
}

function getEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('ELECTRON_')) {
      env[key] = value
    }
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'GitHubDesktop'
  return env
}

function flush(id: number) {
  const session = sessions.get(id)
  if (session === undefined) {
    return
  }
  session.flushTimer = null
  if (session.pending.length > 0 && !session.owner.isDestroyed()) {
    ipcWebContents.send(session.owner, 'pty-data', id, session.pending)
  }
  session.pending = ''
}

function kill(id: number) {
  const session = sessions.get(id)
  if (session === undefined) {
    return
  }
  sessions.delete(id)
  if (session.flushTimer !== null) {
    clearTimeout(session.flushTimer)
  }
  try {
    session.pty.kill()
  } catch (e) {
    log.warn(`Failed to kill terminal session ${id}`, e)
  }
}

function watchOwner(owner: WebContents) {
  if (watchedOwners.has(owner)) {
    return
  }
  watchedOwners.add(owner)
  owner.once('destroyed', () => {
    for (const [id, session] of sessions) {
      if (session.owner === owner) {
        kill(id)
      }
    }
  })
}

/** Serve the renderer's integrated terminal with shells running in a pty. */
export function registerPtyHost() {
  ipcMain.handle('pty-spawn', async (event, cwd, cols, rows) => {
    // Loaded lazily so a broken native module only disables the terminal.
    const nodePty: typeof import('node-pty') = require('node-pty')
    const { file, args } = getShell()
    const pty = nodePty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      cwd,
      env: getEnv(),
    })
    const id = nextId++
    const owner = event.sender
    const session: IPtySession = { pty, owner, pending: '', flushTimer: null }
    sessions.set(id, session)
    watchOwner(owner)

    // Coalesce bursts of output into fewer IPC messages.
    pty.onData(data => {
      session.pending += data
      if (session.flushTimer === null) {
        session.flushTimer = setTimeout(() => flush(id), 5)
      }
    })
    pty.onExit(({ exitCode }) => {
      flush(id)
      sessions.delete(id)
      if (!owner.isDestroyed()) {
        ipcWebContents.send(owner, 'pty-exit', id, exitCode)
      }
    })
    return id
  })

  ipcMain.on('pty-write', (_, id, data) => sessions.get(id)?.pty.write(data))

  ipcMain.on('pty-resize', (_, id, cols, rows) => {
    try {
      sessions.get(id)?.pty.resize(Math.max(cols, 2), Math.max(rows, 1))
    } catch (e) {
      log.warn(`Failed to resize terminal session ${id}`, e)
    }
  })

  ipcMain.on('pty-kill', (_, id) => kill(id))
}

/** Stop every running shell, e.g. when the app quits. */
export function killAllPtySessions() {
  for (const id of [...sessions.keys()]) {
    kill(id)
  }
}
