import { describe, it } from 'node:test'
import assert from 'node:assert'
import { writeFile } from 'fs/promises'
import * as path from 'path'
import { exec } from 'dugite'
import {
  applyLineChange,
  diffLines,
  splitLines,
} from '../../src/ui/editor/line-diff'
import {
  getIndexFileContents,
  setIndexFileContents,
} from '../../src/lib/git/index-file'
import { setupEmptyRepository } from '../helpers/repositories'

const lines = (text: string) => splitLines(text)

/** Rebuild `modified` from `original` and the changes to check them. */
function replay(original: string[], modified: string[]) {
  const changes = diffLines(original, modified)
  assert.ok(changes !== null)
  let result = [...original]
  for (const change of [...changes].reverse()) {
    result = [...applyLineChange(result, modified, change)]
  }
  assert.deepStrictEqual(result, modified)
  return changes
}

describe('editor line diff', () => {
  it('finds insertions, deletions and modifications', () => {
    const changes = diffLines(lines('a\nb\nc\nd\ne'), lines('a\nB\nc\ne\nf'))
    assert.deepStrictEqual(changes, [
      {
        originalStart: 1,
        originalLength: 1,
        modifiedStart: 1,
        modifiedLength: 1,
      },
      {
        originalStart: 3,
        originalLength: 1,
        modifiedStart: 3,
        modifiedLength: 0,
      },
      {
        originalStart: 5,
        originalLength: 0,
        modifiedStart: 4,
        modifiedLength: 1,
      },
    ])
  })

  it('reports nothing for identical text', () => {
    assert.deepStrictEqual(diffLines(lines('a\nb'), lines('a\nb')), [])
  })

  it('handles empty files on either side', () => {
    assert.deepStrictEqual(diffLines([], ['x', 'y']), [
      {
        originalStart: 0,
        originalLength: 0,
        modifiedStart: 0,
        modifiedLength: 2,
      },
    ])
    assert.deepStrictEqual(diffLines(['x'], []), [
      {
        originalStart: 0,
        originalLength: 1,
        modifiedStart: 0,
        modifiedLength: 0,
      },
    ])
  })

  it('produces changes that rebuild the modified text', () => {
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 200; i++) {
      const original = Array.from({ length: Math.floor(random() * 30) }, () =>
        String.fromCharCode(97 + Math.floor(random() * 4))
      )
      const modified = original
        .filter(() => random() > 0.2)
        .flatMap(l =>
          random() > 0.8 ? [l, 'new'] : [random() > 0.9 ? 'X' : l]
        )
      replay(original, modified)
    }
  })
})

describe('index file contents', () => {
  it('reads and replaces the staged version of a file', async t => {
    const repo = await setupEmptyRepository(t)
    await writeFile(path.join(repo.path, 'a.txt'), 'one\ntwo\n')
    assert.equal(await getIndexFileContents(repo, 'a.txt'), null)

    await exec(['add', 'a.txt'], repo.path)
    assert.equal(
      (await getIndexFileContents(repo, 'a.txt'))?.toString(),
      'one\ntwo\n'
    )

    await setIndexFileContents(repo, 'a.txt', 'one\nTWO\n')
    assert.equal(
      (await getIndexFileContents(repo, 'a.txt'))?.toString(),
      'one\nTWO\n'
    )
    const diff = await exec(['diff', '--cached', '--name-only'], repo.path)
    assert.equal(diff.stdout.trim(), 'a.txt')

    await writeFile(path.join(repo.path, 'new.txt'), 'x\n')
    await setIndexFileContents(repo, 'new.txt', 'x\n')
    const status = await exec(['status', '--porcelain'], repo.path)
    assert.match(status.stdout, /^A {2}new\.txt$/m)
  })
})
