import { git } from './core'
import { getCommits } from './log'
import { createLogParser } from './git-delimiter-parser'
import { Repository } from '../../models/repository'
import { Commit } from '../../models/commit'
import { IGraphStash } from '../../models/stash-entry'

/**
 * Load a batch of commits reachable from HEAD and every local branch, remote
 * branch and tag, newest first, in the order the commit graph draws them.
 */
export function getGraphCommits(
  repository: Repository,
  limit: number,
  skip: number
): Promise<ReadonlyArray<Commit>> {
  return getCommits(repository, 'HEAD', limit, skip, [
    '--branches',
    '--remotes',
    '--tags',
    '--date-order',
  ])
}

/** List every stash entry in the repository, newest first. */
export async function getGraphStashes(
  repository: Repository
): Promise<ReadonlyArray<IGraphStash>> {
  const { formatArgs, parse } = createLogParser({
    name: '%gd',
    sha: '%H',
    parents: '%P',
    message: '%gs',
  })

  const result = await git(
    ['log', '-g', ...formatArgs, 'refs/stash', '--'],
    repository.path,
    'getGraphStashes',
    { successExitCodes: new Set([0, 128]) }
  )

  if (result.exitCode === 128) {
    return []
  }

  return parse(result.stdout).map(({ name, sha, parents, message }) => ({
    name,
    sha,
    parents: parents.length > 0 ? parents.split(' ') : [],
    message,
  }))
}

/** How far a local branch is ahead of and behind its upstream. */
export interface IBranchTracking {
  readonly ahead: number
  readonly behind: number
  /** The upstream is configured but no longer exists */
  readonly gone: boolean
}

/** Ahead/behind counts for every local branch with an upstream. */
export async function getBranchTracking(
  repository: Repository
): Promise<Map<string, IBranchTracking>> {
  const { stdout } = await git(
    [
      'for-each-ref',
      '--format=%(refname:short)%00%(upstream:track,nobracket)',
      'refs/heads',
    ],
    repository.path,
    'getBranchTracking'
  )

  const result = new Map<string, IBranchTracking>()
  for (const line of stdout.split('\n')) {
    const [name, track] = line.split('\0')
    if (!name || !track) {
      continue
    }
    const ahead = /ahead (\d+)/.exec(track)
    const behind = /behind (\d+)/.exec(track)
    result.set(name, {
      ahead: ahead ? parseInt(ahead[1], 10) : 0,
      behind: behind ? parseInt(behind[1], 10) : 0,
      gone: track === 'gone',
    })
  }
  return result
}

/** Every file path in the tree of the given commit. */
export async function listTreeFiles(
  repository: Repository,
  sha: string
): Promise<ReadonlyArray<string>> {
  const { stdout } = await git(
    ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha],
    repository.path,
    'listTreeFiles'
  )
  return stdout.split('\0').filter(p => p.length > 0)
}

/** Every file path in the tree of the given commit. */
export async function getCommitTreePaths(
  repository: Repository,
  sha: string
): Promise<ReadonlyArray<string>> {
  const { stdout } = await git(
    ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha],
    repository.path,
    'getCommitTreePaths'
  )
  return stdout.split('\0').filter(p => p.length > 0)
}

/** Load the commit objects for the given stash entries. */
export async function getStashCommits(
  repository: Repository,
  stashes: ReadonlyArray<IGraphStash>
): Promise<ReadonlyArray<Commit>> {
  if (stashes.length === 0) {
    return []
  }

  return getCommits(repository, undefined, undefined, undefined, [
    '--no-walk',
    ...stashes.map(s => s.sha),
  ])
}
