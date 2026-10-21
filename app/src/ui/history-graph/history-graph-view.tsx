import * as React from 'react'
import memoizeOne from 'memoize-one'
import { Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { Branch } from '../../models/branch'
import { Commit } from '../../models/commit'
import { Account } from '../../models/account'
import { IGraphStash } from '../../models/stash-entry'
import { CommittedFileChange } from '../../models/status'
import { ImageDiffType } from '../../models/diff'
import { TipState } from '../../models/tip'
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
  readonly onOpenBinaryFile: (fullPath: string) => void
  readonly onOpenSubmodule: (fullPath: string) => void
  readonly onChangeImageDiffType: (type: ImageDiffType) => void
  readonly onDiffOptionsOpened: () => void
  readonly onOpenInExternalEditor: (path: string) => void
  /** Select and scroll to a commit, e.g. a parent link in the details */
  readonly onSelectSha: (sha: string) => void
  /** Check out the most relevant ref of a pill that was double-clicked */
  readonly onCheckoutRefGroup: (group: IGraphRefGroup) => void
}

interface IHistoryGraphViewState {
  readonly isDiffOpen: boolean
  readonly settings: IGraphRepoSettings
  readonly searchText: string
  readonly detailsWidth: number
  readonly remoteForm: IRemoteFormRequest | null
}

/**
 * The GitKraken-style History view: the commit graph in the center (or the
 * diff of a file once one is clicked) and the commit details on the right.
 */
export class HistoryGraphView extends React.Component<
  IHistoryGraphViewProps,
  IHistoryGraphViewState
> {
  private subscription: Disposable | null = null
  private resizeStart: { x: number; width: number } | null = null

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

  public constructor(props: IHistoryGraphViewProps) {
    super(props)
    this.state = this.storeState()
  }

  private storeState(): IHistoryGraphViewState {
    const { id } = this.props.repository
    return {
      isDiffOpen: this.state?.isDiffOpen ?? false,
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
    this.initializeHistory()
    this.refreshTracking()
  }

  private initializeHistory() {
    this.props.dispatcher.initializeCompare(this.props.repository, {
      kind: HistoryTabMode.History,
    })
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
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
      this.setState({ ...this.storeState(), isDiffOpen: false })
      this.initializeHistory()
    }
    this.refreshTracking()
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
    const { dispatcher, repository } = this.props
    dispatcher.changeCommitSelection(repository, shas, isContiguous)
    dispatcher.loadChangedFilesForCurrentSelection(repository)
  }

  private onWorkDirSelected = () => {
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
        </div>
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
      </div>
    )
  }

  private renderGraph() {
    const { state, repository } = this.props
    const graph = this.graph
    return (
      <CommitGraph
        graph={graph}
        commitLookup={state.commitLookup}
        stashes={this.getStashMap(state.graphStashes)}
        selectedShas={state.commitSelection.shas}
        emoji={this.props.emoji}
        accounts={this.props.accounts}
        gitHubRepository={repository.gitHubRepository}
        workDirChangeCount={this.workDirChangeCount}
        tracking={graphViewStore.getTracking(repository.id)}
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
    const { state, repository } = this.props
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
      </div>
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

  public render() {
    const showDiff =
      this.state.isDiffOpen && this.props.state.commitSelection.file !== null
    return (
      <div id="history-graph-view" className="gk-theme">
        <div className="history-graph-center">
          {this.renderRemoteForm()}
          {showDiff ? this.renderDiff() : this.renderGraph()}
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
