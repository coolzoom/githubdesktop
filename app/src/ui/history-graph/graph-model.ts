import { Branch, BranchType } from '../../models/branch'
import { Commit } from '../../models/commit'

/** The number of lane colours; lanes past this wrap around. */
export const NumGraphColors = 10

/** The SHA used for the synthetic "work in progress" row. */
export const WorkDirSha = 'WORKDIR'

export enum GraphRowType {
  Commit = 'commit',
  Merge = 'merge',
  Stash = 'stash',
  WorkDir = 'workdir',
}

export enum GraphRefKind {
  Local = 'local',
  Remote = 'remote',
  Tag = 'tag',
}

export interface IGraphRef {
  readonly kind: GraphRefKind
  /** Fully qualified ref, e.g. `refs/heads/main`, used for hide/solo/pin */
  readonly id: string
  /** Display name, e.g. `main`, `origin/main` or `v1.0` */
  readonly name: string
  /** Name without the remote, used for grouping */
  readonly shortName: string
  readonly sha: string
  readonly isCurrent: boolean
  readonly branch: Branch | null
  readonly remoteName: string | null
}

export interface IGraphRefGroup {
  readonly key: string
  readonly name: string
  readonly refs: ReadonlyArray<IGraphRef>
  readonly hasCurrent: boolean
  readonly isPinned: boolean
}

export interface IGraphEdge {
  readonly parentSha: string
  readonly dashed: boolean
}

export interface IGraphColumnEdges {
  starting?: IGraphEdge
  ending?: IGraphEdge
  passThrough?: IGraphEdge
}

export interface IGraphRow {
  readonly sha: string
  readonly type: GraphRowType
  readonly parents: ReadonlyArray<string>
  readonly column: number
  /** The column whose colour the node uses (differs in search mode) */
  readonly colorColumn: number
  readonly edges: ReadonlyMap<number, IGraphColumnEdges>
  readonly refGroups: ReadonlyArray<IGraphRefGroup>
  readonly isHead: boolean
}

export interface IGraph {
  readonly rows: ReadonlyArray<IGraphRow>
  /** Highest column index used by any node or edge, plus one */
  readonly columnCount: number
  readonly rowIndexBySha: ReadonlyMap<string, number>
}

export interface IGraphInput {
  /** Newest first, as loaded from `git log --date-order` plus stashes */
  readonly commitSHAs: ReadonlyArray<string>
  readonly commitLookup: Map<string, Commit>
  readonly stashShas: ReadonlySet<string>
  readonly branches: ReadonlyArray<Branch>
  readonly tags: Map<string, string> | null
  readonly headSha: string | null
  readonly currentBranchName: string | null
  readonly workDirChangeCount: number
  readonly hiddenRefs: ReadonlySet<string>
  readonly soloRefs: ReadonlySet<string>
  readonly pinnedRef: string | null
  readonly searchText: string
}

interface IRowSource {
  readonly sha: string
  readonly type: GraphRowType
  readonly parents: ReadonlyArray<string>
  readonly date: number
}

export function colorIndex(column: number) {
  return column % NumGraphColors
}

/** Collect every ref the graph draws, keyed by the commit it points at. */
export function getRefsBySha(
  branches: ReadonlyArray<Branch>,
  tags: Map<string, string> | null,
  currentBranchName: string | null
): Map<string, IGraphRef[]> {
  const refs = new Map<string, IGraphRef[]>()
  const add = (ref: IGraphRef) => {
    const list = refs.get(ref.sha)
    if (list === undefined) {
      refs.set(ref.sha, [ref])
    } else {
      list.push(ref)
    }
  }

  for (const branch of branches) {
    if (branch.isDesktopForkRemoteBranch) {
      continue
    }
    const isLocal = branch.type === BranchType.Local
    if (!isLocal && branch.nameWithoutRemote === 'HEAD') {
      continue
    }
    add({
      kind: isLocal ? GraphRefKind.Local : GraphRefKind.Remote,
      id: branch.ref,
      name: branch.name,
      shortName: branch.nameWithoutRemote,
      sha: branch.tip.sha,
      isCurrent: isLocal && branch.name === currentBranchName,
      branch,
      remoteName: isLocal ? null : branch.remoteName,
    })
  }

  for (const [name, sha] of tags ?? []) {
    add({
      kind: GraphRefKind.Tag,
      id: `refs/tags/${name}`,
      name,
      shortName: name,
      sha,
      isCurrent: false,
      branch: null,
      remoteName: null,
    })
  }

  return refs
}

const refKindPriority = {
  [GraphRefKind.Local]: 2,
  [GraphRefKind.Remote]: 1,
  [GraphRefKind.Tag]: 0,
}

/**
 * Group refs that share a name (`main` and `origin/main`) and sort the groups
 * the way the ref column shows them: current branch, pinned, type, size, name.
 */
export function buildRefGroups(
  refs: ReadonlyArray<IGraphRef>,
  pinnedRef: string | null
): ReadonlyArray<IGraphRefGroup> {
  const byKey = new Map<string, IGraphRef[]>()
  for (const ref of refs) {
    const key =
      ref.kind === GraphRefKind.Tag ? `tag:${ref.name}` : `ref:${ref.shortName}`
    const list = byKey.get(key)
    if (list === undefined) {
      byKey.set(key, [ref])
    } else {
      list.push(ref)
    }
  }

  const groups: IGraphRefGroup[] = []
  for (const [key, list] of byKey) {
    const sorted = list.toSorted(
      (a, b) =>
        refKindPriority[b.kind] - refKindPriority[a.kind] ||
        a.name.localeCompare(b.name)
    )
    groups.push({
      key,
      name: sorted[0].shortName,
      refs: sorted,
      hasCurrent: sorted.some(r => r.isCurrent),
      isPinned: pinnedRef !== null && sorted.some(r => r.id === pinnedRef),
    })
  }

  const priority = (g: IGraphRefGroup) =>
    Math.max(...g.refs.map(r => refKindPriority[r.kind]))

  return groups.sort(
    (a, b) =>
      Number(b.hasCurrent) - Number(a.hasCurrent) ||
      Number(b.isPinned) - Number(a.isPinned) ||
      priority(b) - priority(a) ||
      b.refs.length - a.refs.length ||
      a.name.localeCompare(b.name)
  )
}

function isRefVisible(
  ref: IGraphRef,
  hiddenRefs: ReadonlySet<string>,
  soloRefs: ReadonlySet<string>
) {
  if (soloRefs.size > 0 && !soloRefs.has(ref.id)) {
    return false
  }
  return !hiddenRefs.has(ref.id)
}

/** The first-parent chain of `tipSha` within the loaded rows. */
function getFirstParentChain(
  tipSha: string | null,
  rowsBySha: ReadonlyMap<string, IRowSource>
): Set<string> {
  const chain = new Set<string>()
  let sha: string | undefined = tipSha ?? undefined
  while (sha !== undefined && !chain.has(sha)) {
    chain.add(sha)
    const row = rowsBySha.get(sha)
    sha = row?.parents[0]
  }
  return chain
}

export interface ILaneAssignment {
  readonly columns: ReadonlyMap<string, number>
  /** For each row, the column in which the edge to each parent starts */
  readonly parentColumns: ReadonlyMap<string, ReadonlyArray<number>>
}

interface IReservation {
  column: number
  type: GraphRowType
  newestDate: number
}

/**
 * Assign each row a lane. Walks newest to oldest; a commit continues the lane
 * of the child that reserved it, first parents stay in their child's lane, and
 * second parents open new lanes at the leftmost free column.
 */
export function assignColumns(
  rows: ReadonlyArray<IRowSource>,
  pinned: ReadonlySet<string>
): ILaneAssignment {
  const used = new Set<number>()
  const reserved = new Map<string, IReservation>()
  const freeWhenFound = new Map<string, number[]>()
  const hasMergeChild = new Set<string>()
  const columns = new Map<string, number>()
  const parentColumns = new Map<string, number[]>()
  const base = pinned.size > 0 ? 1 : 0

  const firstFree = (start: number) => {
    let c = start
    while (used.has(c)) {
      c++
    }
    used.add(c)
    return c
  }

  const addFree = (sha: string, column: number) => {
    const list = freeWhenFound.get(sha)
    if (list === undefined) {
      freeWhenFound.set(sha, [column])
    } else {
      list.push(column)
    }
  }

  for (const row of rows) {
    hasMergeChild.delete(row.sha)
    for (const c of freeWhenFound.get(row.sha) ?? []) {
      used.delete(c)
    }
    freeWhenFound.delete(row.sha)

    const mine = reserved.get(row.sha)
    let col: number
    if (pinned.has(row.sha)) {
      col = 0
      used.add(0)
      if (mine !== undefined && mine.column !== 0) {
        used.delete(mine.column)
      }
      reserved.delete(row.sha)
    } else if (mine !== undefined) {
      col = mine.column
      reserved.delete(row.sha)
    } else {
      col = firstFree(base)
    }
    columns.set(row.sha, col)

    const startColumns: number[] = []
    parentColumns.set(row.sha, startColumns)
    row.parents.forEach((p, i) => {
      if (row.type === GraphRowType.Merge) {
        hasMergeChild.add(p)
      }
      const r = reserved.get(p)
      if (i === 0 && r !== undefined && r.column !== col) {
        const newestDate = mine?.newestDate ?? row.date
        const stashYields =
          r.type === GraphRowType.Stash &&
          row.type !== GraphRowType.Stash &&
          newestDate > r.newestDate
        if (
          (r.column > col || stashYields) &&
          !hasMergeChild.has(p) &&
          !pinned.has(p)
        ) {
          reserved.set(p, { column: col, type: row.type, newestDate })
          addFree(p, r.column)
        } else {
          addFree(p, col)
        }
      } else if (r === undefined) {
        const c = pinned.has(p) ? 0 : i === 0 ? col : firstFree(base)
        if (c === 0 && pinned.has(p)) {
          used.add(0)
          if (i === 0 && col !== 0) {
            addFree(p, col)
          }
        }
        const newestDate =
          mine !== undefined && mine.column === col ? mine.newestDate : row.date
        reserved.set(p, { column: c, type: row.type, newestDate })
      }
      startColumns.push(i === 0 ? col : reserved.get(p)?.column ?? col)
    })

    // A root commit (or a stash/WIP row whose lane ends) frees nothing via
    // its parents, so release its own lane once it is drawn.
    if (row.parents.length === 0) {
      used.delete(col)
    }
  }

  return { columns, parentColumns }
}

function isDashedType(type: GraphRowType) {
  return type === GraphRowType.Stash || type === GraphRowType.WorkDir
}

function pickEdge(edges: IGraphColumnEdges): IGraphEdge | undefined {
  const { passThrough, starting } = edges
  if (passThrough !== undefined && !passThrough.dashed) {
    return passThrough
  }
  if (starting !== undefined && !starting.dashed) {
    return starting
  }
  return passThrough ?? starting
}

/** Build the per-column edges of every row from its lane and parents. */
export function buildEdges(
  rows: ReadonlyArray<IRowSource>,
  lanes: ILaneAssignment
): { edges: Map<number, IGraphColumnEdges>[]; columnCount: number } {
  const { columns, parentColumns } = lanes
  const result: Map<number, IGraphColumnEdges>[] = []
  let prev = new Map<number, IGraphColumnEdges>()
  let columnCount = 0

  for (const row of rows) {
    const edges = new Map<number, IGraphColumnEdges>()
    const get = (c: number) => {
      let e = edges.get(c)
      if (e === undefined) {
        e = {}
        edges.set(c, e)
      }
      return e
    }

    for (const [c, prevEdges] of prev) {
      const e = pickEdge(prevEdges)
      if (e === undefined) {
        continue
      }
      if (e.parentSha === row.sha) {
        get(c).ending = e
      } else {
        get(c).passThrough = e
      }
    }

    const col = columns.get(row.sha) ?? 0
    const startColumns = parentColumns.get(row.sha) ?? []
    row.parents.forEach((p, i) => {
      const startCol = startColumns[i] ?? col
      get(startCol).starting = {
        parentSha: p,
        dashed: isDashedType(row.type),
      }
    })

    for (const c of edges.keys()) {
      columnCount = Math.max(columnCount, c + 1)
    }
    columnCount = Math.max(columnCount, col + 1)

    // An edge that already ended doesn't continue to the next row.
    const next = new Map<number, IGraphColumnEdges>()
    for (const [c, e] of edges) {
      if (e.starting !== undefined || e.passThrough !== undefined) {
        next.set(c, { starting: e.starting, passThrough: e.passThrough })
      }
    }
    prev = next
    result.push(edges)
  }

  return { edges: result, columnCount }
}

function matchesSearch(commit: Commit | undefined, text: string) {
  if (commit === undefined) {
    return false
  }
  return (
    commit.summary.toLowerCase().includes(text) ||
    commit.body.toLowerCase().includes(text) ||
    commit.sha.startsWith(text) ||
    commit.author.name.toLowerCase().includes(text) ||
    commit.author.email.toLowerCase().includes(text)
  )
}

/** Turn the loaded history into graph rows with lanes, edges and ref groups. */
export function buildGraph(input: IGraphInput): IGraph {
  const {
    commitSHAs,
    commitLookup,
    stashShas,
    headSha,
    hiddenRefs,
    soloRefs,
    pinnedRef,
  } = input

  const refsBySha = getRefsBySha(
    input.branches,
    input.tags,
    input.currentBranchName
  )

  let sources: IRowSource[] = []
  if (input.workDirChangeCount > 0 && headSha !== null) {
    sources.push({
      sha: WorkDirSha,
      type: GraphRowType.WorkDir,
      parents: [headSha],
      date: Date.now(),
    })
  }

  for (const sha of commitSHAs) {
    const commit = commitLookup.get(sha)
    if (commit === undefined) {
      continue
    }
    const isStash = stashShas.has(sha)
    const parents = isStash ? commit.parentSHAs.slice(0, 1) : commit.parentSHAs
    sources.push({
      sha,
      type: isStash
        ? GraphRowType.Stash
        : parents.length > 1
        ? GraphRowType.Merge
        : GraphRowType.Commit,
      parents,
      date: commit.committer.date.getTime(),
    })
  }

  const filtering = hiddenRefs.size > 0 || soloRefs.size > 0
  if (filtering) {
    const needed = new Set<string>()
    sources = sources.filter(row => {
      const refs = refsBySha.get(row.sha) ?? []
      const visible =
        row.type === GraphRowType.WorkDir ||
        row.type === GraphRowType.Stash ||
        needed.has(row.sha) ||
        refs.some(r => isRefVisible(r, hiddenRefs, soloRefs))
      if (visible) {
        row.parents.forEach(p => needed.add(p))
      }
      return visible
    })
  }

  const search = input.searchText.trim().toLowerCase()

  const rowsBySha = new Map(sources.map(r => [r.sha, r]))
  const pinnedTip =
    pinnedRef === null
      ? null
      : input.branches.find(b => b.ref === pinnedRef)?.tip.sha ?? null
  const pinned =
    pinnedTip !== null && rowsBySha.has(pinnedTip)
      ? getFirstParentChain(pinnedTip, rowsBySha)
      : new Set<string>()

  const lanes = assignColumns(sources, pinned)
  const { columns } = lanes

  const makeGroups = (sha: string) => {
    const refs = (refsBySha.get(sha) ?? []).filter(r =>
      filtering ? isRefVisible(r, hiddenRefs, soloRefs) : true
    )
    return buildRefGroups(refs, pinnedRef)
  }

  if (search.length > 0) {
    const rows: IGraphRow[] = []
    for (const source of sources) {
      if (
        source.type === GraphRowType.WorkDir ||
        !matchesSearch(commitLookup.get(source.sha), search)
      ) {
        continue
      }
      rows.push({
        ...source,
        column: 0,
        colorColumn: columns.get(source.sha) ?? 0,
        edges: new Map(),
        refGroups: makeGroups(source.sha),
        isHead: source.sha === headSha,
      })
    }
    return {
      rows,
      columnCount: 1,
      rowIndexBySha: new Map(rows.map((r, i) => [r.sha, i])),
    }
  }

  const { edges, columnCount } = buildEdges(sources, lanes)

  const rows = sources.map((source, i) => {
    const column = columns.get(source.sha) ?? 0
    return {
      ...source,
      column,
      colorColumn: column,
      edges: edges[i],
      refGroups: makeGroups(source.sha),
      isHead: source.sha === headSha,
    }
  })

  return {
    rows,
    columnCount: Math.max(columnCount, 1),
    rowIndexBySha: new Map(rows.map((r, i) => [r.sha, i])),
  }
}
