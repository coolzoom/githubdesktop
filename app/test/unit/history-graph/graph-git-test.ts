import { describe, it } from 'node:test'
import assert from 'node:assert'
import { writeFile } from 'fs/promises'
import * as path from 'path'
import { exec } from 'dugite'
import { Repository } from '../../../src/models/repository'
import { setupEmptyRepository } from '../../helpers/repositories'
import {
  getBranchTracking,
  getGraphCommits,
  getGraphStashes,
  GraphCommitOrder,
} from '../../../src/lib/git/graph'
import { getCommits } from '../../../src/lib/git'
import {
  addRemote,
  editRemote,
  getRemotePushUrl,
  dropCommits,
  renameStash,
  rewordCommit,
} from '../../../src/ui/history-graph/graph-git-actions'

async function git(repository: Repository, ...args: string[]) {
  const result = await exec(args, repository.path)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}

async function commitFile(repository: Repository, name: string) {
  await writeFile(path.join(repository.path, name), `${name}\n`)
  await git(repository, 'add', name)
  await git(repository, 'commit', '-m', `add ${name}`)
  return git(repository, 'rev-parse', 'HEAD')
}

async function summaries(repository: Repository) {
  const commits = await getCommits(repository, 'HEAD', 10)
  return commits.map(c => c.summary)
}

describe('history graph git', () => {
  it('loads commits from every branch, not just HEAD', async t => {
    const repo = await setupEmptyRepository(t)
    await commitFile(repo, 'a')
    await git(repo, 'checkout', '-b', 'feature')
    const feature = await commitFile(repo, 'b')
    await git(repo, 'checkout', '-')
    const main = await commitFile(repo, 'c')

    const shas = (await getGraphCommits(repo, 100, 0)).map(c => c.sha)
    assert.ok(shas.includes(feature))
    assert.ok(shas.includes(main))
    assert.equal(shas.length, 3)
  })

  it('keeps a branch together in topo order but not in date order', async t => {
    const repo = await setupEmptyRepository(t)
    await commitFile(repo, 'base')
    const main = await git(repo, 'branch', '--show-current')
    const date = (n: number) => ({ GIT_COMMITTER_DATE: `${n} +0000` })
    const commitAt = async (name: string, at: number) => {
      await writeFile(path.join(repo.path, name), name)
      await git(repo, 'add', name)
      const r = await exec(['commit', '-m', name], repo.path, {
        env: { ...process.env, ...date(at) },
      })
      assert.equal(r.exitCode, 0, r.stderr)
    }
    await git(repo, 'checkout', '-b', 'feature')
    await commitAt('f1', 2000000000)
    await commitAt('f2', 2000000020)
    await git(repo, 'checkout', main)
    await commitAt('m1', 2000000010)
    await git(repo, 'merge', '--no-ff', '-m', 'merge', 'feature')

    const summariesIn = async (order: GraphCommitOrder) =>
      (await getGraphCommits(repo, 100, 0, order)).map(c => c.summary)

    assert.deepEqual((await summariesIn(GraphCommitOrder.Date)).slice(1, 4), [
      'f2',
      'm1',
      'f1',
    ])
    const topo = await summariesIn(GraphCommitOrder.Topo)
    assert.equal(
      Math.abs(topo.indexOf('f1') - topo.indexOf('f2')),
      1,
      topo.join(', ')
    )
  })

  it('adds, fetches and edits a remote with a separate push URL', async t => {
    const upstream = await setupEmptyRepository(t)
    const upstreamTip = await commitFile(upstream, 'a')
    const repo = await setupEmptyRepository(t)

    await addRemote(repo, 'upstream', upstream.path, '/tmp/push-target')
    const branch = await git(upstream, 'branch', '--show-current')
    assert.equal(
      await git(repo, 'rev-parse', `upstream/${branch}`),
      upstreamTip
    )
    assert.equal(await getRemotePushUrl(repo, 'upstream'), '/tmp/push-target')

    await editRemote(repo, 'upstream', 'source', upstream.path, '')
    assert.equal(await git(repo, 'remote'), 'source')
    assert.equal(await getRemotePushUrl(repo, 'source'), null)
    assert.equal(await git(repo, 'remote', 'get-url', 'source'), upstream.path)
  })

  it('lists stashes with their parents', async t => {
    const repo = await setupEmptyRepository(t)
    assert.deepEqual(await getGraphStashes(repo), [])

    const base = await commitFile(repo, 'a')
    await writeFile(path.join(repo.path, 'a'), 'changed\n')
    await git(repo, 'stash', 'push', '-m', 'my work')

    const stashes = await getGraphStashes(repo)
    assert.equal(stashes.length, 1)
    assert.equal(stashes[0].name, 'stash@{0}')
    assert.equal(stashes[0].parents[0], base)
    assert.match(stashes[0].message, /my work/)
  })

  it('renames a stash without changing its contents', async t => {
    const repo = await setupEmptyRepository(t)
    await commitFile(repo, 'a')
    await writeFile(path.join(repo.path, 'a'), 'changed\n')
    await git(repo, 'stash', 'push', '-m', 'old name')
    const [before] = await getGraphStashes(repo)

    await renameStash(repo, before.name, before.sha, 'new name')

    const after = await getGraphStashes(repo)
    assert.equal(after.length, 1)
    assert.equal(after[0].sha, before.sha)
    assert.equal(after[0].message, 'new name')
  })

  it('reports ahead and behind counts against the upstream', async t => {
    const repo = await setupEmptyRepository(t)
    await commitFile(repo, 'a')
    await git(repo, 'branch', 'upstream')
    await git(repo, 'branch', '--set-upstream-to=upstream')
    await commitFile(repo, 'b')
    await commitFile(repo, 'c')

    const current = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    const tracking = (await getBranchTracking(repo)).get(current)
    assert.deepEqual(tracking, { ahead: 2, behind: 0, gone: false })
  })

  it('drops a commit from the middle of the branch', async t => {
    const repo = await setupEmptyRepository(t)
    await commitFile(repo, 'a')
    const b = await commitFile(repo, 'b')
    await commitFile(repo, 'c')

    const [commit] = await getCommits(repo, b, 1)
    await dropCommits(repo, [commit], commit)

    assert.deepEqual(await summaries(repo), ['add c', 'add a'])
  })

  it('rewords a commit below HEAD', async t => {
    const repo = await setupEmptyRepository(t)
    await commitFile(repo, 'a')
    const b = await commitFile(repo, 'b')
    await commitFile(repo, 'c')

    const [commit] = await getCommits(repo, b, 1)
    await rewordCommit(repo, commit, 'better message\n\nwith a body', false)

    assert.deepEqual(await summaries(repo), [
      'add c',
      'better message',
      'add a',
    ])
    const [reworded] = await getCommits(repo, 'HEAD~1', 1)
    assert.equal(reworded.body.trim(), 'with a body')
  })

  it('rewords HEAD without committing staged changes', async t => {
    const repo = await setupEmptyRepository(t)
    await commitFile(repo, 'a')
    await writeFile(path.join(repo.path, 'staged'), 'x\n')
    await git(repo, 'add', 'staged')

    const [head] = await getCommits(repo, 'HEAD', 1)
    await rewordCommit(repo, head, 'renamed', true)

    assert.deepEqual(await summaries(repo), ['renamed'])
    const staged = await git(repo, 'diff', '--cached', '--name-only')
    assert.equal(staged, 'staged')
  })
})
