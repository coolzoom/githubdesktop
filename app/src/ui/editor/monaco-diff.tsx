import * as React from 'react'
import type * as MonacoApi from 'monaco-editor'
import { baseEditorOptions, loadMonaco, Monaco } from './monaco'

interface IMonacoDiffProps {
  /** Relative to the repository root, to pick the language */
  readonly path: string
  readonly original: string
  /** The text of the new side, or a model to edit it in place */
  readonly modified: string | MonacoApi.editor.ITextModel
  readonly sideBySide: boolean
  readonly ignoreTrimWhitespace: boolean
  /** A 1-based line of the new side to scroll to once loaded */
  readonly revealLine?: number
  readonly onSave?: () => void
}

let modelCounter = 0

function createModel(monaco: Monaco, text: string, side: string, path: string) {
  const uri = monaco.Uri.from({
    scheme: `desktop-${side}`,
    path: `/${path}`,
    query: `${++modelCounter}`,
  })
  return monaco.editor.createModel(text, undefined, uri)
}

/** Monaco's diff editor between two versions of a file. */
export class MonacoDiff extends React.Component<IMonacoDiffProps> {
  private readonly containerRef = React.createRef<HTMLDivElement>()
  private monaco: Monaco | null = null
  private editor: MonacoApi.editor.IStandaloneDiffEditor | null = null
  private originalModel: MonacoApi.editor.ITextModel | null = null
  /** The model of the new side when it was given as text */
  private ownModifiedModel: MonacoApi.editor.ITextModel | null = null
  private unmounted = false

  public async componentDidMount() {
    const monaco = await loadMonaco()
    const container = this.containerRef.current
    if (this.unmounted || container === null) {
      return
    }
    this.monaco = monaco
    const { path, original, modified } = this.props
    this.editor = monaco.editor.createDiffEditor(container, {
      ...baseEditorOptions(),
      ...this.diffOptions(),
      originalEditable: false,
      readOnly: typeof modified === 'string',
      renderMarginRevertIcon: typeof modified !== 'string',
      useInlineViewWhenSpaceIsLimited: true,
      hideUnchangedRegions: { enabled: true },
      minimap: { enabled: false },
    })
    this.originalModel = createModel(monaco, original, 'original', path)
    this.editor.setModel({
      original: this.originalModel,
      modified: this.modifiedModel(monaco),
    })
    const onSave = () => this.props.onSave?.()
    this.editor.getModifiedEditor().addAction({
      id: 'desktop.save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: onSave,
    })
    this.reveal()
  }

  private diffOptions(): MonacoApi.editor.IDiffEditorOptions {
    return {
      renderSideBySide: this.props.sideBySide,
      ignoreTrimWhitespace: this.props.ignoreTrimWhitespace,
    }
  }

  private modifiedModel(monaco: Monaco) {
    const { modified, path } = this.props
    if (typeof modified !== 'string') {
      return modified
    }
    this.ownModifiedModel = createModel(monaco, modified, 'modified', path)
    return this.ownModifiedModel
  }

  private reveal() {
    const { revealLine } = this.props
    const editor = this.editor
    if (revealLine === undefined || editor === null) {
      return
    }
    const modified = editor.getModifiedEditor()
    const once = editor.onDidUpdateDiff(() => {
      once.dispose()
      modified.revealLineInCenter(revealLine)
      modified.setPosition({ lineNumber: revealLine, column: 1 })
    })
  }

  public componentDidUpdate(prevProps: IMonacoDiffProps) {
    const { editor, monaco } = this
    if (editor === null || monaco === null) {
      return
    }
    const props = this.props
    if (
      prevProps.sideBySide !== props.sideBySide ||
      prevProps.ignoreTrimWhitespace !== props.ignoreTrimWhitespace
    ) {
      editor.updateOptions(this.diffOptions())
    }
    if (
      this.originalModel !== null &&
      props.original !== this.originalModel.getValue()
    ) {
      this.originalModel.setValue(props.original)
    }
    if (prevProps.modified !== props.modified) {
      const previous = this.ownModifiedModel
      this.ownModifiedModel = null
      editor.setModel({
        original: this.originalModel!,
        modified: this.modifiedModel(monaco),
      })
      previous?.dispose()
    }
    if (prevProps.revealLine !== props.revealLine) {
      this.reveal()
    }
  }

  public componentWillUnmount() {
    this.unmounted = true
    this.editor?.dispose()
    this.originalModel?.dispose()
    this.ownModifiedModel?.dispose()
  }

  public render() {
    return <div className="monaco-diff-host" ref={this.containerRef} />
  }
}
