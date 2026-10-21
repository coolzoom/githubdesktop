import * as React from 'react'
import { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../models/status'
import {
  DiffSelection,
  DiffType,
  IDiff,
  ImageDiffType,
  ITextDiff,
} from '../../models/diff'
import { PopupType } from '../../models/popup'
import { stagingSideFile } from '../../lib/staging'
import { Dispatcher } from '../dispatcher'
import { SeamlessDiffSwitcher } from '../diff/seamless-diff-switcher'
import { DiffHeader } from '../diff/diff-header'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import * as wip from './wip-actions'
import { RepositoryEditors } from '../editor/editor-store'
import {
  DocumentDiff,
  DiffRevision,
  RevisionDiff,
} from '../editor/revision-diff'

interface IWorkingFileDiffProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly file: WorkingDirectoryFileChange
  /** Whether this is the diff of the staged half of the file's changes */
  readonly staged: boolean
  readonly diff: IDiff | null
  readonly isCommitting: boolean
  readonly imageDiffType: ImageDiffType
  readonly hideWhitespaceInDiff: boolean
  readonly showSideBySideDiff: boolean
  readonly showDiffCheckMarks: boolean
  readonly askForConfirmationOnDiscardChanges: boolean
  readonly onOpenBinaryFile: (fullPath: string) => void
  readonly onOpenSubmodule: (fullPath: string) => void
  readonly onChangeImageDiffType: (type: ImageDiffType) => void
  readonly onDiffOptionsOpened: () => void
  readonly editors: RepositoryEditors
  /** Whether text diffs show in Monaco instead of the line staging view */
  readonly useEditorDiff: boolean
  /** Renders the button switching between the two diff styles */
  readonly diffStyleToggle: React.ReactNode
  readonly onClose: () => void
}

/**
 * The diff of one half of a working directory file in place of the graph.
 * Selecting lines or a hunk in it stages them, or unstages them when it is
 * the staged half, like GitKraken's hunk and line staging.
 */
export class WorkingFileDiff extends React.Component<IWorkingFileDiffProps> {
  private get sideFile() {
    return stagingSideFile(this.props.file, this.props.staged)
  }

  /** Line selection is disabled while committing or when hiding whitespace. */
  private get lineSelectionDisabled() {
    return this.props.isCommitting || this.props.hideWhitespaceInDiff
  }

  private get textDiff(): ITextDiff | null {
    const { diff } = this.props
    return diff !== null && diff.kind === DiffType.Text ? diff : null
  }

  private onIncludeChanged = (selection: DiffSelection) => {
    const diff = this.textDiff
    if (this.lineSelectionDisabled || diff === null) {
      return
    }
    const { dispatcher, repository, file, staged } = this.props
    wip.applyLineSelection(
      dispatcher,
      repository,
      file,
      staged,
      diff,
      selection
    )
  }

  private onDiscardChanges = (diff: ITextDiff, selection: DiffSelection) => {
    if (this.lineSelectionDisabled) {
      return
    }
    const { dispatcher, repository, file } = this.props
    if (this.props.askForConfirmationOnDiscardChanges) {
      dispatcher.showPopup({
        type: PopupType.ConfirmDiscardSelection,
        repository,
        file: this.sideFile,
        diff,
        selection,
      })
    } else {
      dispatcher.discardChangesFromSelection(
        repository,
        file.path,
        diff,
        selection
      )
    }
  }

  private onToggleFile = () => {
    const { dispatcher, repository, file, staged } = this.props
    if (staged) {
      wip.unstageFiles(dispatcher, repository, [file])
    } else {
      wip.stageFiles(dispatcher, repository, [file])
    }
  }

  private onShowSideBySideDiffChanged = (showSideBySideDiff: boolean) =>
    this.props.dispatcher.onShowSideBySideDiffChanged(showSideBySideDiff)

  private onHideWhitespaceInDiffChanged = (hide: boolean) =>
    this.props.dispatcher.onHideWhitespaceInChangesDiffChanged(
      hide,
      this.props.repository
    )

  public render() {
    const { staged, diff } = this.props
    const sideFile = this.sideFile

    return (
      <div className="center-diff working-file-diff">
        <div className="center-diff-header">
          <button
            type="button"
            className="close-diff"
            onClick={this.props.onClose}
            aria-label="Back to graph"
          >
            <Octicon symbol={octicons.x} />
          </button>
          <span className={`wip-diff-side ${staged ? 'staged' : 'unstaged'}`}>
            {staged ? 'Staged' : 'Unstaged'}
          </span>
          <DiffHeader
            diff={diff}
            path={sideFile.path}
            status={sideFile.status}
            showSideBySideDiff={this.props.showSideBySideDiff}
            onShowSideBySideDiffChanged={this.onShowSideBySideDiffChanged}
            hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
            onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
            onDiffOptionsOpened={this.props.onDiffOptionsOpened}
          />
          <button
            type="button"
            className={`wip-button ${staged ? '' : 'stage'}`}
            onClick={this.onToggleFile}
          >
            {staged ? 'Unstage File' : 'Stage File'}
          </button>
          {this.canUseEditorDiff && this.props.diffStyleToggle}
        </div>
        {this.canUseEditorDiff && this.props.useEditorDiff
          ? this.renderEditorDiff()
          : this.renderClassicDiff()}
      </div>
    )
  }

  /** Monaco can show text diffs of files that exist on the side shown. */
  private get canUseEditorDiff() {
    const kind = this.sideFile.status.kind
    return (
      this.textDiff !== null &&
      kind !== AppFileStatusKind.Conflicted &&
      (this.props.staged || kind !== AppFileStatusKind.Deleted)
    )
  }

  private renderEditorDiff() {
    const { file, staged, editors } = this.props
    const sideBySide = this.props.showSideBySideDiff
    const ignoreTrimWhitespace = this.props.hideWhitespaceInDiff
    if (!staged) {
      return (
        <DocumentDiff
          editors={editors}
          path={file.path}
          sideBySide={sideBySide}
          ignoreTrimWhitespace={ignoreTrimWhitespace}
          fallback={this.renderClassicDiff()}
        />
      )
    }
    const { status } = this.sideFile
    const headPath =
      status.kind === AppFileStatusKind.Renamed ||
      status.kind === AppFileStatusKind.Copied
        ? status.oldPath
        : file.path
    const original: DiffRevision =
      status.kind === AppFileStatusKind.New
        ? { kind: 'empty' }
        : { kind: 'commit', commitish: 'HEAD', path: headPath }
    const modified: DiffRevision =
      status.kind === AppFileStatusKind.Deleted
        ? { kind: 'empty' }
        : { kind: 'index', path: file.path }
    return (
      <RevisionDiff
        repository={this.props.repository}
        path={file.path}
        original={original}
        modified={modified}
        refreshKey={file}
        sideBySide={sideBySide}
        ignoreTrimWhitespace={ignoreTrimWhitespace}
      />
    )
  }

  private renderClassicDiff() {
    const { diff, staged } = this.props
    const sideFile = this.sideFile
    return (
      <SeamlessDiffSwitcher
        repository={this.props.repository}
        imageDiffType={this.props.imageDiffType}
        file={sideFile}
        diff={diff}
        readOnly={this.lineSelectionDisabled}
        onIncludeChanged={this.onIncludeChanged}
        onDiscardChanges={staged ? undefined : this.onDiscardChanges}
        hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
        showSideBySideDiff={this.props.showSideBySideDiff}
        showDiffCheckMarks={this.props.showDiffCheckMarks}
        askForConfirmationOnDiscardChanges={
          this.props.askForConfirmationOnDiscardChanges
        }
        onOpenBinaryFile={this.props.onOpenBinaryFile}
        onOpenSubmodule={this.props.onOpenSubmodule}
        onChangeImageDiffType={this.props.onChangeImageDiffType}
        onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
      />
    )
  }
}
