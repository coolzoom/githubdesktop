import { writeFile, appendFile, rm } from 'fs/promises'
import { Repository } from '../../models/repository'
import { IRemote } from '../../models/remote'
import { Commit } from '../../models/commit'
import { git, reset, GitResetMode, rebaseInteractive } from '../../lib/git'
import { RebaseResult } from '../../lib/git/rebase'
import { envForRemoteOperation } from '../../lib/git/environment'
import { getTempFilePath } from '../../lib/file-system'
import { Dispatcher } from '../dispatcher'
import { showSaveDialog } from '../main-process-proxy'

/**
 * Run a git operation started from the commit graph, report failures through
 * Desktop's error handling and refresh the repository afterwards.
 */
export async function runGraphAction(
  dispatcher: Dispatcher,
  repository: Repository,
  fn: () => Promise<unknown>
): Promise<void> {
  try {
    await fn()
  } catch (e) {
    dispatcher.postError(e instanceof Error ? e : new Error(`${e}`))
  } finally {
    await dispatcher.refreshRepository(repository)
  }
}

async function remoteGit(
  repository: Repository,
  remote: IRemote,
  args: string[],
  name: string
) {
  return git(args, repository.path, name, {
    env: await envForRemoteOperation(remote.url),
  })
}

export function setUpstream(
  repository: Repository,
  branchName: string,
  upstream: string
) {
  return git(
    ['branch', `--set-upstream-to=${upstream}`, '--', branchName],
    repository.path,
    'setUpstream'
  )
}

/** Fast-forward a branch that isn't checked out to the given ref. */
export function fastForwardBranch(
  repository: Repository,
  branchName: string,
  targetRef: string
) {
  return git(
    ['fetch', '.', `${targetRef}:refs/heads/${branchName}`],
    repository.path,
    'fastForwardBranch'
  )
}

/** Fast-forward the current branch to the given ref. */
export function fastForwardCurrent(repository: Repository, targetRef: string) {
  return git(
    ['merge', '--ff-only', targetRef],
    repository.path,
    'fastForwardCurrent'
  )
}

export function resetToCommit(
  repository: Repository,
  sha: string,
  mode: GitResetMode
) {
  return reset(repository, mode, sha)
}

export type PullMode = 'merge' | 'ff-only' | 'rebase'

export function pullCurrent(
  repository: Repository,
  remote: IRemote,
  branch: string,
  mode: PullMode
) {
  const modeArg =
    mode === 'merge'
      ? '--no-rebase'
      : mode === 'ff-only'
      ? '--ff-only'
      : '--rebase'
  return remoteGit(
    repository,
    remote,
    ['pull', modeArg, remote.name, branch],
    'pullCurrent'
  )
}

export function fetchRemote(repository: Repository, remote: IRemote) {
  return remoteGit(
    repository,
    remote,
    ['fetch', '--prune', remote.name],
    'fetchRemote'
  )
}

/** Push a local branch, optionally setting its upstream. */
export function pushBranch(
  repository: Repository,
  remote: IRemote,
  localBranch: string,
  remoteBranch: string,
  setUpstreamToo: boolean
) {
  return remoteGit(
    repository,
    remote,
    [
      'push',
      ...(setUpstreamToo ? ['--set-upstream'] : []),
      remote.name,
      `refs/heads/${localBranch}:refs/heads/${remoteBranch}`,
    ],
    'pushBranch'
  )
}

export function pushTag(repository: Repository, remote: IRemote, tag: string) {
  return remoteGit(
    repository,
    remote,
    ['push', remote.name, `refs/tags/${tag}`],
    'pushTag'
  )
}

export function deleteRemoteTag(
  repository: Repository,
  remote: IRemote,
  tag: string
) {
  return remoteGit(
    repository,
    remote,
    ['push', remote.name, '--delete', `refs/tags/${tag}`],
    'deleteRemoteTag'
  )
}

export function deleteLocalTag(repository: Repository, tag: string) {
  return git(['tag', '-d', tag], repository.path, 'deleteLocalTag')
}

export function deleteLocalBranches(
  repository: Repository,
  names: ReadonlyArray<string>
) {
  return git(
    ['branch', '-D', '--', ...names],
    repository.path,
    'deleteLocalBranches'
  )
}

export function applyStash(repository: Repository, name: string) {
  return git(['stash', 'apply', name], repository.path, 'applyStash')
}

export function popStash(repository: Repository, name: string) {
  return git(['stash', 'pop', name], repository.path, 'popStash')
}

export function stashAllChanges(repository: Repository) {
  return git(
    ['stash', 'push', '--include-untracked'],
    repository.path,
    'stashAllChanges'
  )
}

/**
 * Pop a stash leaving every restored change unstaged. The entry is only
 * dropped once it applied cleanly, so a conflicting pop keeps the stash.
 */
export async function popStashUnstaged(repository: Repository, name: string) {
  await git(['stash', 'apply', name], repository.path, 'popStashUnstaged')
  await git(['reset', '-q'], repository.path, 'popStashUnstaged')
  await git(['stash', 'drop', name], repository.path, 'popStashUnstaged')
}

export function dropStash(repository: Repository, name: string) {
  return git(['stash', 'drop', name], repository.path, 'dropStash')
}

/**
 * Change a stash entry's message by storing the same stash commit again with
 * the new message and dropping the old entry.
 */
export async function renameStash(
  repository: Repository,
  name: string,
  sha: string,
  message: string
) {
  await git(['stash', 'drop', name], repository.path, 'renameStash')
  await git(
    ['stash', 'store', '-m', message, sha],
    repository.path,
    'renameStash'
  )
}

export function removeRemote(repository: Repository, name: string) {
  return git(['remote', 'remove', name], repository.path, 'removeRemote')
}

/** The push URL of a remote, or null when it pushes to its pull URL. */
export async function getRemotePushUrl(repository: Repository, name: string) {
  const result = await git(
    ['config', '--get', `remote.${name}.pushurl`],
    repository.path,
    'getRemotePushUrl',
    { successExitCodes: new Set([0, 1]) }
  )
  const url = result.stdout.trim()
  return result.exitCode === 0 && url.length > 0 ? url : null
}

async function setRemotePushUrl(
  repository: Repository,
  name: string,
  pushUrl: string
) {
  if (pushUrl.length > 0) {
    await git(
      ['remote', 'set-url', '--push', name, pushUrl],
      repository.path,
      'setRemotePushUrl'
    )
  } else {
    await git(
      ['config', '--unset-all', `remote.${name}.pushurl`],
      repository.path,
      'setRemotePushUrl',
      { successExitCodes: new Set([0, 5]) }
    )
  }
}

/** Add a remote with an optional separate push URL and fetch it. */
export async function addRemote(
  repository: Repository,
  name: string,
  pullUrl: string,
  pushUrl: string
) {
  await git(['remote', 'add', name, pullUrl], repository.path, 'addRemote')
  if (pushUrl.length > 0) {
    await setRemotePushUrl(repository, name, pushUrl)
  }
  await fetchRemote(repository, { name, url: pullUrl })
}

/**
 * Rename a remote and change its URLs. An empty push URL makes the remote
 * push to its pull URL.
 */
export async function editRemote(
  repository: Repository,
  oldName: string,
  name: string,
  pullUrl: string,
  pushUrl: string
) {
  if (name !== oldName) {
    await git(
      ['remote', 'rename', oldName, name],
      repository.path,
      'editRemote'
    )
  }
  await git(['remote', 'set-url', name, pullUrl], repository.path, 'editRemote')
  await setRemotePushUrl(repository, name, pushUrl)
}

/** Write `git format-patch` output for the given commits to a chosen file. */
export async function createPatch(
  repository: Repository,
  commits: ReadonlyArray<Commit>
) {
  if (commits.length === 0) {
    return
  }
  const first = commits[0]
  const defaultName =
    commits.length === 1
      ? `${first.shortSha}-${first.summary
          .replace(/[^\w.-]+/g, '-')
          .slice(0, 50)}.patch`
      : `${commits.length}-commits.patch`
  const path = await showSaveDialog({
    title: 'Save patch',
    defaultPath: defaultName,
    filters: [{ name: 'Patch', extensions: ['patch'] }],
  })
  if (!path) {
    return
  }

  const { stdout } = await git(
    [
      'format-patch',
      '--stdout',
      '--no-walk',
      ...commits.map(c => c.sha).reverse(),
    ],
    repository.path,
    'createPatch'
  )
  await writeFile(path, stdout)
}

/** The first-parent commits from `fromSha` (inclusive) up to HEAD, oldest first. */
async function getChainToHead(repository: Repository, fromSha: string) {
  const { stdout } = await git(
    ['rev-list', '--reverse', '--first-parent', `${fromSha}^..HEAD`],
    repository.path,
    'getChainToHead',
    { successExitCodes: new Set([0, 128]) }
  )
  const shas = stdout.split('\n').filter(s => s.length > 0)
  if (shas.length === 0 || shas[0] !== fromSha) {
    // `fromSha` is a root commit; walk the whole first-parent history.
    const all = await git(
      ['rev-list', '--reverse', '--first-parent', 'HEAD'],
      repository.path,
      'getChainToHead'
    )
    const allShas = all.stdout.split('\n').filter(s => s.length > 0)
    return allShas.slice(allShas.indexOf(fromSha))
  }
  return shas
}

async function rewriteHistory(
  repository: Repository,
  oldestSha: string,
  hasParent: boolean,
  line: (sha: string) => string | ReadonlyArray<string>,
  action: string
) {
  const chain = await getChainToHead(repository, oldestSha)
  const todoPath = await getTempFilePath('graphRebaseTodo')
  try {
    for (const sha of chain) {
      const value = line(sha)
      const lines = typeof value === 'string' ? [value] : value
      for (const l of lines) {
        await appendFile(todoPath, `${l}\n`)
      }
    }
    const result = await rebaseInteractive(
      repository,
      todoPath,
      hasParent ? `${oldestSha}^` : null,
      { action }
    )
    if (result === RebaseResult.ConflictsEncountered) {
      throw new Error(
        `${action} stopped because of conflicts. Resolve them in the Changes tab and continue the rebase, or abort it.`
      )
    }
    if (result === RebaseResult.Error) {
      throw new Error(`${action} failed.`)
    }
  } finally {
    await rm(todoPath, { force: true })
  }
}

/** Remove commits from the current branch's first-parent history. */
export function dropCommits(
  repository: Repository,
  commits: ReadonlyArray<Commit>,
  oldest: Commit
) {
  const toDrop = new Set(commits.map(c => c.sha))
  return rewriteHistory(
    repository,
    oldest.sha,
    oldest.parentSHAs.length > 0,
    sha => `${toDrop.has(sha) ? 'drop' : 'pick'} ${sha}`,
    'Drop commit'
  )
}

/** Change the message of a commit in the current branch's history. */
export async function rewordCommit(
  repository: Repository,
  commit: Commit,
  message: string,
  isHead: boolean
) {
  const messagePath = await getTempFilePath('graphRewordMessage')
  await writeFile(messagePath, message)
  try {
    if (isHead) {
      await git(
        ['commit', '--amend', '--only', '--allow-empty', '-F', messagePath],
        repository.path,
        'rewordCommit'
      )
      return
    }
    await rewriteHistory(
      repository,
      commit.sha,
      commit.parentSHAs.length > 0,
      sha =>
        sha === commit.sha
          ? [
              `pick ${sha}`,
              `exec git commit --amend --only --allow-empty --no-verify -F "${messagePath}"`,
            ]
          : `pick ${sha}`,
      'Edit commit message'
    )
  } finally {
    await rm(messagePath, { force: true })
  }
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(
  repository: Repository,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const result = await git(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    repository.path,
    'isAncestor',
    { successExitCodes: new Set([0, 1, 128]) }
  )
  return result.exitCode === 0
}
