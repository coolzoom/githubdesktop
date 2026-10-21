import * as React from 'react'
import type * as MonacoApi from 'monaco-editor'
import classNames from 'classnames'
import { Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { Dispatcher } from '../dispatcher'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { baseEditorOptions, loadMonaco } from './monaco'
import {
  EditorDocument,
  EditorView,
  IEditorTab,
  RepositoryEditors,
} from './editor-store'
import { GitGutter } from './git-gutter'
import { DocumentDiff } from './revision-diff'

interface ITextEditorHostProps {
  readonly repository: Repository
  readonly document: EditorDocument
  readonly editors: RepositoryEditors
  readonly onSave: () => void
  readonly onStaged: () => void
  readonly onShowChanges: (line: number) => void
  readonly onError: (error: Error) => void
}

/** A Monaco editor on a document, with git change markers. */
class TextEditorHost extends React.Component<ITextEditorHostProps> {
  private readonly containerRef = React.createRef<HTMLDivElement>()
  private editor: MonacoApi.editor.IStandaloneCodeEditor | null = null
  private gutter: GitGutter | null = null
  private subscription: Disposable | null = null
  private unmounted = false

  public async componentDidMount() {
    const monaco = await loadMonaco()
    const container = this.containerRef.current
    const { document } = this.props
    if (this.unmounted || container === null || document.model === null) {
      return
    }
    const editor = monaco.editor.create(container, {
      ...baseEditorOptions(),
      model: document.model,
    })
    this.editor = editor
    if (document.viewState !== null) {
      editor.restoreViewState(document.viewState)
    }
    editor.addAction({
      id: 'desktop.save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => this.props.onSave(),
    })
    this.gutter = new GitGutter(monaco, editor, document, {
      repository: this.props.repository,
      onStaged: () => this.props.onStaged(),
      onShowChanges: line => this.props.onShowChanges(line),
      onError: error => this.props.onError(error),
    })
    let indexText = document.indexText
    this.subscription = this.props.editors.onDidChange(() => {
      if (document.indexText !== indexText) {
        indexText = document.indexText
        this.gutter?.schedule()
      }
    })
    editor.focus()
  }

  public componentWillUnmount() {
    this.unmounted = true
    this.subscription?.dispose()
    this.gutter?.dispose()
    if (this.editor !== null) {
      this.props.document.viewState = this.editor.saveViewState()
      this.editor.dispose()
    }
  }

  public render() {
    return <div className="monaco-editor-host" ref={this.containerRef} />
  }
}

interface ICodeEditorProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly editors: RepositoryEditors
  readonly tab: IEditorTab
  readonly sideBySide: boolean
  readonly hideWhitespace: boolean
  readonly externalEditorLabel?: string
  readonly onOpenInExternalEditor: (path: string) => void
}

interface ICodeEditorState {
  /** The line the Changes view scrolls to after "Show Changes" */
  readonly revealLine: number | undefined
}

const unsupportedMessages = {
  binary: 'This file is binary and can’t be shown in the editor.',
  'too-large': 'This file is too large to edit here.',
  unreadable: 'This file can’t be read.',
}

/** A file open in a tab: editable as text, or as a diff with the index. */
export class CodeEditor extends React.Component<
  ICodeEditorProps,
  ICodeEditorState
> {
  private subscription: Disposable | null = null

  public constructor(props: ICodeEditorProps) {
    super(props)
    this.state = { revealLine: undefined }
  }

  public componentDidMount() {
    this.subscription = this.props.editors.onDidChange(() => this.forceUpdate())
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
  }

  private get document() {
    return this.props.editors.getDocument(this.props.tab.path)
  }

  private setView(view: EditorView, revealLine?: number) {
    this.setState({ revealLine })
    this.props.editors.setView(this.props.tab.path, view)
  }

  private onShowEdit = () => this.setView('edit')
  private onShowChangesView = () => this.setView('changes')
  private onShowChanges = (line: number) => this.setView('changes', line)

  private onSave = () => {
    this.document?.save()
  }

  private onStaged = () => {
    this.props.dispatcher.refreshStatus(this.props.repository)
  }

  private onError = (error: Error) => {
    this.props.dispatcher.postError(error)
  }

  private onOpenExternally = () => {
    this.props.onOpenInExternalEditor(this.props.tab.path)
  }

  private onReload = () => {
    this.document?.revertToDisk().catch(this.onError)
  }

  private onKeepMine = () => {
    this.document?.keepMine()
  }

  private renderBanner(document: EditorDocument) {
    if (document.isDeleted) {
      return (
        <div className="code-editor-banner warning">
          <Octicon symbol={octicons.alert} />
          <span>
            This file was deleted on disk. Saving will create it again.
          </span>
        </div>
      )
    }
    if (!document.hasConflict) {
      return null
    }
    return (
      <div className="code-editor-banner warning">
        <Octicon symbol={octicons.alert} />
        <span>
          This file was changed on disk while you had unsaved changes.
        </span>
        <button type="button" onClick={this.onReload}>
          Reload from Disk
        </button>
        <button type="button" onClick={this.onKeepMine}>
          Keep My Changes
        </button>
      </div>
    )
  }

  private renderBody(document: EditorDocument | null) {
    const { tab } = this.props
    if (document !== null && document.unsupported !== null) {
      return (
        <div className="code-editor-unsupported">
          <p>{unsupportedMessages[document.unsupported]}</p>
          <button type="button" onClick={this.onOpenExternally}>
            {this.props.externalEditorLabel
              ? `Open in ${this.props.externalEditorLabel}`
              : 'Open in External Editor'}
          </button>
        </div>
      )
    }
    if (document === null || document.model === null) {
      return <div className="monaco-editor-host" />
    }
    if (tab.view === 'changes') {
      return (
        <DocumentDiff
          editors={this.props.editors}
          path={tab.path}
          sideBySide={this.props.sideBySide}
          ignoreTrimWhitespace={this.props.hideWhitespace}
          revealLine={this.state.revealLine}
        />
      )
    }
    return (
      <TextEditorHost
        key={tab.path}
        repository={this.props.repository}
        document={document}
        editors={this.props.editors}
        onSave={this.onSave}
        onStaged={this.onStaged}
        onShowChanges={this.onShowChanges}
        onError={this.onError}
      />
    )
  }

  public render() {
    const { tab } = this.props
    const document = this.document
    const segments = tab.path.split('/')
    const canSave = document !== null && document.model !== null
    return (
      <div className="code-editor">
        <div className="code-editor-toolbar">
          <span className="code-editor-path">
            {segments.slice(0, -1).map((s, i) => (
              <span key={i} className="folder">
                {s}
                <Octicon symbol={octicons.chevronRight} />
              </span>
            ))}
            <span className="file">{segments[segments.length - 1]}</span>
          </span>
          <div className="code-editor-views" role="group">
            <button
              type="button"
              className={classNames({ selected: tab.view === 'edit' })}
              aria-pressed={tab.view === 'edit'}
              onClick={this.onShowEdit}
            >
              <Octicon symbol={octicons.pencil} />
              Edit
            </button>
            <button
              type="button"
              className={classNames({ selected: tab.view === 'changes' })}
              aria-pressed={tab.view === 'changes'}
              onClick={this.onShowChangesView}
            >
              <Octicon symbol={octicons.diff} />
              Changes
            </button>
          </div>
          <button
            type="button"
            className="code-editor-action"
            disabled={!canSave || !document.isDirty}
            onClick={this.onSave}
          >
            Save
          </button>
          <button
            type="button"
            className="code-editor-action"
            onClick={this.onOpenExternally}
            aria-label="Open in external editor"
          >
            <Octicon symbol={octicons.linkExternal} />
          </button>
        </div>
        {document !== null && this.renderBanner(document)}
        <div className="code-editor-body">{this.renderBody(document)}</div>
      </div>
    )
  }
}
