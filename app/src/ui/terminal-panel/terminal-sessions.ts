import { ITheme, Terminal as XTermTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import * as ipcRenderer from '../../lib/ipc-renderer'
import { getMonospaceFontFamily } from '../get-monospace-font-family'

const sessionsByPty = new Map<number, TerminalSession>()
let listening = false

function listen() {
  if (listening) {
    return
  }
  listening = true
  ipcRenderer.on('pty-data', (_, id, data) =>
    sessionsByPty.get(id)?.write(data)
  )
  ipcRenderer.on('pty-exit', (_, id, code) =>
    sessionsByPty.get(id)?.exited(code)
  )
}

/** xterm's colors taken from the app theme chosen in Appearance. */
function getTheme(): ITheme {
  const style = getComputedStyle(document.body)
  const get = (name: string) => style.getPropertyValue(name).trim()
  return {
    background: get('--background-color'),
    foreground: get('--text-color'),
    cursor: get('--text-color'),
    cursorAccent: get('--background-color'),
    selectionBackground: get('--box-selected-background-color'),
  }
}

/**
 * An interactive shell for one repository. Its element is moved between
 * containers so the scrollback outlives the panel being hidden.
 */
export class TerminalSession {
  public readonly element = document.createElement('div')
  private readonly term: XTermTerminal
  private readonly fit = new FitAddon()
  private ptyId: number | null = null
  private isOpen = false
  private isStarting = false
  private hasExited = false
  private queuedInput = ''

  public constructor(private readonly cwd: string) {
    this.element.className = 'terminal-session'
    this.term = new XTermTerminal({
      fontFamily: getMonospaceFontFamily(),
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
    })
    this.term.loadAddon(this.fit)
    this.term.onData(data => this.onInput(data))
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId !== null) {
        ipcRenderer.send('pty-resize', this.ptyId, cols, rows)
      }
    })
    listen()
  }

  /** Show the terminal in `container`, starting its shell the first time. */
  public attach(container: HTMLElement) {
    if (this.element.parentElement !== container) {
      container.appendChild(this.element)
    }
    this.term.options.theme = getTheme()
    if (!this.isOpen) {
      this.term.open(this.element)
      this.isOpen = true
    }
    this.layout()
    if (this.ptyId === null && !this.hasExited) {
      this.start()
    }
  }

  public detach() {
    this.element.remove()
  }

  /** Fit the terminal to its element's size. */
  public layout() {
    if (this.isOpen && this.element.offsetWidth > 0) {
      try {
        this.fit.fit()
      } catch (e) {
        log.warn('Failed to fit the terminal', e)
      }
    }
  }

  public focus() {
    this.term.focus()
  }

  public clear() {
    this.term.clear()
  }

  /** Run `text` in the shell as though it was typed and Enter pressed. */
  public run(text: string) {
    if (this.ptyId !== null) {
      ipcRenderer.send('pty-write', this.ptyId, `${text}\r`)
    } else {
      this.queuedInput += `${text}\r`
    }
  }

  public restart() {
    this.killPty()
    this.hasExited = false
    this.term.reset()
    this.start()
  }

  public dispose() {
    this.killPty()
    this.term.dispose()
    this.element.remove()
  }

  public write(data: string) {
    this.term.write(data)
  }

  public exited(code: number) {
    if (this.ptyId !== null) {
      sessionsByPty.delete(this.ptyId)
    }
    this.ptyId = null
    this.hasExited = true
    this.term.write(
      `\r\n\x1b[2m[Process exited with code ${code}. Press any key to restart.]\x1b[0m\r\n`
    )
  }

  private onInput(data: string) {
    if (this.hasExited) {
      this.restart()
    } else if (this.ptyId !== null) {
      ipcRenderer.send('pty-write', this.ptyId, data)
    }
  }

  private async start() {
    if (this.isStarting) {
      return
    }
    this.isStarting = true
    try {
      const id = await ipcRenderer.invoke(
        'pty-spawn',
        this.cwd,
        this.term.cols,
        this.term.rows
      )
      this.ptyId = id
      sessionsByPty.set(id, this)
      if (this.queuedInput.length > 0) {
        ipcRenderer.send('pty-write', id, this.queuedInput)
        this.queuedInput = ''
      }
    } catch (e) {
      log.error('Failed to start the terminal', e)
      this.hasExited = true
      this.term.write(
        `\x1b[31mCould not start a shell: ${
          e instanceof Error ? e.message : e
        }\x1b[0m\r\n`
      )
    } finally {
      this.isStarting = false
    }
  }

  private killPty() {
    if (this.ptyId !== null) {
      ipcRenderer.send('pty-kill', this.ptyId)
      sessionsByPty.delete(this.ptyId)
      this.ptyId = null
    }
  }
}

const sessions = new Map<string, TerminalSession>()

/** The terminal session of the repository at `path`, created on demand. */
export function getTerminalSession(path: string) {
  let session = sessions.get(path)
  if (session === undefined) {
    session = new TerminalSession(path)
    sessions.set(path, session)
  }
  return session
}

/** Run a command in the terminal of the repository at `path`. */
export function runInTerminal(path: string, command: string) {
  getTerminalSession(path).run(command)
}
