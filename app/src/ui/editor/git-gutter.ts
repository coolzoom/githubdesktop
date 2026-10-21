import type * as MonacoApi from 'monaco-editor'
import { Repository } from '../../models/repository'
import { showContextualMenu } from '../../lib/menu-item'
import {
  getIndexFileMode,
  setIndexFileContents,
} from '../../lib/git/index-file'
import {
  applyLineChange,
  diffLines,
  ILineChange,
  splitLines,
} from './line-diff'
import { EditorDocument } from './editor-store'
import { Monaco } from './monaco'

interface IGitGutterOptions {
  readonly repository: Repository
  /** Called once a change was staged so the status can refresh */
  readonly onStaged: () => void
  /** Show the diff of the file scrolled to a 1-based line */
  readonly onShowChanges: (line: number) => void
  readonly onError: (error: Error) => void
}

function kindOf(change: ILineChange) {
  if (change.originalLength === 0) {
    return 'added'
  }
  return change.modifiedLength === 0 ? 'deleted' : 'modified'
}

/** The 1-based lines of the editor a change is shown on. */
function linesOf(change: ILineChange) {
  if (change.modifiedLength === 0) {
    const line = Math.max(1, change.modifiedStart)
    return { start: line, end: line }
  }
  return {
    start: change.modifiedStart + 1,
    end: change.modifiedStart + change.modifiedLength,
  }
}

/** The overview ruler is a canvas, so it can't use CSS variables. */
const rulerColors = {
  added: '#2ea043a0',
  modified: '#1f6feba0',
  deleted: '#f85149a0',
}

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

/**
 * VS Code's dirty diff: bars next to the line numbers for the lines that
 * differ from the staged version, with a menu to stage or revert each one.
 */
export class GitGutter {
  private changes: ReadonlyArray<ILineChange> = []
  private readonly decorations: MonacoApi.editor.IEditorDecorationsCollection
  private readonly disposables: MonacoApi.IDisposable[] = []
  private timer: number | null = null

  public constructor(
    private readonly monaco: Monaco,
    editor: MonacoApi.editor.IStandaloneCodeEditor,
    private readonly document: EditorDocument,
    private readonly options: IGitGutterOptions
  ) {
    this.decorations = editor.createDecorationsCollection()
    this.disposables.push(
      editor.onDidChangeModelContent(() => this.schedule()),
      editor.onMouseDown(e => this.onMouseDown(e))
    )
    this.update()
  }

  /** Recompute after the staged version changed. */
  public schedule() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
    }
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.update()
    }, 200)
  }

  private update() {
    const { model, indexText } = this.document
    if (model === null || model.isDisposed() || indexText === null) {
      this.changes = []
      this.decorations.clear()
      return
    }
    this.changes =
      diffLines(splitLines(indexText), model.getLinesContent()) ?? []
    const { OverviewRulerLane } = this.monaco.editor
    this.decorations.set(
      this.changes.map(change => {
        const kind = kindOf(change)
        const { start, end } = linesOf(change)
        return {
          range: new this.monaco.Range(start, 1, end, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: `git-gutter git-gutter-${kind}${
              kind === 'deleted' && change.modifiedStart === 0 ? ' top' : ''
            }`,
            overviewRuler: {
              color: rulerColors[kind],
              position: OverviewRulerLane.Left,
            },
          },
        }
      })
    )
  }

  private changeAt(line: number) {
    return (
      this.changes.find(change => {
        const { start, end } = linesOf(change)
        return line >= start && line <= end
      }) ?? null
    )
  }

  private onMouseDown(e: MonacoApi.editor.IEditorMouseEvent) {
    const { MouseTargetType } = this.monaco.editor
    const line = e.target.position?.lineNumber
    if (
      e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS ||
      line === undefined
    ) {
      return
    }
    const change = this.changeAt(line)
    if (change === null) {
      return
    }
    e.event.preventDefault()
    showContextualMenu([
      {
        label: __DARWIN__ ? 'Show Changes' : 'Show changes',
        action: () => this.options.onShowChanges(linesOf(change).start),
      },
      { type: 'separator' },
      {
        label: __DARWIN__ ? 'Stage Change' : 'Stage change',
        action: () => this.stage(change),
      },
      {
        label: __DARWIN__ ? 'Revert Change' : 'Revert change',
        action: () => this.revert(change),
      },
    ])
  }

  /** Put one change into the index, leaving the rest of the file as is. */
  private async stage(change: ILineChange) {
    const { model, indexText, path } = this.document
    if (model === null || indexText === null) {
      return
    }
    const staged = applyLineChange(
      splitLines(indexText),
      model.getLinesContent(),
      change
    ).join(eolOf(indexText))
    try {
      const { repository } = this.options
      const mode = (await getIndexFileMode(repository, path)) ?? undefined
      await setIndexFileContents(repository, path, staged, mode)
      await this.document.loadIndexText()
      this.update()
      this.options.onStaged()
    } catch (e) {
      this.options.onError(e instanceof Error ? e : new Error(`${e}`))
    }
  }

  /** Bring the staged version of one change back into the editor. */
  private revert(change: ILineChange) {
    const { model, indexText } = this.document
    if (model === null || indexText === null) {
      return
    }
    const original = splitLines(indexText).slice(
      change.originalStart,
      change.originalStart + change.originalLength
    )
    const eol = model.getEOL()
    const lineCount = model.getLineCount()
    const end = change.modifiedStart + change.modifiedLength
    let startOffset = model.getOffsetAt({
      lineNumber: change.modifiedStart + 1,
      column: 1,
    })
    let endOffset: number
    let text: string
    if (end < lineCount) {
      endOffset = model.getOffsetAt({ lineNumber: end + 1, column: 1 })
      text = original.map(l => l + eol).join('')
    } else {
      // The change reaches the end of the file, which has no line break.
      endOffset = model.getValueLength()
      text = original.join(eol)
      if (original.length === 0 && change.modifiedStart > 0) {
        startOffset -= eol.length
      } else if (change.modifiedLength === 0) {
        text = eol + text
      }
    }
    const start = model.getPositionAt(startOffset)
    const stop = model.getPositionAt(endOffset)
    model.pushEditOperations(
      [],
      [
        {
          range: new this.monaco.Range(
            start.lineNumber,
            start.column,
            stop.lineNumber,
            stop.column
          ),
          text,
        },
      ],
      () => null
    )
  }

  public dispose() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
    }
    this.disposables.forEach(d => d.dispose())
    this.decorations.clear()
  }
}
