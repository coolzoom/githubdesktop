import * as Path from 'path'
import { promises as Fs, watch, FSWatcher } from 'fs'
import { Emitter, Disposable } from 'event-kit'
import type * as MonacoApi from 'monaco-editor'
import { Repository } from '../../models/repository'
import { getIndexFileContents } from '../../lib/git/index-file'
import { loadMonaco } from './monaco'

/** Files bigger than this are opened in the external editor instead. */
const MaxFileSize = 10 * 1024 * 1024

export type EditorView = 'edit' | 'changes'

export interface IEditorTab {
  /** Relative to the repository root */
  readonly path: string
  /** A preview tab is replaced by the next file opened from the explorer */
  readonly isPreview: boolean
  readonly view: EditorView
}

/** Why a file can't be shown as text. */
export type UnsupportedReason = 'binary' | 'too-large' | 'unreadable'

function isBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, 8000)
  return sample.includes(0)
}

/**
 * A file open in the editor: its Monaco model plus what's needed to tell
 * whether it has unsaved changes or was changed on disk meanwhile.
 */
export class EditorDocument {
  public model: MonacoApi.editor.ITextModel | null = null
  public unsupported: UnsupportedReason | null = null
  /** The text last read from or written to disk */
  public diskText: string | null = null
  /** The file changed on disk while there were unsaved changes */
  public hasConflict = false
  public isDeleted = false
  /** The staged version the git change markers compare against */
  public indexText: string | null = null
  public viewState: MonacoApi.editor.ICodeEditorViewState | null = null
  public readonly ready: Promise<void>

  private savedVersionId = 0
  private watcher: FSWatcher | null = null
  private checkTimer: number | null = null
  private references = 0
  private reportedDirty = false

  public constructor(
    private readonly owner: RepositoryEditors,
    public readonly path: string
  ) {
    this.ready = this.load()
  }

  public get fullPath() {
    return Path.join(this.owner.repository.path, this.path)
  }

  public get isDirty() {
    return (
      this.model !== null &&
      this.model.getAlternativeVersionId() !== this.savedVersionId
    )
  }

  private changed() {
    this.reportedDirty = this.isDirty
    this.owner.emitDocumentChanged(this)
  }

  public retain() {
    this.references++
  }

  /** Returns whether nothing uses the document anymore. */
  public release() {
    this.references = Math.max(0, this.references - 1)
    return this.references === 0
  }

  private async load() {
    let buffer: Buffer
    try {
      const stats = await Fs.stat(this.fullPath)
      if (stats.size > MaxFileSize) {
        this.unsupported = 'too-large'
        return
      }
      buffer = await Fs.readFile(this.fullPath)
    } catch (e) {
      log.warn(`Failed to open ${this.fullPath} in the editor`, e)
      this.unsupported = 'unreadable'
      return
    }
    if (isBinary(buffer)) {
      this.unsupported = 'binary'
      return
    }

    const monaco = await loadMonaco()
    const text = buffer.toString('utf8')
    const uri = monaco.Uri.file(this.fullPath)
    monaco.editor.getModel(uri)?.dispose()
    this.model = monaco.editor.createModel(text, undefined, uri)
    this.diskText = text
    this.markSaved()
    this.model.onDidChangeContent(() => {
      if (this.isDirty !== this.reportedDirty) {
        this.changed()
      }
    })
    await this.loadIndexText()
    this.watch()
    this.changed()
  }

  public async loadIndexText() {
    try {
      const contents = await getIndexFileContents(
        this.owner.repository,
        this.path
      )
      const indexText = contents === null ? null : contents.toString('utf8')
      if (indexText !== this.indexText) {
        this.indexText = indexText
        this.changed()
      }
    } catch (e) {
      log.warn(`Failed to read the index version of ${this.path}`, e)
    }
  }

  private markSaved() {
    if (this.model !== null) {
      this.savedVersionId = this.model.getAlternativeVersionId()
    }
  }

  private watch() {
    try {
      this.watcher = watch(this.fullPath, () => this.scheduleDiskCheck())
      this.watcher.on('error', () => this.scheduleDiskCheck())
    } catch (e) {
      log.warn(`Failed to watch ${this.fullPath}`, e)
    }
  }

  public scheduleDiskCheck() {
    if (this.checkTimer !== null) {
      window.clearTimeout(this.checkTimer)
    }
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = null
      this.checkDisk()
    }, 150)
  }

  /**
   * Pick up changes made outside the editor: reload a file without unsaved
   * changes, and flag a conflict for one with unsaved changes.
   */
  public async checkDisk() {
    const model = this.model
    if (model === null || model.isDisposed()) {
      return
    }
    let text: string | null
    try {
      text = (await Fs.readFile(this.fullPath)).toString('utf8')
    } catch {
      text = null
    }

    if (text === null) {
      if (!this.isDeleted) {
        this.isDeleted = true
        this.changed()
      }
      return
    }
    // Editors that save by replacing the file break the watcher.
    if (this.isDeleted || this.watcher === null) {
      this.watcher?.close()
      this.watch()
    }
    if (text === this.diskText) {
      if (this.isDeleted) {
        this.isDeleted = false
        this.changed()
      }
      return
    }
    this.isDeleted = false
    if (!this.isDirty) {
      this.replaceText(text)
      this.diskText = text
      this.markSaved()
      this.hasConflict = false
    } else {
      this.hasConflict = true
    }
    this.changed()
  }

  /** Replace the contents as one undoable edit. */
  private replaceText(text: string) {
    const model = this.model
    if (model === null || model.getValue() === text) {
      return
    }
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text }],
      () => null
    )
  }

  /** Throw away the unsaved changes in favor of what's on disk. */
  public async revertToDisk() {
    const text = await Fs.readFile(this.fullPath, 'utf8')
    this.replaceText(text)
    this.diskText = text
    this.markSaved()
    this.hasConflict = false
    this.isDeleted = false
    this.changed()
  }

  /** Keep the unsaved changes; the next save overwrites the disk version. */
  public keepMine() {
    this.hasConflict = false
    this.changed()
  }

  public async save() {
    const model = this.model
    if (model === null) {
      return
    }
    if (this.hasConflict) {
      const overwrite = window.confirm(
        `"${Path.basename(
          this.path
        )}" was changed on disk. Overwrite it with your version?`
      )
      if (!overwrite) {
        return
      }
    }
    const text = model.getValue()
    const versionId = model.getAlternativeVersionId()
    try {
      await Fs.mkdir(Path.dirname(this.fullPath), { recursive: true })
      await Fs.writeFile(this.fullPath, text)
    } catch (e) {
      this.owner.emitError(e instanceof Error ? e : new Error(`${e}`))
      return
    }
    this.diskText = text
    this.savedVersionId = versionId
    this.hasConflict = false
    this.isDeleted = false
    this.changed()
    this.owner.emitSaved(this)
  }

  public dispose() {
    this.watcher?.close()
    this.watcher = null
    if (this.checkTimer !== null) {
      window.clearTimeout(this.checkTimer)
    }
    this.model?.dispose()
    this.model = null
  }
}

/** The open tabs and documents of one repository. */
export class RepositoryEditors {
  private readonly emitter = new Emitter()
  private readonly documents = new Map<string, EditorDocument>()
  private _tabs: ReadonlyArray<IEditorTab> = []
  /** The active tab's path, or null while the graph is shown */
  private _activePath: string | null = null

  public constructor(public readonly repository: Repository) {}

  public get tabs() {
    return this._tabs
  }

  public get activePath() {
    return this._activePath
  }

  public get activeTab() {
    return this._tabs.find(t => t.path === this._activePath) ?? null
  }

  public onDidChange(fn: () => void): Disposable {
    return this.emitter.on('change', fn)
  }

  public onDidSave(fn: (document: EditorDocument) => void): Disposable {
    return this.emitter.on('save', fn)
  }

  public emitDocumentChanged(_document: EditorDocument) {
    this.emitter.emit('change')
  }

  public emitSaved(document: EditorDocument) {
    this.emitter.emit('save', document)
  }

  public onDidError(fn: (error: Error) => void): Disposable {
    return this.emitter.on('error', fn)
  }

  public emitError(error: Error) {
    this.emitter.emit('error', error)
  }

  private changed() {
    this.emitter.emit('change')
  }

  /** The document of a file, loading it on first use. */
  public acquire(path: string) {
    let document = this.documents.get(path)
    if (document === undefined) {
      document = new EditorDocument(this, path)
      this.documents.set(path, document)
    }
    document.retain()
    return document
  }

  public release(document: EditorDocument) {
    if (document.release() && this.documents.get(document.path) === document) {
      this.documents.delete(document.path)
      document.dispose()
    }
  }

  public getDocument(path: string) {
    return this.documents.get(path) ?? null
  }

  public get dirtyDocuments() {
    return [...this.documents.values()].filter(d => d.isDirty)
  }

  /**
   * Show a file in a tab like VS Code: a preview tab that the next file
   * replaces unless `pin` is set.
   */
  public open(
    path: string,
    options: { pin?: boolean; initialView?: EditorView } = {}
  ) {
    const existing = this._tabs.find(t => t.path === path)
    const view = existing?.view ?? options.initialView ?? 'edit'
    if (existing !== undefined) {
      this._tabs = this._tabs.map(t =>
        t.path === path ? { ...t, isPreview: t.isPreview && !options.pin } : t
      )
    } else {
      const tab: IEditorTab = { path, view, isPreview: !options.pin }
      const preview = this._tabs.find(
        t => t.isPreview && !this.getDocument(t.path)?.isDirty
      )
      if (preview !== undefined && tab.isPreview) {
        this.releaseTab(preview.path)
        this._tabs = this._tabs.map(t => (t === preview ? tab : t))
      } else {
        this._tabs = [...this._tabs, tab]
      }
      this.acquire(path)
    }
    this._activePath = path
    this.changed()
  }

  public pin(path: string) {
    this._tabs = this._tabs.map(t =>
      t.path === path ? { ...t, isPreview: false } : t
    )
    this.changed()
  }

  public setView(path: string, view: EditorView) {
    this._tabs = this._tabs.map(t => (t.path === path ? { ...t, view } : t))
    this.changed()
  }

  /** Show the graph, or the tab of `path`. */
  public activate(path: string | null) {
    this._activePath = path
    this.changed()
  }

  private releaseTab(path: string) {
    const document = this.documents.get(path)
    if (document !== undefined) {
      this.release(document)
    }
  }

  /** Close tabs, asking before unsaved changes are thrown away. */
  public close(paths: ReadonlyArray<string>) {
    const dirty = paths
      .map(p => this.getDocument(p))
      .filter((d): d is EditorDocument => d !== null && d.isDirty)
    if (dirty.length > 0) {
      const names = dirty.map(d => Path.basename(d.path)).join(', ')
      if (!window.confirm(`Discard the unsaved changes to ${names}?`)) {
        return
      }
    }
    const index = this._tabs.findIndex(t => t.path === this._activePath)
    for (const path of paths) {
      this.releaseTab(path)
    }
    this._tabs = this._tabs.filter(t => !paths.includes(t.path))
    if (this._activePath !== null && paths.includes(this._activePath)) {
      const next = this._tabs[Math.min(index, this._tabs.length - 1)]
      this._activePath = next?.path ?? null
    }
    this.changed()
  }

  /** Follow a file the explorer renamed. */
  public renamed(from: string, to: string) {
    const affected = (p: string) => p === from || p.startsWith(`${from}/`)
    const paths = this._tabs.map(t => t.path).filter(affected)
    if (paths.length === 0) {
      return
    }
    if (this.dirtyDocuments.some(d => affected(d.path))) {
      return
    }
    const wasActive = this._activePath !== null && affected(this._activePath)
    this.close(paths)
    for (const path of paths) {
      this.open(to + path.slice(from.length), { pin: true })
    }
    if (!wasActive) {
      this.activate(null)
    }
  }

  /** Re-read the index and the disk after git or the user changed files. */
  public refresh() {
    for (const document of this.documents.values()) {
      document.loadIndexText()
      document.scheduleDiskCheck()
    }
  }
}

const editorsByRepository = new Map<string, RepositoryEditors>()

export function getRepositoryEditors(repository: Repository) {
  let editors = editorsByRepository.get(repository.path)
  if (editors === undefined) {
    editors = new RepositoryEditors(repository)
    editorsByRepository.set(repository.path, editors)
  }
  return editors
}
