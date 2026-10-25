import * as Path from 'path'
import { Repository } from '../../models/repository'
import { Branch, BranchType } from '../../models/branch'
import { Commit, CommitOneLine } from '../../models/commit'
import { IRemote } from '../../models/remote'
import { IGraphStash } from '../../models/stash-entry'
import {
  CommittedFileChange,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { TipState } from '../../models/tip'
import { PopupType } from '../../models/popup'
import { FetchType } from '../../models/fetch'
import { IRepositoryState, RepositorySectionTab } from '../../lib/app-state'
import { IMenuItem, showContextualMenu } from '../../lib/menu-item'
import { GitResetMode, getCommitsBetweenCommits } from '../../lib/git'
import { getDotComAPIEndpoint } from '../../lib/api'
import { revealInFileManager } from '../../lib/app-shell'
import { pathExists } from '../../lib/path-exists'
import { getUniqueCoauthorsAsAuthors } from '../../lib/unique-coauthors-as-authors'
import { getSquashedCommitDescription } from '../../lib/squash/squashed-commit-description'
import { ICommitContext } from '../../models/commit'
import { Dispatcher } from '../dispatcher'
import { writeClipboardText } from '../main-process-proxy'
import { openFile } from '../lib/open-file'
import {
  CopyFilePathLabel,
  CopyRelativeFilePathLabel,
  DefaultEditorLabel,
  isSafeFileExtension,
  OpenWithDefaultProgramLabel,
  RevealInFileManagerLabel,
} from '../lib/context-menu'
import {
  getRefsBySha,
  GraphRefKind,
  GraphRowType,
  IGraphRef,
  IGraphRefGroup,
  IGraphRow,
} from './graph-model'
import { graphViewStore } from './graph-view-store'
import * as actions from './graph-git-actions'
import * as wip from './wip-actions'
import { RefPanelSection } from './ref-panel'

/** Everything the graph's context menus need from the repository view. */
export interface IGraphMenuContext {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly state: IRepositoryState
  readonly askForConfirmationOnCheckoutCommit: boolean
  readonly askForConfirmationOnDiscardChanges: boolean
  readonly externalEditorLabel?: string
  readonly onCherryPick: (
    repository: Repository,
    commits: ReadonlyArray<CommitOneLine>
  ) => void
  readonly onViewCommitOnGitHub: (sha: string, filePath?: string) => void
  /** Opens a path relative to the repository root in the external editor */
  readonly onOpenInExternalEditor: (path: string) => void
}

const separator: IMenuItem = { type: 'separator' }

const t = (mac: string, other: string) => (__DARWIN__ ? mac : other)

/** Drop leading, trailing and doubled separators. */
function tidy(items: ReadonlyArray<IMenuItem>): IMenuItem[] {
  const result: IMenuItem[] = []
  for (const item of items) {
    if (item.type === 'separator') {
      if (
        result.length === 0 ||
        result[result.length - 1].type === 'separator'
      ) {
        continue
      }
    }
    result.push(item)
  }
  while (result.length > 0 && result[result.length - 1].type === 'separator') {
    result.pop()
  }
  return result
}

function show(items: ReadonlyArray<IMenuItem>) {
  const tidied = tidy(items)
  if (tidied.length > 0) {
    showContextualMenu(tidied)
  }
}

/**
 * Builds the GitKraken-style context menus of the commit graph and the ref
 * panel and carries out their actions.
 */
export class GraphMenus {
  public constructor(private readonly getContext: () => IGraphMenuContext) {}

  private get ctx() {
    return this.getContext()
  }

  private get currentBranch(): Branch | null {
    const { tip } = this.ctx.state.branchesState
    return tip.kind === TipState.Valid ? tip.branch : null
  }

  private get headSha(): string | null {
    const { tip } = this.ctx.state.branchesState
    if (tip.kind === TipState.Valid) {
      return tip.branch.tip.sha
    }
    if (tip.kind === TipState.Detached) {
      return tip.currentSha
    }
    return null
  }

  private get remotes(): ReadonlyArray<IRemote> {
    return this.ctx.state.remotes
  }

  private get defaultRemote(): IRemote | null {
    return this.ctx.state.remote ?? this.remotes[0] ?? null
  }

  private remoteNamed(name: string | null): IRemote | null {
    return this.remotes.find(r => r.name === name) ?? null
  }

  private run(fn: () => Promise<unknown>) {
    const { dispatcher, repository } = this.ctx
    return actions.runGraphAction(dispatcher, repository, fn)
  }

  public stashChanges() {
    const { repository } = this.ctx
    return this.run(() => actions.stashAllChanges(repository))
  }

  public popLatestStash() {
    const { repository, state } = this.ctx
    const latest = state.graphStashes[0]
    if (latest === undefined) {
      return
    }
    return this.run(() => actions.popStashUnstaged(repository, latest.name))
  }

  private confirm(message: string) {
    return window.confirm(message)
  }

  /**
   * The current branch's first-parent history (newest first) as far as it is
   * loaded, cut off at the first merge commit since commits past it can't be
   * rewritten by replaying a linear history.
   */
  private get rewritableChain(): ReadonlyArray<Commit> {
    const { commitLookup } = this.ctx.state
    const chain: Commit[] = []
    if (this.currentBranch === null) {
      return chain
    }
    let sha: string | undefined = this.headSha ?? undefined
    while (sha !== undefined) {
      const commit = commitLookup.get(sha)
      if (commit === undefined || commit.parentSHAs.length > 1) {
        break
      }
      chain.push(commit)
      sha = commit.parentSHAs[0]
    }
    return chain
  }

  private lookupCommits(shas: ReadonlyArray<string>) {
    const { commitLookup } = this.ctx.state
    return shas
      .map(s => commitLookup.get(s))
      .filter((c): c is Commit => c !== undefined)
  }

  // --- Entry points -------------------------------------------------------

  /** Right-click on a graph row. */
  public showRowMenu(row: IGraphRow, selectedShas: ReadonlyArray<string>) {
    if (row.type === GraphRowType.WorkDir) {
      return this.showWorkDirMenu()
    }
    if (row.type === GraphRowType.Stash) {
      const stash = this.ctx.state.graphStashes.find(s => s.sha === row.sha)
      return stash === undefined ? undefined : this.showStashMenu(stash)
    }
    const shas = selectedShas.filter(s => this.ctx.state.commitLookup.has(s))
    if (shas.length > 1 && shas.includes(row.sha)) {
      return this.showMultiCommitMenu(this.lookupCommits(shas))
    }
    const commit = this.ctx.state.commitLookup.get(row.sha)
    if (commit !== undefined) {
      show(
        this.commitMenu(
          commit,
          row.refGroups.flatMap(g => g.refs)
        )
      )
    }
  }

  /** Right-click on a ref pill in the graph. */
  public showRefGroupMenu(row: IGraphRow, group: IGraphRefGroup) {
    const commit = this.ctx.state.commitLookup.get(row.sha)
    if (commit !== undefined) {
      show(this.commitMenu(commit, group.refs))
    }
  }

  /** Right-click on a branch or tag in the ref panel. */
  public showRefMenu(ref: IGraphRef, selected: ReadonlyArray<IGraphRef>) {
    if (selected.length > 1) {
      return this.showMultiRefMenu(selected)
    }
    const commit = this.ctx.state.commitLookup.get(ref.sha)
    if (commit !== undefined) {
      show(this.commitMenu(commit, [ref]))
    } else {
      // The tip isn't loaded in the graph yet; offer the ref actions only.
      show([...this.refItems(ref), separator, ...this.viewItems([ref])])
    }
  }

  // --- Commit menu ----------------------------------------------------------

  private commitMenu(commit: Commit, refs: ReadonlyArray<IGraphRef>) {
    const items: IMenuItem[] = []
    const local = refs.filter(r => r.kind === GraphRefKind.Local)
    const remote = refs.filter(r => r.kind === GraphRefKind.Remote)
    const tags = refs.filter(r => r.kind === GraphRefKind.Tag)

    for (const ref of [...local, ...remote]) {
      items.push(...this.refItems(ref), separator)
    }
    for (const tag of tags) {
      items.push(...this.tagItems(tag), separator)
    }

    items.push(...this.commitItems(commit), separator)
    items.push(...this.rewriteItems(commit), separator)
    items.push(...this.copyItems(commit, refs), separator)
    if (refs.length > 0) {
      items.push(...this.viewItems(refs), separator)
    }
    items.push(...this.gitHubItems(commit))
    return items
  }

  private commitItems(commit: Commit): IMenuItem[] {
    const { repository, dispatcher, state } = this.ctx
    const current = this.currentBranch
    const isHead = commit.sha === this.headSha
    const isLocal = state.localCommitSHAs.includes(commit.sha)

    const items: IMenuItem[] = [
      {
        label: t('Create Branch Here…', 'Create branch here…'),
        action: () =>
          dispatcher.showPopup({
            type: PopupType.CreateBranch,
            repository,
            targetCommit: commit,
          }),
      },
      {
        label: t('Create Tag Here…', 'Create tag here…'),
        action: () =>
          dispatcher.showCreateTagDialog(
            repository,
            commit.sha,
            state.localTags
          ),
      },
      {
        label: t('Checkout This Commit', 'Checkout this commit'),
        action: () => this.checkoutCommit(commit),
        enabled: !isHead,
      },
      separator,
      {
        label: t('Cherry-pick Commit…', 'Cherry-pick commit…'),
        action: () => this.ctx.onCherryPick(repository, [commit]),
        enabled: current !== null && !isHead,
      },
    ]

    if (current !== null && !isHead) {
      items.push({
        label: `Reset ${current.name} to this commit`,
        submenu: [
          {
            label: t('Soft - Keep All Changes', 'Soft - keep all changes'),
            action: () =>
              this.run(() =>
                actions.resetToCommit(repository, commit.sha, GitResetMode.Soft)
              ),
          },
          {
            label: t(
              'Mixed - Keep Working Copy but Reset Index',
              'Mixed - keep working copy but reset index'
            ),
            action: () => dispatcher.resetToCommit(repository, commit),
          },
          {
            label: t(
              'Hard - Discard All Changes',
              'Hard - discard all changes'
            ),
            action: () => {
              if (
                this.confirm(
                  `Hard reset ${current.name} to ${commit.shortSha}? All uncommitted changes and later commits on this branch will be lost.`
                )
              ) {
                this.run(() =>
                  actions.resetToCommit(
                    repository,
                    commit.sha,
                    GitResetMode.Hard
                  )
                )
              }
            },
          },
        ],
      })
    }

    items.push({
      label: t('Revert Commit', 'Revert commit'),
      action: () => dispatcher.revertCommit(repository, commit),
      enabled: current !== null,
    })

    if (isHead && current !== null) {
      items.push(
        {
          label: t('Amend Commit…', 'Amend commit…'),
          action: () =>
            dispatcher.startAmendingRepository(repository, commit, isLocal),
        },
        {
          label: t('Undo Commit…', 'Undo commit…'),
          action: () => dispatcher.undoCommit(repository, commit),
          enabled: isLocal,
        }
      )
    }

    return items
  }

  private rewriteItems(commit: Commit): IMenuItem[] {
    const { repository, dispatcher } = this.ctx
    const chain = this.rewritableChain
    const index = chain.findIndex(c => c.sha === commit.sha)
    if (index === -1) {
      return []
    }
    const isHead = index === 0
    const older = chain[index + 1] as Commit | undefined

    return [
      {
        label: t('Edit Commit Message…', 'Edit commit message…'),
        action: () => this.rewordCommit(commit, isHead),
      },
      {
        label: t('Move Commit Up', 'Move commit up'),
        enabled: index > 0,
        action: () =>
          dispatcher.reorderCommits(
            repository,
            [commit],
            index >= 2 ? chain[index - 2] : null,
            commit.parentSHAs[0] ?? null
          ),
      },
      {
        label: t('Move Commit Down', 'Move commit down'),
        enabled: older !== undefined,
        action: () => {
          if (older !== undefined) {
            dispatcher.reorderCommits(
              repository,
              [commit],
              older,
              older.parentSHAs[0] ?? null
            )
          }
        },
      },
      {
        label: t('Drop Commit…', 'Drop commit…'),
        action: () => {
          if (
            this.confirm(
              `Drop commit ${commit.shortSha} "${commit.summary}" from ${this.currentBranch?.name}?`
            )
          ) {
            this.run(() => actions.dropCommits(repository, [commit], commit))
          }
        },
      },
    ]
  }

  private copyItems(commit: Commit, refs: ReadonlyArray<IGraphRef>) {
    const items: IMenuItem[] = [
      {
        label: t('Copy Commit SHA', 'Copy commit SHA'),
        action: () => writeClipboardText(commit.sha),
      },
    ]
    const names = [...new Set(refs.map(r => r.name))]
    for (const name of names) {
      items.push({
        label: `Copy "${name}"`,
        action: () => writeClipboardText(name),
      })
    }
    items.push({
      label: t('Create Patch from Commit…', 'Create patch from commit…'),
      action: () =>
        this.run(() => actions.createPatch(this.ctx.repository, [commit])),
    })
    return items
  }

  private gitHubItems(commit: Commit): IMenuItem[] {
    const { repository, state } = this.ctx
    const gitHubRepository = repository.gitHubRepository
    if (gitHubRepository === null) {
      return []
    }
    const label =
      gitHubRepository.endpoint === getDotComAPIEndpoint()
        ? t('View on GitHub', 'View on GitHub')
        : t('View on GitHub Enterprise', 'View on GitHub Enterprise')
    return [
      {
        label,
        action: () => this.ctx.onViewCommitOnGitHub(commit.sha),
        enabled: !state.localCommitSHAs.includes(commit.sha),
      },
    ]
  }

  /** Check out a branch or tag, as double-clicking it does in GitKraken. */
  public checkoutRef(ref: IGraphRef) {
    const { repository, dispatcher, state } = this.ctx
    if (ref.branch !== null) {
      if (ref.branch.name !== this.currentBranch?.name) {
        dispatcher.checkoutBranch(repository, ref.branch)
      }
      return
    }
    const commit = state.commitLookup.get(ref.sha)
    if (commit !== undefined && commit.sha !== this.headSha) {
      this.checkoutCommit(commit)
    }
  }

  private checkoutCommit(commit: CommitOneLine) {
    const { repository, dispatcher, askForConfirmationOnCheckoutCommit } =
      this.ctx
    if (askForConfirmationOnCheckoutCommit) {
      dispatcher.showPopup({
        type: PopupType.ConfirmCheckoutCommit,
        repository,
        commit,
      })
    } else {
      dispatcher.checkoutCommit(repository, commit)
    }
  }

  private rewordCommit(commit: Commit, isHead: boolean) {
    const { repository, dispatcher } = this.ctx
    dispatcher.showPopup({
      type: PopupType.CommitMessage,
      repository,
      coAuthors: [],
      showCoAuthoredBy: false,
      commitMessage: {
        summary: commit.summary,
        description: commit.body,
        timestamp: Date.now(),
      },
      dialogTitle: t('Edit Commit Message', 'Edit commit message'),
      dialogButtonText: t('Save Message', 'Save message'),
      prepopulateCommitSummary: true,
      onSubmitCommitMessage: async (context: ICommitContext) => {
        dispatcher.closePopup(PopupType.CommitMessage)
        const message =
          context.description !== null && context.description.length > 0
            ? `${context.summary}\n\n${context.description}`
            : context.summary
        await this.run(() =>
          actions.rewordCommit(repository, commit, message, isHead)
        )
        return true
      },
    })
  }

  // --- Branch and tag items ---------------------------------------------------

  private refItems(ref: IGraphRef): IMenuItem[] {
    if (ref.kind === GraphRefKind.Tag) {
      return this.tagItems(ref)
    }
    const branch = ref.branch
    if (branch === null) {
      return []
    }
    return branch.type === BranchType.Local
      ? this.localBranchItems(branch)
      : this.remoteBranchItems(branch)
  }

  private syncItems(branch: Branch): IMenuItem[] {
    const { repository, dispatcher } = this.ctx
    const upstreamRemote = this.remoteNamed(branch.upstreamRemoteName)
    const upstreamName = branch.upstreamWithoutRemote
    const tracking = graphViewStore.getTracking(repository.id).get(branch.name)
    const isCurrent = branch.name === this.currentBranch?.name
    const items: IMenuItem[] = []

    if (isCurrent) {
      if (upstreamRemote !== null && upstreamName !== null) {
        items.push(
          { label: 'Pull', action: () => dispatcher.pull(repository) },
          {
            label: t('Pull (Fast-forward Only)', 'Pull (fast-forward only)'),
            action: () =>
              this.run(() =>
                actions.pullCurrent(
                  repository,
                  upstreamRemote,
                  upstreamName,
                  'ff-only'
                )
              ),
          },
          {
            label: t('Pull (Rebase)', 'Pull (rebase)'),
            action: () =>
              this.run(() =>
                actions.pullCurrent(
                  repository,
                  upstreamRemote,
                  upstreamName,
                  'rebase'
                )
              ),
          },
          {
            label: t('Force Push', 'Force push'),
            enabled: tracking === undefined || tracking.ahead > 0,
            action: () => dispatcher.confirmOrForcePush(repository),
          }
        )
      }
      items.push({
        label:
          branch.upstream === null
            ? t('Push (Publish)', 'Push (publish)')
            : 'Push',
        action: () => dispatcher.push(repository),
      })
    } else if (upstreamRemote !== null && upstreamName !== null) {
      items.push(
        {
          label: `Fast-forward ${branch.name} to ${branch.upstream}`,
          enabled: tracking === undefined || tracking.behind > 0,
          action: () =>
            this.run(() =>
              actions.fastForwardBranch(
                repository,
                branch.name,
                `refs/remotes/${branch.upstream}`
              )
            ),
        },
        {
          label: `Push ${branch.name} to ${branch.upstream}`,
          enabled: tracking === undefined || tracking.ahead > 0,
          action: () =>
            this.run(() =>
              actions.pushBranch(
                repository,
                upstreamRemote,
                branch.name,
                upstreamName,
                false
              )
            ),
        }
      )
    } else if (this.defaultRemote !== null) {
      const remote = this.defaultRemote
      items.push({
        label: `Push ${branch.name} to ${remote.name}`,
        action: () =>
          this.run(() =>
            actions.pushBranch(
              repository,
              remote,
              branch.name,
              branch.name,
              true
            )
          ),
      })
    }

    const remoteBranches = this.ctx.state.branchesState.allBranches.filter(
      b =>
        b.type === BranchType.Remote &&
        b.nameWithoutRemote !== 'HEAD' &&
        !b.isDesktopForkRemoteBranch
    )
    if (remoteBranches.length > 0) {
      const sameName = remoteBranches.filter(
        b => b.nameWithoutRemote === branch.name
      )
      const candidates = [
        ...sameName,
        ...remoteBranches.filter(b => !sameName.includes(b)),
      ].slice(0, 40)
      items.push({
        label: t('Set Upstream', 'Set upstream'),
        submenu: candidates.map(b => ({
          label: b.name,
          type: 'checkbox' as const,
          checked: branch.upstream === b.name,
          action: () =>
            this.run(() =>
              actions.setUpstream(repository, branch.name, b.name)
            ),
        })),
      })
    }
    return items
  }

  /** Merge, rebase and fast-forward the current branch with `other`. */
  private integrateItems(other: Branch): IMenuItem[] {
    const { repository, dispatcher } = this.ctx
    const current = this.currentBranch
    if (current === null || current.name === other.name) {
      return []
    }
    return [
      {
        label: `Fast-forward ${current.name} to ${other.name}`,
        action: () =>
          this.run(async () => {
            if (
              !(await actions.isAncestor(
                repository,
                current.tip.sha,
                other.tip.sha
              ))
            ) {
              throw new Error(
                `${current.name} can't be fast-forwarded to ${other.name} because the branches have diverged.`
              )
            }
            await actions.fastForwardCurrent(repository, other.ref)
          }),
      },
      {
        label: `Merge ${other.name} into ${current.name}`,
        action: () => {
          dispatcher.initializeMergeOperation(repository, false, other)
          dispatcher.mergeBranch(repository, other, null)
        },
      },
      {
        label: `Rebase ${current.name} onto ${other.name}`,
        action: () => this.rebaseOnto(current, other),
      },
    ]
  }

  private async rebaseOnto(current: Branch, onto: Branch) {
    const { repository, dispatcher } = this.ctx
    const commits = await getCommitsBetweenCommits(
      repository,
      onto.tip.sha,
      current.tip.sha
    )
    if (commits === null) {
      dispatcher.postError(
        new Error(`Unable to find the commits to rebase onto ${onto.name}.`)
      )
      return
    }
    if (commits.length === 0) {
      dispatcher.postError(
        new Error(`${current.name} has no commits that aren't on ${onto.name}.`)
      )
      return
    }
    dispatcher.startRebase(repository, onto, current, commits)
  }

  private localBranchItems(branch: Branch): IMenuItem[] {
    const { repository, dispatcher } = this.ctx
    const isCurrent = branch.name === this.currentBranch?.name
    const items: IMenuItem[] = [...this.syncItems(branch), separator]
    items.push(...this.integrateItems(branch), separator)

    if (!isCurrent) {
      items.push({
        label: `Checkout ${branch.name}`,
        action: () => dispatcher.checkoutBranch(repository, branch),
      })
    }

    if (isCurrent && repository.gitHubRepository !== null) {
      items.push({
        label: t('Create Pull Request…', 'Create pull request…'),
        action: () => dispatcher.startPullRequest(repository),
      })
    }

    items.push(
      separator,
      {
        label: `Rename ${branch.name}…`,
        action: () =>
          dispatcher.showPopup({
            type: PopupType.RenameBranch,
            repository,
            branch,
          }),
      },
      {
        label: `Delete ${branch.name}…`,
        enabled: !isCurrent,
        action: () =>
          dispatcher.showPopup({
            type: PopupType.DeleteBranch,
            repository,
            branch,
            existsOnRemote: branch.upstream !== null,
          }),
      }
    )

    const upstream = this.ctx.state.branchesState.allBranches.find(
      b => b.type === BranchType.Remote && b.name === branch.upstream
    )
    if (upstream !== undefined) {
      items.push({
        label: `Delete ${upstream.name}…`,
        action: () =>
          dispatcher.showPopup({
            type: PopupType.DeleteRemoteBranch,
            repository,
            branch: upstream,
          }),
      })
    }
    return items
  }

  private remoteBranchItems(branch: Branch): IMenuItem[] {
    const { repository, dispatcher } = this.ctx
    const remote = this.remoteNamed(branch.remoteName)
    const localExists = this.ctx.state.branchesState.allBranches.some(
      b => b.type === BranchType.Local && b.upstream === branch.name
    )
    const items: IMenuItem[] = []
    if (remote !== null) {
      items.push({
        label: `Fetch ${remote.name}`,
        action: () => this.run(() => actions.fetchRemote(repository, remote)),
      })
    }
    items.push(...this.integrateItems(branch), separator)
    items.push({
      label: localExists
        ? `Checkout ${branch.nameWithoutRemote}`
        : `Checkout ${branch.name} as new local branch`,
      action: () => dispatcher.checkoutBranch(repository, branch),
    })
    if (repository.gitHubRepository !== null) {
      items.push({
        label: t(
          `Create Pull Request into ${branch.name}…`,
          `Create pull request into ${branch.name}…`
        ),
        enabled: this.currentBranch !== null,
        action: () => dispatcher.createPullRequest(repository, branch),
      })
    }
    items.push(separator, {
      label: `Delete ${branch.name}…`,
      action: () =>
        dispatcher.showPopup({
          type: PopupType.DeleteRemoteBranch,
          repository,
          branch,
        }),
    })
    return items
  }

  private tagItems(tag: IGraphRef): IMenuItem[] {
    const { repository, dispatcher, state } = this.ctx
    const items: IMenuItem[] = []
    const commit = state.commitLookup.get(tag.sha)
    if (commit !== undefined) {
      items.push({
        label: `Checkout ${tag.name}`,
        action: () => this.checkoutCommit(commit),
      })
    }
    for (const remote of this.remotes) {
      items.push({
        label: `Push ${tag.name} to ${remote.name}`,
        action: () =>
          this.run(() => actions.pushTag(repository, remote, tag.name)),
      })
    }
    items.push(separator, {
      label: `Delete ${tag.name} locally…`,
      action: () => dispatcher.showDeleteTagDialog(repository, tag.name),
    })
    for (const remote of this.remotes) {
      items.push({
        label: `Delete ${tag.name} from ${remote.name}…`,
        action: () => {
          if (this.confirm(`Delete tag ${tag.name} from ${remote.name}?`)) {
            this.run(() =>
              actions.deleteRemoteTag(repository, remote, tag.name)
            )
          }
        },
      })
    }
    return items
  }

  private viewItems(refs: ReadonlyArray<IGraphRef>): IMenuItem[] {
    const { id } = this.ctx.repository
    const ids = refs.map(r => r.id)
    const allHidden = ids.every(r => graphViewStore.isHidden(id, r))
    const allSolo = ids.every(r => graphViewStore.isSolo(id, r))
    const pinnable = refs.find(r => r.kind !== GraphRefKind.Tag)
    const { pinnedRef } = graphViewStore.getSettings(id)
    const items: IMenuItem[] = [
      {
        label: allHidden ? t('Show', 'Show') : t('Hide', 'Hide'),
        action: () => graphViewStore.setHidden(id, ids, !allHidden),
      },
      {
        label: allSolo ? t('Unsolo', 'Unsolo') : t('Solo', 'Solo'),
        action: () => graphViewStore.setSolo(id, ids, !allSolo),
      },
    ]
    if (pinnable !== undefined) {
      const pinned = pinnedRef === pinnable.id
      items.push({
        label: pinned
          ? t('Unpin from Left', 'Unpin from left')
          : t('Pin to Left', 'Pin to left'),
        action: () => graphViewStore.setPinned(id, pinned ? null : pinnable.id),
      })
    }
    return items
  }

  // --- Multi-selection ------------------------------------------------------

  private showMultiCommitMenu(commits: ReadonlyArray<Commit>) {
    const { repository } = this.ctx
    const count = commits.length
    const chain = this.rewritableChain
    const indexes = commits.map(c => chain.findIndex(x => x.sha === c.sha))
    const onChain = indexes.every(i => i !== -1)
    const oldest = onChain
      ? chain[Math.max(...indexes)]
      : commits[commits.length - 1]
    const newest = onChain ? chain[Math.min(...indexes)] : commits[0]

    show([
      {
        label: t(
          `Cherry-pick ${count} Commits…`,
          `Cherry-pick ${count} commits…`
        ),
        enabled: this.currentBranch !== null,
        action: () => this.ctx.onCherryPick(repository, commits),
      },
      {
        label: t(`Squash ${count} Commits…`, `Squash ${count} commits…`),
        enabled: onChain,
        action: () => this.squash(commits, newest, oldest),
      },
      {
        label: t(`Drop ${count} Commits…`, `Drop ${count} commits…`),
        enabled: onChain,
        action: () => {
          if (
            this.confirm(
              `Drop ${count} commits from ${this.currentBranch?.name}?`
            )
          ) {
            this.run(() => actions.dropCommits(repository, commits, oldest))
          }
        },
      },
      separator,
      {
        label: t(
          `Create Patch from ${count} Commits…`,
          `Create patch from ${count} commits…`
        ),
        action: () => this.run(() => actions.createPatch(repository, commits)),
      },
      {
        label: t('Copy Commit SHAs', 'Copy commit SHAs'),
        action: () => writeClipboardText(commits.map(c => c.sha).join('\n')),
      },
    ])
  }

  private squash(
    commits: ReadonlyArray<Commit>,
    squashOnto: Commit,
    oldest: Commit
  ) {
    const { repository, dispatcher } = this.ctx
    const toSquash = commits.filter(c => c.sha !== squashOnto.sha)
    const all = [...toSquash, squashOnto]
    const coAuthors = getUniqueCoauthorsAsAuthors(all)
    const lastRetainedCommitRef = oldest.parentSHAs[0] ?? null
    dispatcher.showPopup({
      type: PopupType.CommitMessage,
      repository,
      coAuthors,
      showCoAuthoredBy: coAuthors.length > 0,
      commitMessage: {
        summary: squashOnto.summary,
        description: getSquashedCommitDescription(toSquash, squashOnto),
        timestamp: Date.now(),
      },
      dialogTitle: `Squash ${all.length} Commits`,
      dialogButtonText: `Squash ${all.length} Commits`,
      prepopulateCommitSummary: true,
      onSubmitCommitMessage: async (context: ICommitContext) => {
        dispatcher.closePopup(PopupType.CommitMessage)
        dispatcher.squash(
          repository,
          toSquash,
          squashOnto,
          lastRetainedCommitRef,
          context
        )
        return true
      },
    })
  }

  private showMultiRefMenu(refs: ReadonlyArray<IGraphRef>) {
    const { repository } = this.ctx
    const current = this.currentBranch?.name
    const deletable = refs.filter(
      r => r.kind === GraphRefKind.Local && r.name !== current
    )
    show([
      {
        label: t(
          `Delete ${deletable.length} Local Branches…`,
          `Delete ${deletable.length} local branches…`
        ),
        enabled: deletable.length > 0,
        action: () => {
          const names = deletable.map(r => r.name)
          if (
            this.confirm(
              `Delete these local branches?\n\n${names.join(
                '\n'
              )}\n\nUnmerged commits on them will be lost.`
            )
          ) {
            this.run(() => actions.deleteLocalBranches(repository, names))
          }
        },
      },
      separator,
      ...this.viewItems(refs).filter(
        i => i.label !== undefined && !/pin/i.test(i.label)
      ),
    ])
  }

  // --- WIP, stashes, remotes and sections -------------------------------------

  public showWorkDirMenu() {
    const { repository, dispatcher, state } = this.ctx
    const files = state.changesState.workingDirectory.files
    show([
      {
        label: t('View Changes', 'View changes'),
        action: () =>
          dispatcher.changeRepositorySection(
            repository,
            RepositorySectionTab.Changes
          ),
      },
      {
        label: t('Stage All Changes', 'Stage all changes'),
        enabled: files.length > 0,
        action: () => wip.stageAll(dispatcher, repository),
      },
      {
        label: t('Unstage All Changes', 'Unstage all changes'),
        enabled: files.length > 0,
        action: () => wip.unstageAll(dispatcher, repository),
      },
      {
        label: t('Stash All Changes', 'Stash all changes'),
        enabled: files.length > 0 && this.currentBranch !== null,
        action: () => dispatcher.createStashForCurrentBranch(repository),
      },
      separator,
      {
        label: t('Discard All Changes…', 'Discard all changes…'),
        enabled: files.length > 0,
        action: () => this.discardFiles(files, true),
      },
    ])
  }

  public showStashMenu(stash: IGraphStash) {
    const { repository, dispatcher, state } = this.ctx
    show([
      {
        label: t('Apply Stash', 'Apply stash'),
        action: () =>
          this.run(() => actions.applyStash(repository, stash.name)),
      },
      {
        label: t('Pop Stash', 'Pop stash'),
        action: () => this.run(() => actions.popStash(repository, stash.name)),
      },
      {
        label: t('Delete Stash…', 'Delete stash…'),
        action: () => {
          if (this.confirm(`Delete ${stash.name} "${stash.message}"?`)) {
            this.run(() => actions.dropStash(repository, stash.name))
          }
        },
      },
      separator,
      {
        label: t('Edit Stash Message…', 'Edit stash message…'),
        action: () =>
          dispatcher.showPopup({
            type: PopupType.CommitMessage,
            repository,
            coAuthors: [],
            showCoAuthoredBy: false,
            commitMessage: {
              summary: stash.message,
              description: '',
              timestamp: Date.now(),
            },
            dialogTitle: t('Edit Stash Message', 'Edit stash message'),
            dialogButtonText: t('Save Message', 'Save message'),
            prepopulateCommitSummary: true,
            onSubmitCommitMessage: async (context: ICommitContext) => {
              dispatcher.closePopup(PopupType.CommitMessage)
              await this.run(() =>
                actions.renameStash(
                  repository,
                  stash.name,
                  stash.sha,
                  context.summary
                )
              )
              return true
            },
          }),
      },
      {
        label: t('Copy Stash SHA', 'Copy stash SHA'),
        action: () => writeClipboardText(stash.sha),
      },
      {
        label: t('Create Patch from Stash…', 'Create patch from stash…'),
        enabled: state.commitLookup.has(stash.sha),
        action: () => {
          const commit = state.commitLookup.get(stash.sha)
          if (commit !== undefined) {
            this.run(() => actions.createPatch(repository, [commit]))
          }
        },
      },
    ])
  }

  public showRemoteMenu(remote: IRemote) {
    const { repository, state } = this.ctx
    const ids = state.branchesState.allBranches
      .filter(b => b.type === BranchType.Remote && b.remoteName === remote.name)
      .map(b => b.ref)
    show([
      {
        label: `Fetch ${remote.name}`,
        action: () => this.run(() => actions.fetchRemote(repository, remote)),
      },
      separator,
      {
        label: t('Edit Remote…', 'Edit remote…'),
        action: () => graphViewStore.openRemoteForm(repository.id, remote),
      },
      {
        label: t('Copy Remote URL', 'Copy remote URL'),
        action: () => writeClipboardText(remote.url),
      },
      {
        label: t('Remove Remote…', 'Remove remote…'),
        action: () => {
          if (this.confirm(`Remove remote ${remote.name} (${remote.url})?`)) {
            this.run(() => actions.removeRemote(repository, remote.name))
          }
        },
      },
      separator,
      {
        label: t('Hide All Branches', 'Hide all branches'),
        action: () => graphViewStore.setHidden(repository.id, ids, true),
      },
      {
        label: t('Show All Branches', 'Show all branches'),
        action: () => graphViewStore.setHidden(repository.id, ids, false),
      },
    ])
  }

  public showSectionMenu(
    section: RefPanelSection,
    refs: ReadonlyArray<IGraphRef>
  ) {
    const { repository, dispatcher, state } = this.ctx
    const ids = refs.map(r => r.id)
    const visibility: IMenuItem[] =
      ids.length > 0
        ? [
            {
              label: t('Hide All', 'Hide all'),
              action: () => graphViewStore.setHidden(repository.id, ids, true),
            },
            {
              label: t('Show All', 'Show all'),
              action: () => graphViewStore.setHidden(repository.id, ids, false),
            },
          ]
        : []

    switch (section) {
      case RefPanelSection.Local:
        return show([
          {
            label: t('Create Branch…', 'Create branch…'),
            action: () =>
              dispatcher.showPopup({
                type: PopupType.CreateBranch,
                repository,
              }),
          },
          separator,
          ...visibility,
        ])
      case RefPanelSection.Remote:
        return show([
          {
            label: t('Fetch All', 'Fetch all'),
            action: () =>
              dispatcher.fetch(repository, FetchType.UserInitiatedTask),
          },
          {
            label: t('Add Remote…', 'Add remote…'),
            action: () => graphViewStore.openRemoteForm(repository.id, null),
          },
          separator,
          ...visibility,
        ])
      case RefPanelSection.Tags:
        return show([
          {
            label: t('Create Tag at HEAD…', 'Create tag at HEAD…'),
            enabled: this.headSha !== null,
            action: () => {
              if (this.headSha !== null) {
                dispatcher.showCreateTagDialog(
                  repository,
                  this.headSha,
                  state.localTags
                )
              }
            },
          },
          separator,
          ...visibility,
        ])
      case RefPanelSection.Stashes:
        return show([
          {
            label: t('Stash All Changes', 'Stash all changes'),
            enabled:
              state.changesState.workingDirectory.files.length > 0 &&
              this.currentBranch !== null,
            action: () => dispatcher.createStashForCurrentBranch(repository),
          },
        ])
    }
  }

  // --- Files ------------------------------------------------------------------

  public async showFileMenu(file: CommittedFileChange, commit: Commit | null) {
    const { repository, externalEditorLabel, state } = this.ctx
    const fullPath = Path.join(repository.path, file.path)
    const exists = await pathExists(fullPath)
    const extension = Path.extname(file.path)

    const items: IMenuItem[] = [
      {
        label: RevealInFileManagerLabel,
        action: () => revealInFileManager(repository, file.path),
        enabled: exists,
      },
      {
        label: externalEditorLabel
          ? `Open in ${externalEditorLabel}`
          : DefaultEditorLabel,
        action: () => this.ctx.onOpenInExternalEditor(file.path),
        enabled: exists,
      },
      {
        label: OpenWithDefaultProgramLabel,
        action: () => openFile(fullPath, this.ctx.dispatcher),
        enabled: exists && isSafeFileExtension(extension),
      },
      separator,
      { label: CopyFilePathLabel, action: () => writeClipboardText(fullPath) },
      {
        label: CopyRelativeFilePathLabel,
        action: () => writeClipboardText(Path.normalize(file.path)),
      },
    ]

    if (commit !== null && repository.gitHubRepository !== null) {
      items.push(separator, {
        label: 'View on GitHub',
        action: () => this.ctx.onViewCommitOnGitHub(commit.sha, file.path),
        enabled: !state.localCommitSHAs.includes(commit.sha),
      })
    }
    show(items)
  }

  /**
   * The menu of a file in the WIP panel's Unstaged or Staged list.
   *
   * @param onOpenMergeTool Opens the file in the merge tool, when it has
   *                        conflicts that can be merged there.
   */
  public async showWorkingFileMenu(
    file: WorkingDirectoryFileChange,
    staged: boolean,
    onOpenMergeTool: (() => void) | null
  ) {
    const { repository, dispatcher, externalEditorLabel } = this.ctx
    const fullPath = Path.join(repository.path, file.path)
    const exists = await pathExists(fullPath)
    const extension = Path.extname(file.path)
    const isGitIgnore = Path.basename(file.path) === '.gitignore'
    // Git paths always use '/', even on Windows.
    const folders = file.path.split('/').slice(0, -1)
    const folderItems: IMenuItem[] = folders.map((_, index) => {
      const folder = `/${folders.slice(0, folders.length - index).join('/')}`
      return {
        label: folder,
        action: () => dispatcher.appendIgnoreFile(repository, folder),
      }
    })

    show([
      staged
        ? {
            label: t('Unstage File', 'Unstage file'),
            action: () => wip.unstageFiles(dispatcher, repository, [file]),
          }
        : {
            label: t('Stage File', 'Stage file'),
            action: () => wip.stageFiles(dispatcher, repository, [file]),
          },
      ...(onOpenMergeTool !== null
        ? [
            {
              label: t('Open in Merge Tool', 'Open in merge tool'),
              action: onOpenMergeTool,
            },
          ]
        : []),
      {
        label: t('Discard Changes…', 'Discard changes…'),
        action: () => this.discardFiles([file]),
      },
      separator,
      {
        label: t(
          'Ignore File (Add to .gitignore)',
          'Ignore file (add to .gitignore)'
        ),
        enabled: !isGitIgnore,
        action: () => dispatcher.appendIgnoreFile(repository, file.path),
      },
      ...(folderItems.length > 0
        ? [
            {
              label: t(
                'Ignore Folder (Add to .gitignore)',
                'Ignore folder (add to .gitignore)'
              ),
              enabled: !isGitIgnore,
              submenu: folderItems,
            },
          ]
        : []),
      ...(extension.length > 0
        ? [
            {
              label: t(
                `Ignore All ${extension} Files (Add to .gitignore)`,
                `Ignore all ${extension} files (add to .gitignore)`
              ),
              action: () =>
                dispatcher.appendIgnoreRule(repository, `*${extension}`),
            },
          ]
        : []),
      separator,
      {
        label: RevealInFileManagerLabel,
        action: () => revealInFileManager(repository, file.path),
        enabled: exists,
      },
      {
        label: externalEditorLabel
          ? `Open in ${externalEditorLabel}`
          : DefaultEditorLabel,
        action: () => this.ctx.onOpenInExternalEditor(file.path),
        enabled: exists,
      },
      {
        label: OpenWithDefaultProgramLabel,
        action: () => openFile(fullPath, dispatcher),
        enabled: exists && isSafeFileExtension(extension),
      },
      separator,
      { label: CopyFilePathLabel, action: () => writeClipboardText(fullPath) },
      {
        label: CopyRelativeFilePathLabel,
        action: () => writeClipboardText(Path.normalize(file.path)),
      },
    ])
  }

  /** Discard the files' changes, asking first if the user wants to be asked. */
  public discardFiles(
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    discardingAllChanges: boolean = false
  ) {
    const { repository, dispatcher, askForConfirmationOnDiscardChanges } =
      this.ctx
    if (!askForConfirmationOnDiscardChanges && !discardingAllChanges) {
      return dispatcher.discardChanges(repository, files)
    }
    return dispatcher.showPopup({
      type: PopupType.ConfirmDiscardChanges,
      repository,
      files,
      showDiscardChangesSetting: !discardingAllChanges,
      discardingAllChanges,
    })
  }

  /** Every ref the graph knows about, used to resolve panel selections. */
  public get allRefs(): ReadonlyArray<IGraphRef> {
    const { branchesState, localTags } = this.ctx.state
    const current = this.currentBranch?.name ?? null
    return [
      ...getRefsBySha(branchesState.allBranches, localTags, current).values(),
    ].flat()
  }
}
