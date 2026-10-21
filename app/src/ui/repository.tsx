import * as React from 'react'
import { Repository } from '../models/repository'
import { CommitOneLine } from '../models/commit'
import { TipState } from '../models/tip'
import { UiView } from './ui-view'
import { Changes, ChangesSidebar } from './changes'
import { NoChanges } from './changes/no-changes'
import { MultipleSelection } from './changes/multiple-selection'
import { FilesChangedBadge } from './changes/files-changed-badge'
import { RefPanel, RefPanelSection } from './history-graph/ref-panel'
import {
  HistoryGraphView,
  primaryRef,
} from './history-graph/history-graph-view'
import { GraphMenus, IGraphMenuContext } from './history-graph/graph-menus'
import { IGraphRef, IGraphRefGroup } from './history-graph/graph-model'
import { graphViewStore } from './history-graph/graph-view-store'
import { IRemote } from '../models/remote'
import { IGraphStash } from '../models/stash-entry'
import { Resizable } from './resizable'
import { TabBar } from './tab-bar'
import {
  IRepositoryState,
  RepositorySectionTab,
  ChangesSelectionKind,
  IConstrainedValue,
  CommitOptions,
} from '../lib/app-state'
import { Dispatcher } from './dispatcher'
import { IssuesStore, GitHubUserStore } from '../lib/stores'
import { assertNever } from '../lib/fatal-error'
import { Account } from '../models/account'
import { FocusContainer } from './lib/focus-container'
import { ImageDiffType } from '../models/diff'
import { IMenu } from '../models/app-menu'
import { StashDiffViewer } from './stashing'
import { StashedChangesLoadStates } from '../models/stash-entry'
import { TutorialPanel, TutorialWelcome, TutorialDone } from './tutorial'
import { TutorialStep, isValidTutorialStep } from '../models/tutorial-step'
import { openFile } from './lib/open-file'
import { PullRequestSuggestedNextAction } from '../models/pull-request'
import { clamp } from '../lib/clamp'
import { Emoji } from '../lib/emoji'
import { PopupType } from '../models/popup'

interface IRepositoryViewProps {
  readonly repository: Repository
  readonly state: IRepositoryState
  readonly dispatcher: Dispatcher
  readonly emoji: Map<string, Emoji>
  readonly sidebarWidth: IConstrainedValue
  readonly stashedFilesWidth: IConstrainedValue
  readonly issuesStore: IssuesStore
  readonly gitHubUserStore: GitHubUserStore
  readonly onViewCommitOnGitHub: (SHA: string, filePath?: string) => void
  readonly imageDiffType: ImageDiffType
  readonly hideWhitespaceInChangesDiff: boolean
  readonly hideWhitespaceInHistoryDiff: boolean
  readonly showSideBySideDiff: boolean
  readonly showDiffCheckMarks: boolean
  readonly askForConfirmationOnDiscardChanges: boolean
  readonly askForConfirmationOnCommitFilteredChanges: boolean
  readonly askForConfirmationOnDiscardStash: boolean
  readonly askForConfirmationOnCheckoutCommit: boolean
  readonly focusCommitMessage: boolean
  readonly commitSpellcheckEnabled: boolean
  readonly showCommitLengthWarning: boolean
  readonly accounts: ReadonlyArray<Account>
  readonly shouldShowGenerateCommitMessageCallOut: boolean

  /**
   * A value indicating whether or not the application is currently presenting
   * a modal dialog such as the preferences, or an error dialog
   */
  readonly isShowingModal: boolean

  /**
   * A value indicating whether or not the application is currently presenting
   * a foldout dialog such as the file menu, or the branches dropdown
   */
  readonly isShowingFoldout: boolean

  /**
   * Whether or not the user has a configured (explicitly,
   * or automatically) external editor. Used to
   * determine whether or not to render the action for
   * opening the repository in an external editor.
   */
  readonly isExternalEditorAvailable: boolean

  /** The name of the currently selected external editor */
  readonly externalEditorLabel?: string

  /** A cached entry representing an external editor found on the user's machine */
  readonly resolvedExternalEditor: string | null

  /**
   * Callback to open a selected file using the configured external editor
   *
   * @param fullPath The full path to the file on disk
   */
  readonly onOpenInExternalEditor: (fullPath: string) => void

  /**
   * The top-level application menu item.
   */
  readonly appMenu: IMenu | undefined

  readonly currentTutorialStep: TutorialStep

  readonly onExitTutorial: () => void
  readonly onCherryPick: (
    repository: Repository,
    commits: ReadonlyArray<CommitOneLine>
  ) => void

  /** The user's preference of pull request suggested next action to use **/
  readonly pullRequestSuggestedNextAction?: PullRequestSuggestedNextAction

  /** Whether or not to show the changes filter */
  readonly showChangesFilter: boolean

  /**
   * Whether or not to skip blocking commit hooks when creating commits
   * by means of passing the `--no-verify` flag to git commit
   */
  readonly skipCommitHooks: boolean

  /**
   * Whether or not to add a `Signed-off-by` trailer to commit messages
   * by means of passing the `--signoff` flag to git commit
   */
  readonly signOffCommits: boolean

  /**
   * Whether or not to allow creating a commit without any file changes
   * by means of passing the `--allow-empty` flag to git commit.
   * This option resets to false after each commit.
   */
  readonly allowEmptyCommit: boolean

  /** Callback to set commit options for the given repository */
  readonly onUpdateCommitOptions: (
    repository: Repository,
    options: Partial<CommitOptions>
  ) => void
}

interface IRepositoryViewState {
  readonly changesListScrollTop: number
}

const enum Tab {
  Changes = 0,
  History = 1,
}

export class RepositoryView extends React.Component<
  IRepositoryViewProps,
  IRepositoryViewState
> {
  private previousSection: RepositorySectionTab =
    this.props.state.selectedSection

  private readonly changesSidebarRef = React.createRef<ChangesSidebar>()

  private focusHistoryNeeded: boolean = false
  private focusChangesNeeded: boolean = false

  private readonly graphMenus = new GraphMenus(
    (): IGraphMenuContext => ({
      repository: this.props.repository,
      dispatcher: this.props.dispatcher,
      state: this.props.state,
      askForConfirmationOnCheckoutCommit:
        this.props.askForConfirmationOnCheckoutCommit,
      externalEditorLabel: this.props.externalEditorLabel,
      onCherryPick: this.props.onCherryPick,
      onViewCommitOnGitHub: this.props.onViewCommitOnGitHub,
      onOpenInExternalEditor: this.props.onOpenInExternalEditor,
    })
  )

  public constructor(props: IRepositoryViewProps) {
    super(props)

    this.state = {
      changesListScrollTop: 0,
    }
  }

  public setFocusHistoryNeeded(): void {
    this.focusHistoryNeeded = true
  }

  public setFocusChangesNeeded(): void {
    this.focusChangesNeeded = true
  }

  public scrollCompareListToTop(): void {
    const [first] = this.props.state.compareState.commitSHAs
    if (first !== undefined) {
      graphViewStore.requestScrollTo(first)
    }
  }

  private onChangesListScrolled = (scrollTop: number) => {
    this.setState({ changesListScrollTop: scrollTop })
  }

  private renderChangesBadge(): JSX.Element | null {
    const filesChangedCount =
      this.props.state.changesState.workingDirectory.files.length

    if (filesChangedCount <= 0) {
      return null
    }

    return <FilesChangedBadge filesChangedCount={filesChangedCount} />
  }

  private renderTabs(): JSX.Element {
    const selectedTab =
      this.props.state.selectedSection === RepositorySectionTab.Changes
        ? Tab.Changes
        : Tab.History

    return (
      <TabBar selectedIndex={selectedTab} onTabClicked={this.onTabClicked}>
        <span className="with-indicator" id="changes-tab">
          <span>Changes</span>
          {this.renderChangesBadge()}
        </span>

        <div className="with-indicator" id="history-tab">
          <span>History</span>
        </div>
      </TabBar>
    )
  }

  private onShowCommitProgress = () => {
    if (!this.props.state.subscribeToCommitOutput) {
      return
    }

    this.props.dispatcher.showPopup({
      type: PopupType.CommitProgress,
      subscribeToCommitOutput: this.props.state.subscribeToCommitOutput,
    })
  }

  private renderChangesSidebar(): JSX.Element {
    const tip = this.props.state.branchesState.tip

    let branchName: string | null = null

    if (tip.kind === TipState.Valid) {
      branchName = tip.branch.name
    } else if (tip.kind === TipState.Unborn) {
      branchName = tip.ref
    }

    const localCommitSHAs = this.props.state.localCommitSHAs
    const mostRecentLocalCommitSHA =
      localCommitSHAs.length > 0 ? localCommitSHAs[0] : null
    const mostRecentLocalCommit =
      (mostRecentLocalCommitSHA
        ? this.props.state.commitLookup.get(mostRecentLocalCommitSHA)
        : null) || null

    // -1 Because of right hand side border
    const availableWidth = clamp(this.props.sidebarWidth) - 1

    const scrollTop =
      this.previousSection === RepositorySectionTab.History
        ? this.state.changesListScrollTop
        : undefined
    this.previousSection = RepositorySectionTab.Changes

    return (
      <ChangesSidebar
        ref={this.changesSidebarRef}
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
        changes={this.props.state.changesState}
        aheadBehind={this.props.state.aheadBehind}
        branch={branchName}
        commitAuthor={this.props.state.commitAuthor}
        emoji={this.props.emoji}
        mostRecentLocalCommit={mostRecentLocalCommit}
        issuesStore={this.props.issuesStore}
        availableWidth={availableWidth}
        gitHubUserStore={this.props.gitHubUserStore}
        isCommitting={this.props.state.isCommitting}
        hookProgress={this.props.state.hookProgress}
        onShowCommitProgress={
          this.props.state.subscribeToCommitOutput
            ? this.onShowCommitProgress
            : undefined
        }
        isGeneratingCommitMessage={this.props.state.isGeneratingCommitMessage}
        shouldShowGenerateCommitMessageCallOut={
          this.props.shouldShowGenerateCommitMessageCallOut
        }
        commitToAmend={this.props.state.commitToAmend}
        isPushPullFetchInProgress={this.props.state.isPushPullFetchInProgress}
        focusCommitMessage={this.props.focusCommitMessage}
        askForConfirmationOnDiscardChanges={
          this.props.askForConfirmationOnDiscardChanges
        }
        askForConfirmationOnCommitFilteredChanges={
          this.props.askForConfirmationOnCommitFilteredChanges
        }
        accounts={this.props.accounts}
        isShowingModal={this.props.isShowingModal}
        isShowingFoldout={this.props.isShowingFoldout}
        externalEditorLabel={this.props.externalEditorLabel}
        onOpenInExternalEditor={this.props.onOpenInExternalEditor}
        onChangesListScrolled={this.onChangesListScrolled}
        changesListScrollTop={scrollTop}
        shouldNudgeToCommit={
          this.props.currentTutorialStep === TutorialStep.MakeCommit
        }
        commitSpellcheckEnabled={this.props.commitSpellcheckEnabled}
        showCommitLengthWarning={this.props.showCommitLengthWarning}
        showChangesFilter={this.props.showChangesFilter}
        skipCommitHooks={this.props.skipCommitHooks}
        signOffCommits={this.props.signOffCommits}
        allowEmptyCommit={this.props.allowEmptyCommit}
        onUpdateCommitOptions={this.props.onUpdateCommitOptions}
      />
    )
  }

  private renderRefPanel(): JSX.Element {
    const { repository, state } = this.props
    const { tip, allBranches } = state.branchesState
    this.previousSection = RepositorySectionTab.History

    return (
      <RefPanel
        repository={repository}
        branches={allBranches}
        currentBranchName={tip.kind === TipState.Valid ? tip.branch.name : null}
        remotes={state.remotes}
        tags={state.localTags}
        stashes={state.graphStashes}
        onRefSelected={this.onRefSelected}
        onRefDoubleClick={this.onRefDoubleClick}
        onStashSelected={this.onStashSelected}
        onRefContextMenu={this.onRefContextMenu}
        onRemoteContextMenu={this.onRemoteContextMenu}
        onStashContextMenu={this.onStashContextMenu}
        onSectionContextMenu={this.onSectionContextMenu}
      />
    )
  }

  /** Select a commit in the graph and scroll it into view. */
  private selectSha = (sha: string) => {
    const { repository, dispatcher, state } = this.props
    if (!state.compareState.commitSHAs.includes(sha)) {
      return
    }
    dispatcher.changeCommitSelection(repository, [sha], true)
    dispatcher.loadChangedFilesForCurrentSelection(repository)
    graphViewStore.requestScrollTo(sha)
  }

  private onRefSelected = (ref: IGraphRef) => this.selectSha(ref.sha)

  private onRefDoubleClick = (ref: IGraphRef) =>
    this.graphMenus.checkoutRef(ref)

  private onCheckoutRefGroup = (group: IGraphRefGroup) =>
    this.graphMenus.checkoutRef(primaryRef(group))

  private onStashSelected = (stash: IGraphStash) => this.selectSha(stash.sha)

  private onRefContextMenu = (
    ref: IGraphRef,
    selected: ReadonlyArray<IGraphRef>
  ) => this.graphMenus.showRefMenu(ref, selected)

  private onRemoteContextMenu = (remote: IRemote) =>
    this.graphMenus.showRemoteMenu(remote)

  private onStashContextMenu = (stash: IGraphStash) =>
    this.graphMenus.showStashMenu(stash)

  private onSectionContextMenu = (
    section: RefPanelSection,
    refs: ReadonlyArray<IGraphRef>
  ) => this.graphMenus.showSectionMenu(section, refs)

  private renderSidebarContents(): JSX.Element {
    const selectedSection = this.props.state.selectedSection

    if (selectedSection === RepositorySectionTab.Changes) {
      return this.renderChangesSidebar()
    } else if (selectedSection === RepositorySectionTab.History) {
      return this.renderRefPanel()
    } else {
      return assertNever(selectedSection, 'Unknown repository section')
    }
  }

  private handleSidebarWidthReset = () => {
    this.props.dispatcher.resetSidebarWidth()
  }

  private handleSidebarResize = (width: number) => {
    this.props.dispatcher.setSidebarWidth(width)
  }

  private renderSidebar(): JSX.Element {
    return (
      <FocusContainer onFocusWithinChanged={this.onSidebarFocusWithinChanged}>
        <Resizable
          id="repository-sidebar"
          width={this.props.sidebarWidth.value}
          maximumWidth={this.props.sidebarWidth.max}
          minimumWidth={this.props.sidebarWidth.min}
          onReset={this.handleSidebarWidthReset}
          onResize={this.handleSidebarResize}
          description="Repository sidebar"
        >
          {this.renderTabs()}
          {this.renderSidebarContents()}
        </Resizable>
      </FocusContainer>
    )
  }

  private onSidebarFocusWithinChanged = (sidebarHasFocusWithin: boolean) => {
    if (
      sidebarHasFocusWithin === false &&
      this.props.state.selectedSection === RepositorySectionTab.History
    ) {
      this.props.dispatcher.updateCompareForm(this.props.repository, {
        showBranchList: false,
      })
    }
  }

  private renderStashedChangesContent(): JSX.Element | null {
    const { changesState } = this.props.state
    const { selection, stashEntry } = changesState

    if (selection.kind !== ChangesSelectionKind.Stash || stashEntry === null) {
      return null
    }

    if (stashEntry.files.kind === StashedChangesLoadStates.Loaded) {
      return (
        <StashDiffViewer
          stashEntry={stashEntry}
          selectedStashedFile={selection.selectedStashedFile}
          stashedFileDiff={selection.selectedStashedFileDiff}
          imageDiffType={this.props.imageDiffType}
          fileListWidth={this.props.stashedFilesWidth}
          repository={this.props.repository}
          dispatcher={this.props.dispatcher}
          askForConfirmationOnDiscardStash={
            this.props.askForConfirmationOnDiscardStash
          }
          showSideBySideDiff={this.props.showSideBySideDiff}
          onOpenBinaryFile={this.onOpenBinaryFile}
          onOpenSubmodule={this.onOpenSubmodule}
          onChangeImageDiffType={this.onChangeImageDiffType}
          onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
          onOpenInExternalEditor={this.props.onOpenInExternalEditor}
        />
      )
    }

    return null
  }

  private onHideWhitespaceInDiffChanged = (hideWhitespaceInDiff: boolean) => {
    return this.props.dispatcher.onHideWhitespaceInChangesDiffChanged(
      hideWhitespaceInDiff,
      this.props.repository
    )
  }

  private renderContentForHistory(): JSX.Element {
    return (
      <HistoryGraphView
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
        state={this.props.state}
        menus={this.graphMenus}
        emoji={this.props.emoji}
        accounts={this.props.accounts}
        imageDiffType={this.props.imageDiffType}
        hideWhitespaceInDiff={this.props.hideWhitespaceInHistoryDiff}
        showSideBySideDiff={this.props.showSideBySideDiff}
        onOpenBinaryFile={this.onOpenBinaryFile}
        onOpenSubmodule={this.onOpenSubmodule}
        onChangeImageDiffType={this.onChangeImageDiffType}
        onDiffOptionsOpened={this.onDiffOptionsOpened}
        onOpenInExternalEditor={this.props.onOpenInExternalEditor}
        onSelectSha={this.selectSha}
        onCheckoutRefGroup={this.onCheckoutRefGroup}
      />
    )
  }

  private onDiffOptionsOpened = () => {
    this.props.dispatcher.incrementMetric('diffOptionsViewedCount')
  }

  private onTutorialCompletionAnnounced = () => {
    this.props.dispatcher.markTutorialCompletionAsAnnounced(
      this.props.repository
    )
  }

  private renderTutorialPane(): JSX.Element {
    if (
      [TutorialStep.AllDone, TutorialStep.Announced].includes(
        this.props.currentTutorialStep
      )
    ) {
      return (
        <TutorialDone
          dispatcher={this.props.dispatcher}
          repository={this.props.repository}
          tutorialCompletionAnnounced={
            this.props.currentTutorialStep === TutorialStep.Announced
          }
          onTutorialCompletionAnnounced={this.onTutorialCompletionAnnounced}
        />
      )
    } else {
      return <TutorialWelcome />
    }
  }

  private renderContentForChanges(): JSX.Element | null {
    const { changesState } = this.props.state
    const { workingDirectory, selection } = changesState

    if (selection.kind === ChangesSelectionKind.Stash) {
      return this.renderStashedChangesContent()
    }

    const { selectedFileIDs, diff } = selection

    if (selectedFileIDs.length > 1) {
      return <MultipleSelection count={selectedFileIDs.length} />
    }

    if (workingDirectory.files.length === 0) {
      if (this.props.currentTutorialStep !== TutorialStep.NotApplicable) {
        return this.renderTutorialPane()
      } else {
        return (
          <NoChanges
            key={this.props.repository.id}
            appMenu={this.props.appMenu}
            repository={this.props.repository}
            repositoryState={this.props.state}
            isExternalEditorAvailable={this.props.isExternalEditorAvailable}
            dispatcher={this.props.dispatcher}
            pullRequestSuggestedNextAction={
              this.props.pullRequestSuggestedNextAction
            }
          />
        )
      }
    } else {
      if (selectedFileIDs.length === 0) {
        return null
      }

      const selectedFile = workingDirectory.findFileWithID(selectedFileIDs[0])

      if (selectedFile === null) {
        return null
      }

      return (
        <Changes
          repository={this.props.repository}
          dispatcher={this.props.dispatcher}
          file={selectedFile}
          diff={diff}
          isCommitting={this.props.state.isCommitting}
          imageDiffType={this.props.imageDiffType}
          hideWhitespaceInDiff={this.props.hideWhitespaceInChangesDiff}
          showSideBySideDiff={this.props.showSideBySideDiff}
          showDiffCheckMarks={this.props.showDiffCheckMarks}
          onOpenBinaryFile={this.onOpenBinaryFile}
          onOpenSubmodule={this.onOpenSubmodule}
          onChangeImageDiffType={this.onChangeImageDiffType}
          askForConfirmationOnDiscardChanges={
            this.props.askForConfirmationOnDiscardChanges
          }
          onDiffOptionsOpened={this.onDiffOptionsOpened}
        />
      )
    }
  }

  private onOpenBinaryFile = (fullPath: string) => {
    openFile(fullPath, this.props.dispatcher)
  }

  private onOpenSubmodule = (fullPath: string) => {
    this.props.dispatcher.incrementMetric('openSubmoduleFromDiffCount')
    this.props.dispatcher.openOrAddRepository(fullPath)
  }

  private onChangeImageDiffType = (imageDiffType: ImageDiffType) => {
    this.props.dispatcher.changeImageDiffType(imageDiffType)
  }

  private renderContent(): JSX.Element | null {
    const selectedSection = this.props.state.selectedSection
    if (selectedSection === RepositorySectionTab.Changes) {
      return this.renderContentForChanges()
    } else if (selectedSection === RepositorySectionTab.History) {
      return this.renderContentForHistory()
    } else {
      return assertNever(selectedSection, 'Unknown repository section')
    }
  }

  public render() {
    return (
      <UiView id="repository">
        {this.renderSidebar()}
        {this.renderContent()}
        {this.maybeRenderTutorialPanel()}
      </UiView>
    )
  }

  public componentDidMount() {
    window.addEventListener('keydown', this.onGlobalKeyDown)
  }

  public componentWillUnmount() {
    window.removeEventListener('keydown', this.onGlobalKeyDown)
  }

  public componentDidUpdate(): void {
    if (this.focusChangesNeeded) {
      this.focusChangesNeeded = false
      this.changesSidebarRef.current?.focus()
    }

    if (this.focusHistoryNeeded) {
      this.focusHistoryNeeded = false
      document
        .querySelector<HTMLElement>('#history-graph-view .graph-rows .list')
        ?.focus()
    }
  }

  private onGlobalKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) {
      return
    }

    if (this.props.isShowingModal || this.props.isShowingFoldout) {
      return
    }

    // Toggle tab selection on Ctrl+Tab. Note that we don't care
    // about the shift key here, we can get away with that as long
    // as there's only two tabs.
    if (event.ctrlKey && event.key === 'Tab') {
      this.changeTab()
      event.preventDefault()
    }
  }

  private changeTab() {
    const section =
      this.props.state.selectedSection === RepositorySectionTab.History
        ? RepositorySectionTab.Changes
        : RepositorySectionTab.History

    this.props.dispatcher.changeRepositorySection(
      this.props.repository,
      section
    )
  }

  private onTabClicked = (tab: Tab) => {
    const section =
      tab === Tab.History
        ? RepositorySectionTab.History
        : RepositorySectionTab.Changes

    this.props.dispatcher.changeRepositorySection(
      this.props.repository,
      section
    )
    if (!!section) {
      this.props.dispatcher.updateCompareForm(this.props.repository, {
        showBranchList: false,
      })
    }
  }

  private maybeRenderTutorialPanel(): JSX.Element | null {
    if (isValidTutorialStep(this.props.currentTutorialStep)) {
      return (
        <TutorialPanel
          dispatcher={this.props.dispatcher}
          repository={this.props.repository}
          resolvedExternalEditor={this.props.resolvedExternalEditor}
          currentTutorialStep={this.props.currentTutorialStep}
          onExitTutorial={this.props.onExitTutorial}
        />
      )
    }
    return null
  }
}
