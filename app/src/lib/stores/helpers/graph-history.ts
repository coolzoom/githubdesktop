import { Branch } from '../../../models/branch'
import { Commit } from '../../../models/commit'
import { IGraphStash } from '../../../models/stash-entry'

/**
 * Insert stash commits into a newest-first list of commit SHAs. Each stash is
 * placed by date, but always above its base commit. Stashes whose base commit
 * isn't loaded yet are left out.
 */
export function insertGraphStashes(
  commitSHAs: ReadonlyArray<string>,
  stashes: ReadonlyArray<IGraphStash>,
  commitLookup: Map<string, Commit>
): ReadonlyArray<string> {
  const stashShas = new Set(stashes.map(s => s.sha))
  const result = commitSHAs.filter(sha => !stashShas.has(sha))

  for (const stash of stashes) {
    const stashCommit = commitLookup.get(stash.sha)
    const base = stash.parents[0]
    const baseIndex = base === undefined ? -1 : result.indexOf(base)
    if (stashCommit === undefined || baseIndex === -1) {
      continue
    }

    const stashDate = stashCommit.committer.date.getTime()
    let index = baseIndex
    for (let i = 0; i < baseIndex; i++) {
      const commit = commitLookup.get(result[i])
      if (
        commit !== undefined &&
        commit.committer.date.getTime() <= stashDate
      ) {
        index = i
        break
      }
    }
    result.splice(index, 0, stash.sha)
  }

  return result
}

/**
 * A key that changes whenever anything drawn by the commit graph moves:
 * HEAD, any branch tip, any tag or any stash.
 */
export function getGraphRefsKey(
  headSha: string | null,
  branches: ReadonlyArray<Branch>,
  tags: Map<string, string> | null,
  stashes: ReadonlyArray<IGraphStash>
): string {
  const parts = [`HEAD ${headSha}`]
  for (const b of branches) {
    parts.push(`${b.ref} ${b.tip.sha} ${b.upstream}`)
  }
  for (const [name, sha] of tags ?? []) {
    parts.push(`tag ${name} ${sha}`)
  }
  for (const s of stashes) {
    parts.push(`stash ${s.sha}`)
  }
  return parts.join('\n')
}
