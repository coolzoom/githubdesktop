import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  ConflictMerge,
  merge3,
  MergeSide,
  splitLines,
} from '../../src/lib/conflict-merge'

const lines = (s: string) => splitLines(s)

describe('conflict merge', () => {
  it('merges changes to different lines without conflicts', () => {
    const chunks = merge3(
      lines('a\nB\nc\nd\n'),
      lines('a\nb\nc\nd\n'),
      lines('a\nb\nc\nD\n')
    )
    assert.ok(chunks.every(c => !c.isConflict))
    assert.deepEqual(
      chunks.flatMap(c => c.ok),
      lines('a\nB\nc\nD\n')
    )
  })

  it('reports overlapping changes as a conflict with the ancestor', () => {
    const merge = ConflictMerge.fromTexts(
      'one\ntwo\nthree\n',
      'one\nours\nthree\n',
      'one\ntheirs\nthree\n'
    )
    assert.equal(merge.conflictCount, 1)
    const [conflict] = merge.conflicts
    assert.deepEqual(conflict.a, ['ours'])
    assert.deepEqual(conflict.b, ['theirs'])
    assert.deepEqual(conflict.base, ['two'])
    assert.equal(merge.result(), 'one\ntwo\nthree\n')
  })

  it('merges identical changes on both sides', () => {
    const merge = ConflictMerge.fromTexts('x\n', 'y\n', 'y\n')
    assert.equal(merge.conflictCount, 0)
    assert.equal(merge.result(), 'y\n')
  })

  it('keeps picked lines in the order they were picked', () => {
    const merge = ConflictMerge.fromTexts(
      'one\ntwo\nthree\n',
      'one\nours\nthree\n',
      'one\ntheirs\nthree\n'
    )
    merge.select(0, MergeSide.B, 0)
    merge.select(0, MergeSide.A, 0)
    assert.equal(merge.result(), 'one\ntheirs\nours\nthree\n')
    assert.equal(merge.isWholeSideTaken(MergeSide.A), true)
    merge.toggleAll(MergeSide.A)
    assert.equal(merge.result(), 'one\ntheirs\nthree\n')
    merge.toggleAll(MergeSide.A)
    merge.untakeSide(0, MergeSide.B)
    assert.equal(merge.result(), 'one\nours\nthree\n')
    merge.reset()
    assert.equal(merge.unresolvedCount, 1)
  })

  it('writes conflict markers for untouched conflicts on request', () => {
    const merge = ConflictMerge.fromTexts('a\nb\n', 'a\nB1\n', 'a\nB2\n')
    assert.equal(merge.result(true), 'a\n<<<<<<<\nB1\n=======\nB2\n>>>>>>>\n')
  })

  it('treats a side that deleted the lines as one blank, empty pick', () => {
    const merge = ConflictMerge.fromTexts('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n')
    assert.equal(merge.conflictCount, 1)
    assert.equal(merge.conflicts[0].aIsEmpty, true)
    merge.takeSide(0, MergeSide.A)
    assert.equal(merge.result(), 'a\nc\n')
  })

  it('keeps CRLF line endings and a byte order mark', () => {
    const merge = ConflictMerge.fromTexts(
      '\uFEFFa\r\nb\r\n',
      '\uFEFFa\r\nx\r\n',
      '\uFEFFa\r\ny\r\n'
    )
    merge.takeSide(0, MergeSide.B)
    assert.equal(merge.result(), '\uFEFFa\r\ny\r\n')
  })

  it('shows every side in full across clean runs', () => {
    const merge = ConflictMerge.fromTexts(
      'h\nm\nt\n',
      'H\nm1\nt\n',
      'h\nm2\nt\nend\n'
    )
    const side = (s: MergeSide) => merge.hunks.flatMap(h => h.lines(s))
    assert.deepEqual(side(MergeSide.A), lines('H\nm1\nt\n'))
    assert.deepEqual(side(MergeSide.B), lines('h\nm2\nt\nend\n'))
  })
})
