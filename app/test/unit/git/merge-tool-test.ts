import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFile, writeFile } from 'fs/promises'
import * as path from 'path'
import { exec } from 'dugite'
import { Repository } from '../../../src/models/repository'
import { setupEmptyRepository } from '../../helpers/repositories'
import {
  getConflictSideShas,
  loadConflictMerge,
  saveConflictResolution,
} from '../../../src/lib/git/merge-tool'
import { MergeSide } from '../../../src/lib/conflict-merge'

async function git(repository: Repository, ...args: string[]) {
  const result = await exec(args, repository.path)
  return result
}

async function commit(
  repository: Repository,
  contents: string,
  message: string
) {
  await writeFile(path.join(repository.path, 'file.txt'), contents)
  await git(repository, 'add', 'file.txt')
  const r = await git(repository, 'commit', '-m', message)
  assert.equal(r.exitCode, 0, r.stderr)
}

describe('merge tool git', () => {
  it('loads the stages of a conflicted merge and saves the picks', async t => {
    const repo = await setupEmptyRepository(t)
    await commit(repo, 'top\nmiddle\nbottom\n', 'base')
    const main = (await git(repo, 'branch', '--show-current')).stdout.trim()
    await git(repo, 'checkout', '-b', 'feature')
    await commit(repo, 'top\nfeature\nbottom\n', 'feature change')
    await git(repo, 'checkout', main)
    await commit(repo, 'TOP\nmain\nbottom\n', 'main change')

    const result = await git(repo, 'merge', 'feature')
    assert.notEqual(result.exitCode, 0)

    const merge = await loadConflictMerge(repo, 'file.txt')
    assert.ok(merge !== null)
    assert.equal(merge.conflictCount, 1)
    assert.deepEqual(merge.conflicts[0].a, ['TOP', 'main'])
    assert.deepEqual(merge.conflicts[0].b, ['top', 'feature'])

    const shas = await getConflictSideShas(repo)
    const featureSha = (await git(repo, 'rev-parse', 'feature')).stdout.trim()
    assert.equal(shas.theirs, featureSha)

    merge.select(0, MergeSide.A, 0)
    merge.select(0, MergeSide.B, 1)
    await saveConflictResolution(repo, 'file.txt', merge.result())
    assert.equal(
      await readFile(path.join(repo.path, 'file.txt'), 'utf8'),
      'TOP\nfeature\nbottom\n'
    )
  })

  it('returns null for a modify/delete conflict', async t => {
    const repo = await setupEmptyRepository(t)
    await commit(repo, 'a\n', 'base')
    const main = (await git(repo, 'branch', '--show-current')).stdout.trim()
    await git(repo, 'checkout', '-b', 'feature')
    await git(repo, 'rm', 'file.txt')
    await git(repo, 'commit', '-m', 'delete')
    await git(repo, 'checkout', main)
    await commit(repo, 'b\n', 'modify')
    await git(repo, 'merge', 'feature')

    assert.equal(await loadConflictMerge(repo, 'file.txt'), null)
  })
})
