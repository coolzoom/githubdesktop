import * as Path from 'path'
import { promises as Fs } from 'fs'
import { git } from '../../lib/git'
import { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../models/status'

/** A file or folder of the working directory, by its repository path. */
export interface IExplorerEntry {
  readonly name: string
  /** Relative to the repository root with `/` separators */
  readonly path: string
  readonly isDirectory: boolean
}

export type ExplorerEditKind = 'new-file' | 'new-folder' | 'rename'

export type ExplorerRow =
  | {
      readonly kind: 'entry'
      readonly entry: IExplorerEntry
      readonly depth: number
    }
  | {
      readonly kind: 'input'
      readonly edit: ExplorerEditKind
      /** The folder the new entry goes into, or the entry being renamed */
      readonly path: string
      readonly depth: number
    }

/** An inline name input shown in the tree. */
export interface IExplorerEdit {
  readonly kind: ExplorerEditKind
  readonly path: string
}

/** The letter and color class VS Code shows for a file's git status. */
export interface IExplorerDecoration {
  readonly letter: string
  readonly className: string
}

export function parentPath(path: string) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function joinPath(parent: string, name: string) {
  return parent.length === 0 ? name : `${parent}/${name}`
}

/** Folders first, then names in natural, case-insensitive order. */
export function compareEntries(a: IExplorerEntry, b: IExplorerEntry) {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1
  }
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

/**
 * The rows of the tree that are visible given which folders are expanded,
 * with the inline input of a new or renamed entry in place.
 */
export function flattenTree(
  children: ReadonlyMap<string, ReadonlyArray<IExplorerEntry>>,
  expanded: ReadonlySet<string>,
  edit: IExplorerEdit | null
): ReadonlyArray<ExplorerRow> {
  const rows: ExplorerRow[] = []
  const visit = (dir: string, depth: number) => {
    if (
      edit !== null &&
      edit.kind !== 'rename' &&
      edit.path === dir &&
      (dir === '' || expanded.has(dir))
    ) {
      rows.push({ kind: 'input', edit: edit.kind, path: dir, depth })
    }
    for (const entry of children.get(dir) ?? []) {
      if (edit?.kind === 'rename' && edit.path === entry.path) {
        rows.push({ kind: 'input', edit: 'rename', path: entry.path, depth })
      } else {
        rows.push({ kind: 'entry', entry, depth })
      }
      if (entry.isDirectory && expanded.has(entry.path)) {
        visit(entry.path, depth + 1)
      }
    }
  }
  visit('', 0)
  return rows
}

function decorationFor(kind: AppFileStatusKind): IExplorerDecoration {
  switch (kind) {
    case AppFileStatusKind.New:
    case AppFileStatusKind.Untracked:
      return { letter: 'U', className: 'added' }
    case AppFileStatusKind.Modified:
      return { letter: 'M', className: 'modified' }
    case AppFileStatusKind.Deleted:
      return { letter: 'D', className: 'deleted' }
    case AppFileStatusKind.Renamed:
      return { letter: 'R', className: 'renamed' }
    case AppFileStatusKind.Copied:
      return { letter: 'C', className: 'added' }
    case AppFileStatusKind.Conflicted:
      return { letter: '!', className: 'conflicted' }
  }
}

/**
 * Status decorations of the changed files, and the folders that contain
 * changes which VS Code tints with the color of their most severe change.
 */
export function getDecorations(
  files: ReadonlyArray<WorkingDirectoryFileChange>
) {
  const fileDecorations = new Map<string, IExplorerDecoration>()
  const folderDecorations = new Map<string, IExplorerDecoration>()
  const severity = ['renamed', 'added', 'modified', 'deleted', 'conflicted']

  for (const file of files) {
    const path = file.path.replace(/\/$/, '')
    const decoration = decorationFor(file.status.kind)
    fileDecorations.set(path, decoration)
    for (let dir = parentPath(path); dir.length > 0; dir = parentPath(dir)) {
      const current = folderDecorations.get(dir)
      if (
        current === undefined ||
        severity.indexOf(decoration.className) >
          severity.indexOf(current.className)
      ) {
        folderDecorations.set(dir, decoration)
      }
    }
  }
  return { fileDecorations, folderDecorations }
}

/** Read one folder of the working directory, leaving out `.git`. */
export async function readFolder(
  repository: Repository,
  dir: string
): Promise<ReadonlyArray<IExplorerEntry>> {
  const fullPath = Path.join(repository.path, dir)
  const dirents = await Fs.readdir(fullPath, { withFileTypes: true })
  const entries = await Promise.all(
    dirents
      .filter(d => !(dir === '' && d.name === '.git'))
      .map(async d => {
        let isDirectory = d.isDirectory()
        if (d.isSymbolicLink()) {
          isDirectory = await Fs.stat(Path.join(fullPath, d.name))
            .then(s => s.isDirectory())
            .catch(() => false)
        }
        return { name: d.name, path: joinPath(dir, d.name), isDirectory }
      })
  )
  return entries.sort(compareEntries)
}

/** Which of `entries` git ignores, so the tree can dim them. */
export async function getIgnoredPaths(
  repository: Repository,
  entries: ReadonlyArray<IExplorerEntry>
): Promise<ReadonlyArray<string>> {
  if (entries.length === 0) {
    return []
  }
  const input = entries
    .map(e => (e.isDirectory ? `${e.path}/` : e.path))
    .join('\0')
  const result = await git(
    ['check-ignore', '-z', '--stdin'],
    repository.path,
    'explorerCheckIgnore',
    { stdin: input, successExitCodes: new Set([0, 1]) }
  )
  return result.stdout
    .split('\0')
    .filter(p => p.length > 0)
    .map(p => p.replace(/\/$/, ''))
}
