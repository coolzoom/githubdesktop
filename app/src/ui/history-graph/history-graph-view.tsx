import * as React from 'react'
import memoizeOne from 'memoize-one'
import { CompositeDisposable, Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { Branch } from '../../models/branch'
import { Commit } from '../../models/commit'
import { Account } from '../../models/account'
import { IGraphStash } from '../../models/stash-entry'
import {
  CommittedFileChange,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { IDiff, ImageDiffType } from '../../models/diff'
import { hasStagedChanges, hasUnstagedChanges } from '../../lib/staging'
import { getStagingDiff } from '../../lib/git/staging'
import { TipState } from '../../models/tip'
import { GraphCommitOrder } from '../../lib/git/graph'
import {
  HistoryTabMode,
  IRepositoryState,
  RepositorySectionTab,
} from '../../lib/app-state'
import { Emoji } from '../../lib/emoji'
import { Dispatcher } from '../dispatcher'
import { SeamlessDiffSwitcher } from '../diff/seamless-diff-switcher'
import { DiffHeader } from '../diff/diff-header'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import {
  buildGraph,
  GraphRefKind,
  IGraphRefGroup,
  IGraphRow,
  WorkDirSha,
} from './graph-model'
import { CommitGraph } from './commit-graph'
import { CommitDetails } from './commit-details'
import {
  graphViewStore,
  IGraphRepoSettings,
  IRemoteFormRequest,
} from './graph-view-store'
import { GraphMenus } from './graph-menus'
import { RemoteForm } from './remote-form'
import { ConflictBar, getConflictInfo } from './conflict-bar'
import { MergeConflictEditor } from '../merge-conflict-editor/merge-conflict-editor'
import { IWipCommitOptions, IWipFileSelection, WipPanel } from './wip-panel'
import { WorkingFileDiff } from './working-file-diff'
import { TerminalPanel } from '../terminal-panel/terminal-panel'
import {
  getBoolean,
  getNumber,
  setBoolean,
  setNumber,
} from '../../lib/local-storage'
import { getRepositoryEditors } from '../editor/editor-store'
import { EditorTabs } from '../editor/editor-tabs'
import { CodeEditor } from '../editor/code-editor'
import { DiffRevision, RevisionDiff } from '../editor/revision-diff'
import { AppFileStatusKind } from '../../models/status'
import { DiffType } from '../../models/diff'

const MinDetailsWidth = 240
const MaxDetailsWidth = 700

interface IHistoryGraphViewProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly state: IRepositoryState
  readonly menus: GraphMenus
  readonly emoji: Map<string, Emoji>
  readonly accounts: ReadonlyArray<Account>
  readonly imageDiffType: ImageDiffType
  readonly hideWhitespaceInDiff: boolean
  readonly showSideBySideDiff: boolean
  readonly graphCommitOrder: GraphCommitOrder
  readonly onOpenBinaryFile: (fullPath: string) => void
  readonly onOpenSubmodule: (fullPath: string) => void
  readonly onChangeImageDiffType: (type: ImageDiffType) => void
  readonly onDiffOptionsOpened: () => void
  readonly onOpenInExternalEditor: (path: string) => void
  /** Select and scroll to a commit, e.g. a parent link in the details */
  readonly onSelectSha: (sha: string) => void
  /** Check out the most relevant ref of a pill that was double-clicked */
  readonly onCheckoutRefGroup: (group: IGraphRefGroup) => void
  /**
   * Whether this view replaces the Changes tab too: selecting the WIP row
   * shows the staging panel instead of switching tabs.
   */
  readonly unifiedLayout: boolean
  readonly wipOptions: IWipCommitOptions
  readonly hideWhitespaceInChangesDiff: boolean
  readonly showDiffCheckMarks: boolean
  readonly askForConfirmationOnDiscardChanges: boolean
  readonly showTerminal: boolean
  readonly onShowTerminalChanged: (show: boolean) => void
  /** Show the working directory diff of a file, e.g. picked in the explorer */
  readonly openWipFileRequest: IOpenWipFileRequest | null
  readonly externalEditorLabel?: string
}

export interface IOpenWipFileRequest {
  readonly path: string
  /** Distinguishes repeated requests for the same file */
  readonly id: number
}

interface IHistoryGraphViewState {
  readonly isDiffOpen: boolean
  readonly settings: IGraphRepoSettings
  readonly searchText: string
  readonly detailsWidth: number
  readonly remoteForm: IRemoteFormRequest | null
  /** The conflicted file open in the merge tool in place of the graph */
  readonly mergeToolPath: string | null
  /** The working directory file whose diff is open in place of the graph */
  readonly wipFile: IWipFileSelection | null
  readonly wipDiff: IDiff | null
  readonly terminalHeight: number
  /** Show text diffs in Monaco's diff editor instead of the line staging view */
  readonly useEditorDiff: boolean
  /** Bumped when the editor tabs change */
  readonly editorsVersion: number
}

const terminalHeightKey = 'terminal-panel-height'
const useEditorDiffKey = 'use-editor-diff'

/**
 * The GitKraken-style History view: the commit graph in the center (or the
 * diff of a file once one is clicked) and the commit details on the right.
 */
export class HistoryGraphView extends React.Component<
  IHistoryGraphViewProps,
  IHistoryGraphViewState
> {
  private subscription: Disposable | null = null
  private editorsSubscription: Disposable | null = null
  private resizeStart: { x: number; width: number } | null = null
  private wipDiffFor: WorkingDirectoryFileChange | null = null
  private wipDiffStaged = false
  private wipDiffRequest = 0
  /** A file to open once the WIP row is selected */
  private pendingWipPath: string | null = null

  private getStashMap = memoizeOne(
    (stashes: ReadonlyArray<IGraphStash>) =>
      new Map(stashes.map(s => [s.sha, s]))
  )

  private getStashShas = memoizeOne(
    (stashes: ReadonlyArray<IGraphStash>) => new Set(stashes.map(s => s.sha))
  )

  private getGraph = memoizeOne(
    (
      commitSHAs: ReadonlyArray<string>,
      commitLookup: Map<string, Commit>,
      stashes: ReadonlyArray<IGraphStash>,
      branches: ReadonlyArray<Branch>,
      tags: Map<string, string> | null,
      headSha: string | null,
      currentBranchName: string | null,
      workDirChangeCount: number,
      settings: IGraphRepoSettings,
      searchText: string
    ) =>
      buildGraph({
        commitSHAs,
        commitLookup,
        stashShas: this.getStashShas(stashes),
        branches,
        tags,
        headSha,
        currentBranchName,
        workDirChangeCount,
        hiddenRefs: new Set(settings.hiddenRefs),
        soloRefs: new Set(settings.soloRefs),
        pinnedRef: settings.pinnedRef,
        searchText,
      })
  )

  private getConflictInfo = memoizeOne(getConflictInfo)

  private getMergeablePaths = memoizeOne(
    (info: ReturnType<typeof getConflictInfo>): ReadonlySet<string> =>
      new Set(info?.files.filter(f => f.canMerge).map(f => f.path) ?? [])
  )

  private readonly wipSelection: ReadonlyArray<string> = [WorkDirSha]

  public constructor(props: IHistoryGraphViewProps) {
    super(props)
    this.state = this.storeState()
  }

  private storeState(): IHistoryGraphViewState {
    const { id } = this.props.repository
    return {
      isDiffOpen: this.state?.isDiffOpen ?? false,
      mergeToolPath: this.state?.mergeToolPath ?? null,
      wipFile: this.state?.wipFile ?? null,
      wipDiff: this.state?.wipDiff ?? null,
      terminalHeight:
        this.state?.terminalHeight ?? getNumber(terminalHeightKey, 240),
      useEditorDiff:
        this.state?.useEditorDiff ?? getBoolean(useEditorDiffKey, true),
      editorsVersion: this.state?.editorsVersion ?? 0,
      settings: graphViewStore.getSettings(id),
      searchText: graphViewStore.getSearchText(id),
      detailsWidth: graphViewStore.columns.detailsWidth,
      remoteForm: graphViewStore.getRemoteForm(id),
    }
  }

  public componentDidMount() {
    this.subscription = graphViewStore.onDidUpdate(() =>
      this.setState(this.storeState())
    )
    this.subscribeToEditors()
    this.initializeHistory()
    this.refreshTracking()
  }

  private get editors() {
    return getRepositoryEditors(this.props.repository)
  }

  /** Re-render when tabs open, close or switch; tabs render the rest. */
  private subscribeToEditors() {
    this.editorsSubscription?.dispose()
    const editors = this.editors
    let tabs = editors.tabs
    let activePath = editors.activePath
    const subscription = new CompositeDisposable()
    subscription.add(
      editors.onDidChange(() => {
        if (tabs !== editors.tabs || activePath !== editors.activePath) {
          tabs = editors.tabs
          activePath = editors.activePath
          this.setState(s => ({ editorsVersion: s.editorsVersion + 1 }))
        }
      })
    )
    subscription.add(
      editors.onDidSave(() =>
        this.props.dispatcher.refreshStatus(this.props.repository)
      )
    )
    subscription.add(
      editors.onDidError(error => this.props.dispatcher.postError(error))
    )
    this.editorsSubscription = subscription
  }

  private initializeHistory() {
    this.props.dispatcher.initializeCompare(this.props.repository, {
      kind: HistoryTabMode.History,
    })
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
    this.editorsSubscription?.dispose()
    this.stopResize()
  }

  public componentDidUpdate(prevProps: IHistoryGraphViewProps) {
    const prevShas = prevProps.state.commitSelection.shas
    const shas = this.props.state.commitSelection.shas
    if (
      this.state.isDiffOpen &&
      (prevShas.length !== shas.length ||
        prevShas.some((s, i) => s !== shas[i]))
    ) {
      this.setState({ isDiffOpen: false })
    }
    if (prevProps.repository.id !== this.props.repository.id) {
      this.setState({
        ...this.storeState(),
        isDiffOpen: false,
        mergeToolPath: null,
        wipFile: null,
        wipDiff: null,
      })
      this.subscribeToEditors()
      this.initializeHistory()
    }
    if (
      prevProps.state.changesState.workingDirectory !==
      this.props.state.changesState.workingDirectory
    ) {
      this.editors.refresh()
    }
    if (
      prevProps.hideWhitespaceInChangesDiff !==
      this.props.hideWhitespaceInChangesDiff
    ) {
      this.wipDiffFor = null
    }
    const request = this.props.openWipFileRequest
    if (request !== null && request !== prevProps.openWipFileRequest) {
      this.pendingWipPath = request.path
      if (!this.isWipSelected) {
        this.props.dispatcher.changeRepositorySection(
          this.props.repository,
          RepositorySectionTab.Changes
        )
      }
    }
    this.openPendingWipFile()
    this.syncWipFile()
    this.refreshTracking()
  }

  private openPendingWipFile() {
    const path = this.pendingWipPath
    if (path === null || !this.isWipSelected) {
      return
    }
    this.pendingWipPath = null
    const { files } = this.props.state.changesState.workingDirectory
    const file = files.find(f => f.path === path)
    if (file !== undefined) {
      this.onWipFileSelected({ path, staged: !hasUnstagedChanges(file) })
    }
  }

  /** Whether the WIP row is selected and the staging panel is showing. */
  private get isWipSelected() {
    const { unifiedLayout, state } = this.props
    return (
      unifiedLayout &&
      state.selectedSection === RepositorySectionTab.Changes &&
      this.workDirChangeCount > 0
    )
  }

  private get wipWorkingFile(): WorkingDirectoryFileChange | null {
    const { wipFile } = this.state
    if (wipFile === null) {
      return null
    }
    const { files } = this.props.state.changesState.workingDirectory
    return files.find(f => f.path === wipFile.path) ?? null
  }

  /**
   * Keep the open working file valid as the status changes: follow it to the
   * other list once one half is fully staged or unstaged, close it once it
   * has no changes, and reload its diff whenever its status is refreshed.
   */
  private syncWipFile() {
    const { wipFile } = this.state
    if (wipFile === null) {
      return
    }
    const file = this.wipWorkingFile
    if (file === null || !this.isWipSelected) {
      this.closeWipFile()
      return
    }

    const hasSide = (staged: boolean) =>
      staged ? hasStagedChanges(file) : hasUnstagedChanges(file)
    if (!hasSide(wipFile.staged)) {
      if (hasSide(!wipFile.staged)) {
        this.setState({ wipFile: { path: file.path, staged: !wipFile.staged } })
      } else {
        this.closeWipFile()
      }
      return
    }

    if (file !== this.wipDiffFor || wipFile.staged !== this.wipDiffStaged) {
      this.loadWipDiff(file, wipFile.staged)
    }
  }

  private async loadWipDiff(file: WorkingDirectoryFileChange, staged: boolean) {
    this.wipDiffFor = file
    this.wipDiffStaged = staged
    const request = ++this.wipDiffRequest
    const { repository, hideWhitespaceInChangesDiff } = this.props
    let diff: IDiff | null = null
    try {
      diff = await getStagingDiff(
        repository,
        file,
        staged,
        hideWhitespaceInChangesDiff
      )
    } catch (e) {
      log.error(`Failed to load the diff of ${file.path}`, e)
    }
    if (request === this.wipDiffRequest) {
      this.setState({ wipDiff: diff })
    }
  }

  private closeWipFile = () => {
    this.wipDiffFor = null
    this.wipDiffRequest++
    this.setState({ wipFile: null, wipDiff: null })
  }

  private onWipFileSelected = (selection: IWipFileSelection) => {
    this.showGraph()
    const { wipFile } = this.state
    const isSame =
      wipFile?.path === selection.path && wipFile.staged === selection.staged
    this.setState({
      wipFile: selection,
      wipDiff: isSame ? this.state.wipDiff : null,
      isDiffOpen: false,
      mergeToolPath: null,
    })
  }

  /** Leave the editor tabs for the graph, e.g. once a commit is picked. */
  private showGraph() {
    if (this.editors.activePath !== null) {
      this.editors.activate(null)
    }
  }

  private refreshTracking() {
    const key = this.props.state.compareState.tip
    if (key !== null) {
      graphViewStore.refreshTracking(this.props.repository, key)
    }
  }

  private get headSha() {
    const { tip } = this.props.state.branchesState
    if (tip.kind === TipState.Valid) {
      return tip.branch.tip.sha
    }
    return tip.kind === TipState.Detached ? tip.currentSha : null
  }

  private get currentBranchName() {
    const { tip } = this.props.state.branchesState
    return tip.kind === TipState.Valid ? tip.branch.name : null
  }

  private get workDirChangeCount() {
    return this.props.state.changesState.workingDirectory.files.length
  }

  private get graph() {
    const { state } = this.props
    return this.getGraph(
      state.compareState.commitSHAs,
      state.commitLookup,
      state.graphStashes,
      state.branchesState.allBranches,
      state.localTags,
      this.headSha,
      this.currentBranchName,
      this.workDirChangeCount,
      this.state.settings,
      this.state.searchText
    )
  }

  private onSearchTextChanged = (text: string) => {
    graphViewStore.setSearchText(this.props.repository.id, text)
  }

  private onSelectionChanged = (
    shas: ReadonlyArray<string>,
    isContiguous: boolean
  ) => {
    this.showGraph()
    const { dispatcher, repository, unifiedLayout, state } = this.props
    if (
      unifiedLayout &&
      state.selectedSection === RepositorySectionTab.Changes
    ) {
      dispatcher.changeRepositorySection(
        repository,
        RepositorySectionTab.History
      )
    }
    dispatcher.changeCommitSelection(repository, shas, isContiguous)
    dispatcher.loadChangedFilesForCurrentSelection(repository)
  }

  private onWorkDirSelected = () => {
    this.showGraph()
    this.props.dispatcher.changeRepositorySection(
      this.props.repository,
      RepositorySectionTab.Changes
    )
  }

  private onLoadMore = () => {
    this.props.dispatcher.loadNextCommitBatch(this.props.repository)
  }

  private onRowContextMenu = (row: IGraphRow) => {
    this.props.menus.showRowMenu(row, this.props.state.commitSelection.shas)
  }

  private onRefContextMenu = (row: IGraphRow, group: IGraphRefGroup) => {
    this.props.menus.showRefGroupMenu(row, group)
  }

  private onRefDoubleClick = (_row: IGraphRow, group: IGraphRefGroup) => {
    this.props.onCheckoutRefGroup(group)
  }

  private onFileSelected = (file: CommittedFileChange) => {
    this.showGraph()
    this.props.dispatcher.changeFileSelection(this.props.repository, file)
    this.setState({ isDiffOpen: true })
  }

  private onFileDoubleClick = (file: CommittedFileChange) => {
    this.props.onOpenInExternalEditor(file.path)
  }

  private onFileContextMenu = (
    file: CommittedFileChange,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    const { shas } = this.props.state.commitSelection
    const commit =
      shas.length === 1
        ? this.props.state.commitLookup.get(shas[0]) ?? null
        : null
    this.props.menus.showFileMenu(file, commit)
  }

  private onTreeViewChanged = (treeView: boolean) => {
    graphViewStore.updateSettings(this.props.repository.id, { treeView })
  }

  private closeDiff = () => {
    this.setState({ isDiffOpen: false })
  }

  private onHideWhitespaceInDiffChanged = (hide: boolean) => {
    return this.props.dispatcher.onHideWhitespaceInHistoryDiffChanged(
      hide,
      this.props.repository,
      this.props.state.commitSelection.file
    )
  }

  private onShowSideBySideDiffChanged = (showSideBySideDiff: boolean) => {
    this.props.dispatcher.onShowSideBySideDiffChanged(showSideBySideDiff)
  }

  private onResizeStart = (event: React.MouseEvent) => {
    event.preventDefault()
    this.resizeStart = { x: event.clientX, width: this.state.detailsWidth }
    document.addEventListener('mousemove', this.onResizeMove)
    document.addEventListener('mouseup', this.stopResize)
  }

  private onResizeMove = (event: MouseEvent) => {
    if (this.resizeStart === null) {
      return
    }
    const width = Math.min(
      MaxDetailsWidth,
      Math.max(
        MinDetailsWidth,
        this.resizeStart.width - (event.clientX - this.resizeStart.x)
      )
    )
    graphViewStore.updateColumns({ detailsWidth: Math.round(width) })
  }

  private stopResize = () => {
    this.resizeStart = null
    document.removeEventListener('mousemove', this.onResizeMove)
    document.removeEventListener('mouseup', this.stopResize)
  }

  private onResizeReset = () => {
    graphViewStore.updateColumns({ detailsWidth: 340 })
  }

  private renderDiff() {
    const { commitSelection } = this.props.state
    const { file, diff } = commitSelection
    if (file === null) {
      return null
    }
    const revisions = this.commitDiffRevisions
    return (
      <div className="center-diff">
        <div className="center-diff-header">
          <button
            className="close-diff"
            onClick={this.closeDiff}
            aria-label="Back to graph"
          >
            <Octicon symbol={octicons.x} />
          </button>
          <DiffHeader
            diff={diff}
            path={file.path}
            status={file.status}
            showSideBySideDiff={this.props.showSideBySideDiff}
            onShowSideBySideDiffChanged={this.onShowSideBySideDiffChanged}
            hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
            onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
            onDiffOptionsOpened={this.props.onDiffOptionsOpened}
          />
          {revisions !== null && this.renderDiffStyleToggle()}
        </div>
        {revisions !== null && this.state.useEditorDiff ? (
          <RevisionDiff
            repository={this.props.repository}
            path={file.path}
            original={revisions.original}
            modified={revisions.modified}
            sideBySide={this.props.showSideBySideDiff}
            ignoreTrimWhitespace={this.props.hideWhitespaceInDiff}
          />
        ) : (
          this.renderClassicCommitDiff()
        )}
      </div>
    )
  }

  private onToggleEditorDiff = () => {
    const useEditorDiff = !this.state.useEditorDiff
    setBoolean(useEditorDiffKey, useEditorDiff)
    this.setState({ useEditorDiff })
  }

  /** Switch between Monaco's diff and the classic one, which stages lines. */
  private renderDiffStyleToggle() {
    const { useEditorDiff } = this.state
    return (
      <button
        type="button"
        className="diff-style-toggle"
        aria-pressed={useEditorDiff}
        onClick={this.onToggleEditorDiff}
      >
        <Octicon
          symbol={useEditorDiff ? octicons.listUnordered : octicons.code}
        />
        {useEditorDiff ? 'Classic Diff' : 'Editor Diff'}
      </button>
    )
  }

  /** The two versions of the selected commit's file for the editor diff. */
  private get commitDiffRevisions(): {
    original: DiffRevision
    modified: DiffRevision
  } | null {
    const { commitSelection, graphStashes } = this.props.state
    const { file, diff, shas } = commitSelection
    if (
      file === null ||
      diff === null ||
      diff.kind !== DiffType.Text ||
      shas.length !== 1 ||
      this.getStashMap(graphStashes).has(shas[0])
    ) {
      return null
    }
    const sha = shas[0]
    const { status } = file
    const oldPath =
      status.kind === AppFileStatusKind.Renamed ||
      status.kind === AppFileStatusKind.Copied
        ? status.oldPath
        : file.path
    return {
      original:
        status.kind === AppFileStatusKind.New
          ? { kind: 'empty' }
          : { kind: 'commit', commitish: `${sha}^`, path: oldPath },
      modified:
        status.kind === AppFileStatusKind.Deleted
          ? { kind: 'empty' }
          : { kind: 'commit', commitish: sha, path: file.path },
    }
  }

  private renderClassicCommitDiff() {
    const { file, diff } = this.props.state.commitSelection
    if (file === null) {
      return null
    }
    return (
      <SeamlessDiffSwitcher
        repository={this.props.repository}
        imageDiffType={this.props.imageDiffType}
        file={file}
        diff={diff}
        readOnly={true}
        hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
        showDiffCheckMarks={false}
        showSideBySideDiff={this.props.showSideBySideDiff}
        onOpenBinaryFile={this.props.onOpenBinaryFile}
        onChangeImageDiffType={this.props.onChangeImageDiffType}
        onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
        onOpenSubmodule={this.props.onOpenSubmodule}
      />
    )
  }

  private onCommitOrderChanged = (order: GraphCommitOrder) => {
    this.props.dispatcher.setGraphCommitOrder(this.props.repository, order)
  }

  private onStashClick = () => {
    this.props.menus.stashChanges()
  }

  private onPopStashClick = () => {
    this.props.menus.popLatestStash()
  }

  private renderGraph() {
    const { state, repository } = this.props
    const graph = this.graph
    return (
      <CommitGraph
        graph={graph}
        commitLookup={state.commitLookup}
        stashes={this.getStashMap(state.graphStashes)}
        selectedShas={
          this.isWipSelected ? this.wipSelection : state.commitSelection.shas
        }
        emoji={this.props.emoji}
        accounts={this.props.accounts}
        gitHubRepository={repository.gitHubRepository}
        workDirChangeCount={this.workDirChangeCount}
        tracking={graphViewStore.getTracking(repository.id)}
        commitOrder={this.props.graphCommitOrder}
        onCommitOrderChanged={this.onCommitOrderChanged}
        canPopStash={state.graphStashes.length > 0}
        onStash={this.onStashClick}
        onPopStash={this.onPopStashClick}
        isTerminalVisible={this.props.showTerminal}
        onToggleTerminal={this.onToggleTerminal}
        loadedCount={state.compareState.commitSHAs.length}
        searchText={this.state.searchText}
        onSearchTextChanged={this.onSearchTextChanged}
        onSelectionChanged={this.onSelectionChanged}
        onWorkDirSelected={this.onWorkDirSelected}
        onLoadMore={this.onLoadMore}
        onRowContextMenu={this.onRowContextMenu}
        onRefContextMenu={this.onRefContextMenu}
        onRefDoubleClick={this.onRefDoubleClick}
      />
    )
  }

  private renderDetails() {
    const { state } = this.props
    const { commitSelection, commitLookup } = state
    const commits = commitSelection.shas
      .map(sha => commitLookup.get(sha))
      .filter((c): c is Commit => c !== undefined)
    const stash =
      commits.length === 1
        ? this.getStashMap(state.graphStashes).get(commits[0].sha) ?? null
        : null

    return (
      <div
        className="history-graph-details"
        style={{ width: this.state.detailsWidth }}
      >
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className="details-resize-handle"
          onMouseDown={this.onResizeStart}
          onDoubleClick={this.onResizeReset}
        />
        {this.isWipSelected
          ? this.renderWipPanel()
          : this.renderCommitDetails(commits, stash)}
      </div>
    )
  }

  private renderWipPanel() {
    return (
      <WipPanel
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
        state={this.props.state}
        menus={this.props.menus}
        emoji={this.props.emoji}
        accounts={this.props.accounts}
        options={this.props.wipOptions}
        selectedFile={this.state.wipFile}
        mergeablePaths={this.getMergeablePaths(this.conflictInfo)}
        onFileSelected={this.onWipFileSelected}
        onOpenMergeTool={this.onOpenConflictFile}
      />
    )
  }

  private renderCommitDetails(
    commits: ReadonlyArray<Commit>,
    stash: IGraphStash | null
  ) {
    const { state, repository } = this.props
    const { commitSelection } = state
    return (
      <CommitDetails
        repository={repository}
        commits={commits}
        isContiguous={commitSelection.isContiguous}
        changesetData={commitSelection.changesetData}
        selectedFile={commitSelection.file}
        isDiffOpen={this.state.isDiffOpen}
        stash={stash}
        emoji={this.props.emoji}
        accounts={this.props.accounts}
        treeView={this.state.settings.treeView}
        onTreeViewChanged={this.onTreeViewChanged}
        onFileSelected={this.onFileSelected}
        onFileDoubleClick={this.onFileDoubleClick}
        onFileContextMenu={this.onFileContextMenu}
        onCommitShaClicked={this.props.onSelectSha}
      />
    )
  }

  private get conflictInfo() {
    const { changesState, multiCommitOperationState } = this.props.state
    return this.getConflictInfo(
      changesState.conflictState,
      multiCommitOperationState,
      changesState.workingDirectory
    )
  }

  private onOpenConflictFile = (path: string) => {
    const file = this.conflictInfo?.files.find(f => f.path === path)
    if (file === undefined) {
      return
    }
    if (!file.canMerge) {
      this.onShowConflictsDialog()
      return
    }
    this.setState({ mergeToolPath: path, isDiffOpen: false })
  }

  private onCloseMergeTool = () => {
    this.setState({ mergeToolPath: null })
  }

  private onShowConflictsDialog = () => {
    const { dispatcher, repository } = this.props
    if (!dispatcher.showConflictsDialog(repository)) {
      dispatcher.changeRepositorySection(
        repository,
        RepositorySectionTab.Changes
      )
    }
  }

  private renderConflictBar() {
    const info = this.conflictInfo
    if (info === null) {
      return null
    }
    return (
      <ConflictBar
        info={info}
        openPath={this.state.mergeToolPath}
        onOpenFile={this.onOpenConflictFile}
        onShowDialog={this.onShowConflictsDialog}
      />
    )
  }

  private renderMergeTool(path: string) {
    const info = this.conflictInfo
    return (
      <MergeConflictEditor
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
        path={path}
        ourBranch={info?.ourBranch}
        theirBranch={info?.theirBranch}
        onClose={this.onCloseMergeTool}
      />
    )
  }

  private renderWorkingFileDiff(
    file: WorkingDirectoryFileChange,
    staged: boolean
  ) {
    return (
      <WorkingFileDiff
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
        file={file}
        staged={staged}
        diff={this.state.wipDiff}
        isCommitting={this.props.state.isCommitting}
        imageDiffType={this.props.imageDiffType}
        hideWhitespaceInDiff={this.props.hideWhitespaceInChangesDiff}
        showSideBySideDiff={this.props.showSideBySideDiff}
        showDiffCheckMarks={this.props.showDiffCheckMarks}
        askForConfirmationOnDiscardChanges={
          this.props.askForConfirmationOnDiscardChanges
        }
        onOpenBinaryFile={this.props.onOpenBinaryFile}
        onOpenSubmodule={this.props.onOpenSubmodule}
        onChangeImageDiffType={this.props.onChangeImageDiffType}
        onDiffOptionsOpened={this.props.onDiffOptionsOpened}
        onClose={this.closeWipFile}
        editors={this.editors}
        useEditorDiff={this.state.useEditorDiff}
        diffStyleToggle={this.renderDiffStyleToggle()}
      />
    )
  }

  private renderCenter() {
    const { mergeToolPath } = this.state
    if (mergeToolPath !== null && this.conflictInfo !== null) {
      return this.renderMergeTool(mergeToolPath)
    }
    const wipFile = this.isWipSelected ? this.wipWorkingFile : null
    if (wipFile !== null && this.state.wipFile !== null) {
      return this.renderWorkingFileDiff(wipFile, this.state.wipFile.staged)
    }
    const showDiff =
      this.state.isDiffOpen && this.props.state.commitSelection.file !== null
    return showDiff ? this.renderDiff() : this.renderGraph()
  }

  /**
   * The editor tabs once a file is open, keeping the graph mounted behind
   * them so it keeps its scroll position.
   */
  private renderMain() {
    const editors = this.editors
    const tab = editors.activeTab
    return (
      <>
        {editors.tabs.length > 0 && (
          <EditorTabs
            editors={editors}
            externalEditorLabel={this.props.externalEditorLabel}
            onOpenInExternalEditor={this.props.onOpenInExternalEditor}
          />
        )}
        <div className="history-graph-tab-content" hidden={tab !== null}>
          {this.renderCenter()}
        </div>
        {tab !== null && (
          <CodeEditor
            key={tab.path}
            repository={this.props.repository}
            dispatcher={this.props.dispatcher}
            editors={editors}
            tab={tab}
            sideBySide={this.props.showSideBySideDiff}
            hideWhitespace={this.props.hideWhitespaceInChangesDiff}
            externalEditorLabel={this.props.externalEditorLabel}
            onOpenInExternalEditor={this.props.onOpenInExternalEditor}
          />
        )}
      </>
    )
  }

  private onCloseRemoteForm = () => {
    graphViewStore.closeRemoteForm(this.props.repository.id)
  }

  private renderRemoteForm() {
    const { remoteForm } = this.state
    if (remoteForm === null) {
      return null
    }
    return (
      <RemoteForm
        key={remoteForm.nonce}
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
        remotes={this.props.state.remotes}
        remote={remoteForm.remote}
        onClose={this.onCloseRemoteForm}
      />
    )
  }

  private onTerminalHeightChanged = (terminalHeight: number) => {
    this.setState({ terminalHeight })
    setNumber(terminalHeightKey, terminalHeight)
  }

  private onToggleTerminal = () => {
    this.props.onShowTerminalChanged(!this.props.showTerminal)
  }

  private onCloseTerminal = () => {
    this.props.onShowTerminalChanged(false)
  }

  private renderTerminal() {
    if (!this.props.showTerminal) {
      return null
    }
    return (
      <TerminalPanel
        path={this.props.repository.path}
        height={this.state.terminalHeight}
        onHeightChanged={this.onTerminalHeightChanged}
        onClose={this.onCloseTerminal}
      />
    )
  }

  public render() {
    return (
      <div id="history-graph-view" className="gk-theme">
        <div className="history-graph-center">
          {this.renderRemoteForm()}
          {this.renderConflictBar()}
          <div className="history-graph-main">{this.renderMain()}</div>
          {this.renderTerminal()}
        </div>
        {this.renderDetails()}
      </div>
    )
  }
}

/** The ref of a pill that double-click should check out. */
export function primaryRef(group: IGraphRefGroup) {
  return (
    group.refs.find(r => r.kind === GraphRefKind.Local) ??
    group.refs.find(r => r.kind === GraphRefKind.Remote) ??
    group.refs[0]
  )
}
