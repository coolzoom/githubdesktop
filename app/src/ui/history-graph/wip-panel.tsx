import * as React from 'react'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import {
  Repository,
  isRepositoryWithGitHubRepository,
} from '../../models/repository'
import {
  WorkingDirectoryFileChange,
  WorkingDirectoryStatus,
} from '../../models/status'
import { Account } from '../../models/account'
import { TipState } from '../../models/tip'
import { ICommitContext } from '../../models/commit'
import { ICommitMessage } from '../../models/commit-message'
import { Author, UnknownAuthor } from '../../models/author'
import { Popup, PopupType } from '../../models/popup'
import { hasWritePermission } from '../../models/github-repository'
import { CommitOptions, Foldout, IRepositoryState } from '../../lib/app-state'
import { Emoji } from '../../lib/emoji'
import { mapStatus } from '../../lib/status'
import { splitStagedFiles, stagingSideFile } from '../../lib/staging'
import { getAccountForRepository } from '../../lib/get-account-for-repository'
import { getLargeFilePaths } from '../../lib/large-files'
import { filesNotTrackedByLFS } from '../../lib/git/lfs'
import { IssuesStore, GitHubUserStore } from '../../lib/stores'
import {
  buildAutocompletionProviders,
  IAutocompletionProvider,
} from '../autocompletion'
import { CommitMessage } from '../changes/commit-message'
import { UndoCommit } from '../changes/undo-commit'
import { Dispatcher } from '../dispatcher'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { TooltippedContent } from '../lib/tooltipped-content'
import { Octicon, iconForStatus } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { GraphMenus } from './graph-menus'
import * as wip from './wip-actions'

/** A file of the WIP panel and which of its two lists it was picked from. */
export interface IWipFileSelection {
  readonly path: string
  readonly staged: boolean
}

/** Desktop's commit settings that the WIP panel's commit form needs. */
export interface IWipCommitOptions {
  readonly issuesStore: IssuesStore
  readonly gitHubUserStore: GitHubUserStore
  readonly focusCommitMessage: boolean
  readonly isShowingModal: boolean
  readonly isShowingFoldout: boolean
  readonly commitSpellcheckEnabled: boolean
  readonly showCommitLengthWarning: boolean
  readonly shouldShowGenerateCommitMessageCallOut: boolean
  readonly skipCommitHooks: boolean
  readonly signOffCommits: boolean
  readonly allowEmptyCommit: boolean
  readonly onShowCommitProgress: (() => void) | undefined
  readonly onUpdateCommitOptions: (
    repository: Repository,
    options: Partial<CommitOptions>
  ) => void
}

interface IWipFileRowProps {
  readonly file: WorkingDirectoryFileChange
  readonly staged: boolean
  readonly isSelected: boolean
  readonly onSelect: (file: WorkingDirectoryFileChange, staged: boolean) => void
  readonly onToggle: (file: WorkingDirectoryFileChange, staged: boolean) => void
  readonly onContextMenu: (
    file: WorkingDirectoryFileChange,
    staged: boolean
  ) => void
}

/** A file in the Unstaged or Staged list with GitKraken's hover action. */
class WipFileRow extends React.PureComponent<IWipFileRowProps> {
  private onSelect = () =>
    this.props.onSelect(this.props.file, this.props.staged)

  private onToggle = () =>
    this.props.onToggle(this.props.file, this.props.staged)

  private onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    this.props.onContextMenu(this.props.file, this.props.staged)
  }

  public render() {
    const { file, staged, isSelected } = this.props
    const { status } = stagingSideFile(file, staged)
    const name = file.path.split('/').pop() ?? file.path
    const dir = file.path.slice(0, file.path.length - name.length)
    const action = staged ? 'Unstage File' : 'Stage File'

    return (
      <div
        className={classNames('details-file wip-file', {
          selected: isSelected,
        })}
      >
        <button
          type="button"
          className="wip-file-main"
          onClick={this.onSelect}
          onContextMenu={this.onContextMenu}
        >
          <Octicon
            symbol={iconForStatus(status)}
            className={`status status-${mapStatus(status).toLowerCase()}`}
          />
          <TooltippedContent
            className="file-path"
            tagName="span"
            tooltip={file.path}
          >
            {dir.length > 0 ? <span className="file-dir">{dir}</span> : null}
            <span className="file-name">{name}</span>
          </TooltippedContent>
        </button>
        <button
          type="button"
          className={classNames('wip-file-action', { unstage: staged })}
          onClick={this.onToggle}
        >
          {action}
        </button>
      </div>
    )
  }
}

interface IWipPanelProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly state: IRepositoryState
  readonly menus: GraphMenus
  readonly emoji: Map<string, Emoji>
  readonly accounts: ReadonlyArray<Account>
  readonly options: IWipCommitOptions
  readonly selectedFile: IWipFileSelection | null
  /** Conflicted files that the merge tool can open */
  readonly mergeablePaths: ReadonlySet<string>
  readonly onFileSelected: (selection: IWipFileSelection) => void
  readonly onOpenMergeTool: (path: string) => void
}

/**
 * GitKraken's work-in-progress panel: the Unstaged and Staged file lists of
 * the index and a commit form that commits what is staged.
 */
export class WipPanel extends React.Component<IWipPanelProps> {
  private autocompletionProviders: ReadonlyArray<
    IAutocompletionProvider<any>
  > | null = null

  private getLists = memoizeOne(
    (files: ReadonlyArray<WorkingDirectoryFileChange>) =>
      splitStagedFiles(files)
  )

  private get lists() {
    return this.getLists(this.props.state.changesState.workingDirectory.files)
  }

  private get providers() {
    const { repository, dispatcher, emoji, accounts, options } = this.props
    if (this.autocompletionProviders === null) {
      this.autocompletionProviders = buildAutocompletionProviders(
        repository,
        dispatcher,
        emoji,
        options.issuesStore,
        options.gitHubUserStore,
        accounts
      )
    }
    return this.autocompletionProviders
  }

  public componentDidUpdate(prevProps: IWipPanelProps) {
    if (
      prevProps.repository.hash !== this.props.repository.hash ||
      prevProps.accounts !== this.props.accounts ||
      prevProps.emoji.size !== this.props.emoji.size
    ) {
      this.autocompletionProviders = null
    }
  }

  private get branchName() {
    const { tip } = this.props.state.branchesState
    if (tip.kind === TipState.Valid) {
      return tip.branch.name
    }
    return tip.kind === TipState.Unborn ? tip.ref : null
  }

  private get headCommit() {
    const { tip } = this.props.state.branchesState
    const sha =
      tip.kind === TipState.Valid
        ? tip.branch.tip.sha
        : tip.kind === TipState.Detached
        ? tip.currentSha
        : null
    return sha === null ? null : this.props.state.commitLookup.get(sha) ?? null
  }

  private onFileSelected = (
    file: WorkingDirectoryFileChange,
    staged: boolean
  ) => this.props.onFileSelected({ path: file.path, staged })

  private onToggleFile = (
    file: WorkingDirectoryFileChange,
    staged: boolean
  ) => {
    const { dispatcher, repository } = this.props
    if (staged) {
      wip.unstageFiles(dispatcher, repository, [file])
    } else {
      wip.stageFiles(dispatcher, repository, [file])
    }
  }

  private onFileContextMenu = (
    file: WorkingDirectoryFileChange,
    staged: boolean
  ) => {
    const canMerge = this.props.mergeablePaths.has(file.path)
    this.props.menus.showWorkingFileMenu(
      file,
      staged,
      canMerge ? () => this.props.onOpenMergeTool(file.path) : null
    )
  }

  private onStageAll = () =>
    wip.stageAll(this.props.dispatcher, this.props.repository)

  private onUnstageAll = () =>
    wip.unstageAll(this.props.dispatcher, this.props.repository)

  private onDiscardAll = () =>
    this.props.menus.discardFiles(this.lists.unstaged, true)

  private onAmendChanged = (event: React.FormEvent<HTMLInputElement>) => {
    const { dispatcher, repository, state } = this.props
    const commit = this.headCommit
    if (!event.currentTarget.checked) {
      dispatcher.stopAmendingRepository(repository)
    } else if (commit !== null) {
      dispatcher.startAmendingRepository(
        repository,
        commit,
        state.localCommitSHAs.includes(commit.sha)
      )
    }
  }

  private onCreateCommit = async (context: ICommitContext) => {
    const { dispatcher, repository } = this.props
    const staged = WorkingDirectoryStatus.fromFiles(this.lists.staged)
    const ignoredByLFS = await filesNotTrackedByLFS(
      repository,
      await getLargeFilePaths(repository, staged)
    )
    if (ignoredByLFS.length > 0) {
      dispatcher.showPopup({
        type: PopupType.OversizedFiles,
        oversizedFiles: ignoredByLFS,
        context,
        repository,
      })
      return false
    }
    return dispatcher.commitIncludedChanges(repository, context)
  }

  private onCoAuthorsUpdated = (coAuthors: ReadonlyArray<Author>) =>
    this.props.dispatcher.setCoAuthors(this.props.repository, coAuthors)

  private onShowCoAuthoredByChanged = (showCoAuthoredBy: boolean) =>
    this.props.dispatcher.setShowCoAuthoredBy(
      this.props.repository,
      showCoAuthoredBy
    )

  private onConfirmCommitWithUnknownCoAuthors = (
    coAuthors: ReadonlyArray<UnknownAuthor>,
    onCommitAnyway: () => void
  ) =>
    this.props.dispatcher.showUnknownAuthorsCommitWarning(
      coAuthors,
      onCommitAnyway
    )

  private onPersistCommitMessage = (message: ICommitMessage) =>
    this.props.dispatcher.setCommitMessage(this.props.repository, message)

  private onGenerateCommitMessage = (
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    mustOverrideExistingMessage: boolean
  ) => {
    const { dispatcher, repository } = this.props
    dispatcher.incrementMetric('generateCommitMessageButtonClickCount')
    return mustOverrideExistingMessage
      ? dispatcher.promptOverrideWithGeneratedCommitMessage(repository, files)
      : dispatcher.generateCommitMessage(repository, files)
  }

  private onCancelGenerateCommitMessage = () =>
    this.props.dispatcher.cancelGenerateCommitMessage(this.props.repository)

  private onCommitMessageFocusSet = () =>
    this.props.dispatcher.setCommitMessageFocus(false)

  private onRefreshAuthor = () =>
    this.props.dispatcher.refreshAuthor(this.props.repository)

  private onShowPopup = (popup: Popup) => this.props.dispatcher.showPopup(popup)

  private onShowFoldout = (foldout: Foldout) =>
    this.props.dispatcher.showFoldout(foldout)

  private onCommitSpellcheckEnabledChanged = (enabled: boolean) =>
    this.props.dispatcher.setCommitSpellcheckEnabled(enabled)

  private onStopAmending = () =>
    this.props.dispatcher.stopAmendingRepository(this.props.repository)

  private onShowCreateForkDialog = () => {
    if (isRepositoryWithGitHubRepository(this.props.repository)) {
      this.props.dispatcher.showCreateForkDialog(this.props.repository)
    }
  }

  private renderFiles(
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    staged: boolean
  ) {
    const { selectedFile } = this.props
    if (files.length === 0) {
      return (
        <div className="wip-empty">
          {staged ? 'No staged files' : 'No unstaged changes'}
        </div>
      )
    }
    return files.map(file => (
      <WipFileRow
        key={file.id}
        file={file}
        staged={staged}
        isSelected={
          selectedFile?.path === file.path && selectedFile.staged === staged
        }
        onSelect={this.onFileSelected}
        onToggle={this.onToggleFile}
        onContextMenu={this.onFileContextMenu}
      />
    ))
  }

  private renderSection(
    title: string,
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    staged: boolean,
    actions: JSX.Element
  ) {
    return (
      <div className={classNames('wip-section', { staged })}>
        <div className="wip-section-header">
          <Octicon
            symbol={staged ? octicons.checkCircle : octicons.circle}
            className="wip-section-icon"
          />
          <span className="wip-section-title">
            {title} ({files.length})
          </span>
          <span className="wip-section-actions">{actions}</span>
        </div>
        <div className="wip-files">{this.renderFiles(files, staged)}</div>
      </div>
    )
  }

  private renderCommitForm() {
    const { repository, state, options, accounts } = this.props
    const { changesState } = state
    const { staged } = this.lists
    const fileCount = changesState.workingDirectory.files.length
    const hasWriteAccess =
      repository.gitHubRepository === null ||
      hasWritePermission(repository.gitHubRepository)
    const headCommit = this.headCommit

    return (
      <div className="wip-commit">
        <div className="wip-commit-header">
          <span className="wip-section-title">Commit</span>
          <Checkbox
            className="wip-amend"
            label="Amend previous commit"
            disabled={headCommit === null}
            value={
              state.commitToAmend !== null
                ? CheckboxValue.On
                : CheckboxValue.Off
            }
            onChange={this.onAmendChanged}
          />
        </div>
        <CommitMessage
          key={repository.id}
          onCreateCommit={this.onCreateCommit}
          branch={this.branchName}
          mostRecentLocalCommit={null}
          commitAuthor={state.commitAuthor}
          isShowingModal={options.isShowingModal}
          isShowingFoldout={options.isShowingFoldout}
          anyFilesSelected={staged.length > 0}
          anyFilesAvailable={fileCount > 0}
          filesSelected={staged}
          filesToBeCommittedCount={staged.length}
          repository={repository}
          repositoryAccount={getAccountForRepository(accounts, repository)}
          commitMessage={changesState.commitMessage}
          focusCommitMessage={options.focusCommitMessage}
          autocompletionProviders={this.providers}
          isCommitting={state.isCommitting}
          hookProgress={state.hookProgress}
          onShowCommitProgress={options.onShowCommitProgress}
          isGeneratingCommitMessage={state.isGeneratingCommitMessage}
          shouldShowGenerateCommitMessageCallOut={
            options.shouldShowGenerateCommitMessageCallOut
          }
          commitToAmend={state.commitToAmend}
          showCoAuthoredBy={changesState.showCoAuthoredBy}
          coAuthors={changesState.coAuthors}
          placeholder="Summary (required)"
          prepopulateCommitSummary={false}
          showBranchProtected={
            fileCount > 0 && changesState.currentBranchProtected
          }
          repoRulesInfo={changesState.currentRepoRulesInfo}
          aheadBehind={state.aheadBehind}
          showNoWriteAccess={fileCount > 0 && !hasWriteAccess}
          commitSpellcheckEnabled={options.commitSpellcheckEnabled}
          showCommitLengthWarning={options.showCommitLengthWarning}
          onCoAuthorsUpdated={this.onCoAuthorsUpdated}
          onShowCoAuthoredByChanged={this.onShowCoAuthoredByChanged}
          onConfirmCommitWithUnknownCoAuthors={
            this.onConfirmCommitWithUnknownCoAuthors
          }
          onPersistCommitMessage={this.onPersistCommitMessage}
          onGenerateCommitMessage={this.onGenerateCommitMessage}
          onCancelGenerateCommitMessage={this.onCancelGenerateCommitMessage}
          onCommitMessageFocusSet={this.onCommitMessageFocusSet}
          onRefreshAuthor={this.onRefreshAuthor}
          onShowPopup={this.onShowPopup}
          onShowFoldout={this.onShowFoldout}
          onCommitSpellcheckEnabledChanged={
            this.onCommitSpellcheckEnabledChanged
          }
          onStopAmending={this.onStopAmending}
          onShowCreateForkDialog={this.onShowCreateForkDialog}
          accounts={accounts}
          skipCommitHooks={options.skipCommitHooks}
          signOffCommits={options.signOffCommits}
          allowEmptyCommit={options.allowEmptyCommit}
          showAllowEmptyCommitOption={true}
          onUpdateCommitOptions={options.onUpdateCommitOptions}
        />
      </div>
    )
  }

  public render() {
    const { unstaged, staged } = this.lists
    const total = this.props.state.changesState.workingDirectory.files.length
    const branch = this.branchName

    return (
      <div className="commit-details-panel wip-panel gk-theme">
        <div className="wip-header">
          <Octicon symbol={octicons.pencil} />
          <span>
            {total} file {total === 1 ? 'change' : 'changes'}
            {branch !== null ? (
              <>
                {' on '}
                <span className="wip-branch">{branch}</span>
              </>
            ) : null}
          </span>
        </div>
        {this.renderSection(
          'Unstaged Files',
          unstaged,
          false,
          <>
            <button
              type="button"
              className="wip-button"
              disabled={unstaged.length === 0}
              onClick={this.onDiscardAll}
            >
              Discard all
            </button>
            <button
              type="button"
              className="wip-button stage"
              disabled={unstaged.length === 0}
              onClick={this.onStageAll}
            >
              Stage all changes
            </button>
          </>
        )}
        {this.renderSection(
          'Staged Files',
          staged,
          true,
          <button
            type="button"
            className="wip-button"
            disabled={staged.length === 0}
            onClick={this.onUnstageAll}
          >
            Unstage all
          </button>
        )}
        {this.renderCommitForm()}
        {this.renderUndoCommit()}
      </div>
    )
  }

  /** The most recent unpushed commit, which can be undone like in Changes. */
  private get undoableCommit() {
    const { localCommitSHAs, commitLookup, commitToAmend, changesState } =
      this.props.state
    if (commitToAmend !== null || changesState.conflictState !== null) {
      return null
    }
    const sha = localCommitSHAs.length > 0 ? localCommitSHAs[0] : null
    const commit = sha === null ? null : commitLookup.get(sha) ?? null
    // A tagged commit wouldn't go away, so the original doesn't offer undo.
    return commit !== null && commit.tags.length === 0 ? commit : null
  }

  private onUndoCommit = () => {
    const commit = this.undoableCommit
    if (commit !== null) {
      this.props.dispatcher.undoCommit(this.props.repository, commit)
    }
  }

  private renderUndoCommit() {
    const commit = this.undoableCommit
    if (commit === null) {
      return null
    }
    return (
      <UndoCommit
        commit={commit}
        emoji={this.props.emoji}
        isPushPullFetchInProgress={this.props.state.isPushPullFetchInProgress}
        isCommitting={this.props.state.isCommitting}
        onUndo={this.onUndoCommit}
      />
    )
  }
}
