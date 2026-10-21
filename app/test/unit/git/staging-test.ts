import { describe, it } from 'node:test'
import assert from 'node:assert'
import { writeFile } from 'fs/promises'
import * as path from 'path'
import { exec } from 'dugite'
import { Repository } from '../../../src/models/repository'
import { setupEmptyRepository } from '../../helpers/repositories'
import { getStatus } from '../../../src/lib/git/status'
import {
  getStagingDiff,
  stageAllToIndex,
  stageFilesToIndex,
  stageLinesToIndex,
  unstageAllFromIndex,
  unstageFilesFromIndex,
  unstageLinesFromIndex,
} from '../../../src/lib/git/staging'
import { splitStagedFiles } from '../../../src/lib/staging'
import {
  DiffLineType,
  DiffSelection,
  DiffSelectionType,
  DiffType,
  ITextDiff,
} from '../../../src/models/diff'
import { WorkingDirectoryFileChange } from '../../../src/models/status'

async function git(repository: Repository, ...args: string[]) {
  return exec(args, repository.path)
}

async function write(repository: Repository, name: string, contents: string) {
  await writeFile(path.join(repository.path, name), contents)
}

async function lists(repository: Repository) {
  const status = await getStatus(repository)
  assert.ok(status !== null)
  const { unstaged, staged } = splitStagedFiles(status.workingDirectory.files)
  return {
    files: status.workingDirectory.files,
    unstaged: unstaged.map(f => f.path),
    staged: staged.map(f => f.path),
  }
}

async function file(repository: Repository, name: string) {
  const { files } = await lists(repository)
  const found = files.find(f => f.path === name)
  assert.ok(found !== undefined, `${name} has no changes`)
  return found
}

async function textDiff(
  repository: Repository,
  f: WorkingDirectoryFileChange,
  staged: boolean
) {
  const diff = await getStagingDiff(repository, f, staged)
  assert.equal(diff.kind, DiffType.Text)
  return diff as ITextDiff
}

/** A selection of only the changed lines whose text matches. */
function selectLines(diff: ITextDiff, ...texts: string[]) {
  let selection = DiffSelection.fromInitialSelection(DiffSelectionType.None)
  for (const hunk of diff.hunks) {
    hunk.lines.forEach((line, i) => {
      const isChange =
        line.type === DiffLineType.Add || line.type === DiffLineType.Delete
      if (isChange && texts.includes(line.content)) {
        selection = selection.withLineSelection(hunk.unifiedDiffStart + i, true)
      }
    })
  }
  return selection
}

async function stagedContents(repository: Repository, name: string) {
  return (await git(repository, 'show', `:${name}`)).stdout
}

describe('git staging', () => {
  it('splits files into unstaged and staged lists', async t => {
    const repo = await setupEmptyRepository(t)
    await write(repo, 'a.txt', 'one\n')
    await write(repo, 'b.txt', 'two\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'init')

    await write(repo, 'a.txt', 'one\nmore\n')
    await write(repo, 'b.txt', 'two\nmore\n')
    await write(repo, 'new.txt', 'new\n')
    await git(repo, 'add', 'b.txt')
    await write(repo, 'b.txt', 'two\nmore\nagain\n')

    const { unstaged, staged } = await lists(repo)
    assert.deepEqual(unstaged.sort(), ['a.txt', 'b.txt', 'new.txt'])
    assert.deepEqual(staged, ['b.txt'])
  })

  it('stages and unstages whole files', async t => {
    const repo = await setupEmptyRepository(t)
    await write(repo, 'a.txt', 'one\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'init')
    await write(repo, 'a.txt', 'changed\n')
    await write(repo, 'new.txt', 'new\n')
    await git(repo, 'rm', '-q', '--cached', 'a.txt')
    await git(repo, 'add', 'a.txt')

    const { files } = await lists(repo)
    await unstageAllFromIndex(repo)
    assert.deepEqual((await lists(repo)).staged, [])

    await stageFilesToIndex(
      repo,
      files.filter(f => f.path === 'new.txt')
    )
    assert.deepEqual((await lists(repo)).staged, ['new.txt'])

    await stageAllToIndex(repo)
    assert.deepEqual((await lists(repo)).staged.sort(), ['a.txt', 'new.txt'])
    assert.deepEqual((await lists(repo)).unstaged, [])

    await unstageFilesFromIndex(repo, [await file(repo, 'a.txt')])
    assert.deepEqual((await lists(repo)).staged, ['new.txt'])
  })

  it('stages and unstages selected lines', async t => {
    const repo = await setupEmptyRepository(t)
    await write(repo, 'a.txt', 'one\ntwo\nthree\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'init')
    await write(repo, 'a.txt', 'ONE\ntwo\nTHREE\n')

    const unstagedDiff = await textDiff(repo, await file(repo, 'a.txt'), false)
    await stageLinesToIndex(
      repo,
      await file(repo, 'a.txt'),
      unstagedDiff,
      selectLines(unstagedDiff, 'one', 'ONE')
    )
    assert.equal(await stagedContents(repo, 'a.txt'), 'ONE\ntwo\nthree\n')
    const both = await lists(repo)
    assert.deepEqual(both.staged, ['a.txt'])
    assert.deepEqual(both.unstaged, ['a.txt'])

    await stageFilesToIndex(repo, [await file(repo, 'a.txt')])
    assert.equal(await stagedContents(repo, 'a.txt'), 'ONE\ntwo\nTHREE\n')

    const stagedDiff = await textDiff(repo, await file(repo, 'a.txt'), true)
    await unstageLinesFromIndex(
      repo,
      await file(repo, 'a.txt'),
      stagedDiff,
      selectLines(stagedDiff, 'three', 'THREE')
    )
    assert.equal(await stagedContents(repo, 'a.txt'), 'ONE\ntwo\nthree\n')
  })

  it('stages part of an untracked file', async t => {
    const repo = await setupEmptyRepository(t)
    await write(repo, 'base.txt', 'base\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'init')
    await write(repo, 'new.txt', 'keep\nskip\n')

    const diff = await textDiff(repo, await file(repo, 'new.txt'), false)
    await stageLinesToIndex(
      repo,
      await file(repo, 'new.txt'),
      diff,
      selectLines(diff, 'keep')
    )
    assert.equal(await stagedContents(repo, 'new.txt'), 'keep\n')
    const { staged, unstaged } = await lists(repo)
    assert.deepEqual(staged, ['new.txt'])
    assert.deepEqual(unstaged, ['new.txt'])
  })
})
