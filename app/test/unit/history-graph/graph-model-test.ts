import { describe, it } from 'node:test'
import assert from 'node:assert'
import { Commit } from '../../../src/models/commit'
import { CommitIdentity } from '../../../src/models/commit-identity'
import { Branch, BranchType } from '../../../src/models/branch'
import {
  buildGraph,
  buildRefGroups,
  getRefsBySha,
  GraphRowType,
  IGraphInput,
  WorkDirSha,
} from '../../../src/ui/history-graph/graph-model'

let time = 1_000_000

/** Build commits from `sha:parent1,parent2` specs, newest first. */
function makeCommits(specs: ReadonlyArray<string>) {
  const lookup = new Map<string, Commit>()
  const shas: string[] = []
  for (const spec of specs) {
    const [sha, parents] = spec.split(':')
    const identity = new CommitIdentity('A', 'a@b.c', new Date(time--))
    lookup.set(
      sha,
      new Commit(
        sha,
        sha.slice(0, 7),
        `summary ${sha}`,
        '',
        identity,
        identity,
        parents ? parents.split(',') : [],
        [],
        []
      )
    )
    shas.push(sha)
  }
  return { lookup, shas }
}

function local(name: string, sha: string) {
  return new Branch(name, null, { sha }, BranchType.Local, `refs/heads/${name}`)
}

function remote(name: string, sha: string) {
  return new Branch(
    name,
    null,
    { sha },
    BranchType.Remote,
    `refs/remotes/${name}`
  )
}

function graphFor(
  specs: ReadonlyArray<string>,
  options: Partial<IGraphInput> = {}
) {
  const { lookup, shas } = makeCommits(specs)
  return buildGraph({
    commitSHAs: shas,
    commitLookup: lookup,
    stashShas: new Set(),
    branches: [],
    tags: null,
    headSha: shas[0] ?? null,
    currentBranchName: null,
    workDirChangeCount: 0,
    hiddenRefs: new Set(),
    soloRefs: new Set(),
    pinnedRef: null,
    searchText: '',
    ...options,
  })
}

const columnsOf = (graph: ReturnType<typeof buildGraph>) =>
  graph.rows.map(r => `${r.sha}${r.column}`).join(' ')

describe('graph model', () => {
  it('keeps a linear history in one lane', () => {
    const graph = graphFor(['c:b', 'b:a', 'a'])
    assert.equal(columnsOf(graph), 'c0 b0 a0')
    assert.equal(graph.columnCount, 1)
    assert.ok(graph.rows[0].edges.get(0)?.starting)
    assert.equal(graph.rows[1].edges.get(0)?.ending?.parentSha, 'b')
    assert.equal(graph.rows[1].edges.get(0)?.starting?.parentSha, 'a')
  })

  it('opens a second lane for a merged branch', () => {
    const graph = graphFor(['m:a,f', 'f:a', 'a'])
    assert.equal(columnsOf(graph), 'm0 f1 a0')
    assert.equal(graph.rows[0].type, GraphRowType.Merge)
    assert.equal(graph.rows[0].edges.get(1)?.starting?.parentSha, 'f')
    // The feature lane joins its parent in lane 0.
    assert.equal(graph.rows[2].edges.get(1)?.ending?.parentSha, 'a')
  })

  it('moves a shared parent to the leftmost child lane', () => {
    const graph = graphFor(['x:a', 'y:a', 'a'])
    assert.equal(columnsOf(graph), 'x0 y1 a0')
  })

  it('reuses a lane once the branch in it has ended', () => {
    const graph = graphFor(['x:a', 'y:a', 'a:r', 'z:r', 'r'])
    assert.equal(columnsOf(graph), 'x0 y1 a0 z1 r0')
  })

  it('draws stashes with dashed edges and only their base parent', () => {
    const { lookup, shas } = makeCommits(['s:b,i', 'b:a', 'a'])
    const graph = buildGraph({
      commitSHAs: shas,
      commitLookup: lookup,
      stashShas: new Set(['s']),
      branches: [],
      tags: null,
      headSha: 'b',
      currentBranchName: null,
      workDirChangeCount: 0,
      hiddenRefs: new Set(),
      soloRefs: new Set(),
      pinnedRef: null,
      searchText: '',
    })
    const stash = graph.rows[0]
    assert.equal(stash.type, GraphRowType.Stash)
    assert.deepEqual(stash.parents, ['b'])
    assert.equal(stash.edges.get(stash.column)?.starting?.dashed, true)
  })

  it('adds a work in progress row above HEAD', () => {
    const graph = graphFor(['b:a', 'a'], { workDirChangeCount: 2 })
    assert.equal(graph.rows[0].sha, WorkDirSha)
    assert.equal(graph.rows[0].type, GraphRowType.WorkDir)
    assert.equal(graph.rows[1].isHead, true)
  })

  it('gives a pinned branch column 0', () => {
    const graph = graphFor(['x:a', 'y:a', 'a'], {
      branches: [local('x', 'x'), local('y', 'y')],
      pinnedRef: 'refs/heads/y',
    })
    assert.equal(columnsOf(graph), 'x1 y0 a0')
  })

  it('hides commits only reachable from hidden refs', () => {
    const graph = graphFor(['x:a', 'y:a', 'a'], {
      branches: [local('x', 'x'), local('y', 'y')],
      hiddenRefs: new Set(['refs/heads/y']),
    })
    assert.deepEqual(
      graph.rows.map(r => r.sha),
      ['x', 'a']
    )
  })

  it('solo shows only the chosen refs', () => {
    const graph = graphFor(['x:a', 'y:a', 'a'], {
      branches: [local('x', 'x'), local('y', 'y')],
      soloRefs: new Set(['refs/heads/y']),
    })
    assert.deepEqual(
      graph.rows.map(r => r.sha),
      ['y', 'a']
    )
  })

  it('puts every search match in column 0 and keeps its colour', () => {
    const graph = graphFor(['m:a,f', 'f:a', 'a'], { searchText: 'summary f' })
    assert.equal(graph.rows.length, 1)
    assert.equal(graph.rows[0].column, 0)
    assert.equal(graph.rows[0].colorColumn, 1)
  })

  it('groups local and remote refs with the same name', () => {
    const refs = getRefsBySha(
      [local('main', 'a'), remote('origin/main', 'a'), local('dev', 'a')],
      new Map([['v1', 'a']]),
      'dev'
    ).get('a')!
    const groups = buildRefGroups(refs, null)
    assert.deepEqual(
      groups.map(g => `${g.name}:${g.refs.length}`),
      ['dev:1', 'main:2', 'v1:1']
    )
    assert.equal(groups[1].refs[0].name, 'main')
    assert.equal(groups[1].refs[1].name, 'origin/main')
  })
})
