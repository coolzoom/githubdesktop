import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  compareEntries,
  flattenTree,
  getDecorations,
  IExplorerEntry,
} from '../../src/ui/file-explorer/file-explorer-model'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../src/models/status'
import { DiffSelection, DiffSelectionType } from '../../src/models/diff'

const dir = (path: string): IExplorerEntry => ({
  name: path.split('/').pop()!,
  path,
  isDirectory: true,
})
const file = (path: string): IExplorerEntry => ({
  name: path.split('/').pop()!,
  path,
  isDirectory: false,
})

const change = (path: string, kind: AppFileStatusKind) =>
  new WorkingDirectoryFileChange(
    path,
    { kind } as any,
    DiffSelection.fromInitialSelection(DiffSelectionType.All)
  )

describe('file explorer model', () => {
  it('sorts folders first and names naturally', () => {
    const sorted = [file('b10.txt'), dir('z'), file('B2.txt'), dir('a')].sort(
      compareEntries
    )
    assert.deepStrictEqual(
      sorted.map(e => e.path),
      ['a', 'z', 'B2.txt', 'b10.txt']
    )
  })

  it('lists the rows of expanded folders only', () => {
    const children = new Map([
      ['', [dir('src'), dir('test'), file('README.md')]],
      ['src', [dir('src/lib'), file('src/index.ts')]],
      ['src/lib', [file('src/lib/a.ts')]],
      ['test', [file('test/a-test.ts')]],
    ])
    const rows = flattenTree(children, new Set(['src', 'src/lib']), null)
    assert.deepStrictEqual(
      rows.map(r => (r.kind === 'entry' ? `${r.depth}:${r.entry.path}` : '')),
      [
        '0:src',
        '1:src/lib',
        '2:src/lib/a.ts',
        '1:src/index.ts',
        '0:test',
        '0:README.md',
      ]
    )
  })

  it('puts the inline input of a new entry first in its folder', () => {
    const children = new Map([
      ['', [dir('src'), file('README.md')]],
      ['src', [file('src/index.ts')]],
    ])
    const rows = flattenTree(children, new Set(['src']), {
      kind: 'new-file',
      path: 'src',
    })
    assert.deepStrictEqual(
      rows.map(r => r.kind),
      ['entry', 'input', 'entry', 'entry']
    )

    const renaming = flattenTree(children, new Set(), {
      kind: 'rename',
      path: 'README.md',
    })
    assert.deepStrictEqual(
      renaming.map(r => r.kind),
      ['entry', 'input']
    )
  })

  it('decorates changed files and tints their folders by severity', () => {
    const { fileDecorations, folderDecorations } = getDecorations([
      change('src/lib/new.ts', AppFileStatusKind.Untracked),
      change('src/lib/changed.ts', AppFileStatusKind.Modified),
      change('src/other.ts', AppFileStatusKind.New),
    ])
    assert.equal(fileDecorations.get('src/lib/new.ts')?.letter, 'U')
    assert.equal(fileDecorations.get('src/lib/changed.ts')?.letter, 'M')
    assert.equal(folderDecorations.get('src/lib')?.className, 'modified')
    assert.equal(folderDecorations.get('src')?.className, 'modified')
    assert.equal(folderDecorations.has(''), false)
  })
})
