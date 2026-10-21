import { git } from './core'
import { buildDiff } from './diff'
import { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { DiffSelection, IDiff, ITextDiff } from '../../models/diff'
import { formatPatch, formatPatchToDiscardChanges } from '../patch-formatter'
import { stagingSideFile } from '../staging'

/**
 * Every path touched by the files, including the source of a rename so that
 * staging or unstaging a rename moves both halves together.
 */
function pathsOf(files: ReadonlyArray<WorkingDirectoryFileChange>) {
  const paths = new Set<string>()
  for (const file of files) {
    paths.add(file.path)
    const { status } = file
    if (
      status.kind === AppFileStatusKind.Renamed ||
      status.kind === AppFileStatusKind.Copied
    ) {
      paths.add(status.oldPath)
    }
  }
  return [...paths]
}

/** `git add -A` the given files, including deletions and untracked files. */
export async function stageFilesToIndex(
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>
): Promise<void> {
  const paths = pathsOf(files)
  if (paths.length === 0) {
    return
  }
  await git(
    ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
    repository.path,
    'stageFilesToIndex',
    { stdin: paths.join('\0') }
  )
}

/** Stage every change in the working directory. */
export async function stageAllToIndex(repository: Repository): Promise<void> {
  await git(['add', '-A'], repository.path, 'stageAllToIndex')
}

/** Reset the given files in the index to HEAD, leaving the working tree. */
export async function unstageFilesFromIndex(
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>
): Promise<void> {
  const paths = pathsOf(files)
  if (paths.length === 0) {
    return
  }
  await git(
    ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
    repository.path,
    'unstageFilesFromIndex',
    { stdin: paths.join('\0') }
  )
}

/** Unstage everything. */
export async function unstageAllFromIndex(
  repository: Repository
): Promise<void> {
  await git(['reset', '-q'], repository.path, 'unstageAllFromIndex')
}

/**
 * The diff of the staged half of a file (HEAD → index) or of its unstaged
 * half (index → working tree).
 */
export async function getStagingDiff(
  repository: Repository,
  file: WorkingDirectoryFileChange,
  staged: boolean,
  hideWhitespaceInDiff: boolean = false
): Promise<IDiff> {
  const side = stagingSideFile(file, staged)
  const args = [
    'diff',
    ...(hideWhitespaceInDiff ? ['-w'] : []),
    '--no-ext-diff',
    '--patch-with-raw',
    '-z',
    '--no-color',
  ]
  const successExitCodes = new Set([0])

  if (staged) {
    args.push('--cached', '--', ...pathsOf([side]))
  } else if (side.status.kind === AppFileStatusKind.Untracked) {
    successExitCodes.add(1)
    args.push('--no-index', '--', '/dev/null', file.path)
  } else {
    args.push('--', file.path)
  }

  const { stdout } = await git(args, repository.path, 'getStagingDiff', {
    successExitCodes,
    encoding: 'buffer',
  })
  return buildDiff(stdout, repository, side, 'HEAD', 'HEAD')
}

const applyToIndexArgs = [
  'apply',
  '--cached',
  '--unidiff-zero',
  '--whitespace=nowarn',
  '-',
]

/**
 * Stage the selected lines of a diff produced by
 * `getStagingDiff(repository, file, false)`.
 */
export async function stageLinesToIndex(
  repository: Repository,
  file: WorkingDirectoryFileChange,
  diff: ITextDiff,
  selection: DiffSelection
): Promise<void> {
  const side = stagingSideFile(file, false).withSelection(selection)
  const patch = formatPatch(side, diff)
  await git(applyToIndexArgs, repository.path, 'stageLinesToIndex', {
    stdin: patch,
  })
}

/**
 * Unstage the selected lines of a diff produced by
 * `getStagingDiff(repository, file, true)`, by applying their reverse to the
 * index.
 */
export async function unstageLinesFromIndex(
  repository: Repository,
  file: WorkingDirectoryFileChange,
  diff: ITextDiff,
  selection: DiffSelection
): Promise<void> {
  const patch = formatPatchToDiscardChanges(file.path, diff, selection)
  if (patch === null) {
    return
  }
  await git(applyToIndexArgs, repository.path, 'unstageLinesFromIndex', {
    stdin: patch,
  })
}
