import {
  AppFileStatus,
  AppFileStatusKind,
  GitStatusEntry,
  WorkingDirectoryFileChange,
} from '../models/status'
import { DiffSelection, DiffSelectionType } from '../models/diff'

/**
 * Whether the index holds changes to the file relative to HEAD, i.e. whether
 * it belongs in GitKraken's "Staged Files" list.
 */
export function hasStagedChanges(file: WorkingDirectoryFileChange) {
  const { status } = file
  if (
    status.kind === AppFileStatusKind.Untracked ||
    status.kind === AppFileStatusKind.Conflicted ||
    status.staging === undefined
  ) {
    return false
  }
  return status.staging.index !== GitStatusEntry.Unchanged
}

/**
 * Whether the working tree differs from the index for the file, i.e. whether
 * it belongs in GitKraken's "Unstaged Files" list. Conflicted files always do.
 */
export function hasUnstagedChanges(file: WorkingDirectoryFileChange) {
  const { status } = file
  if (
    status.kind === AppFileStatusKind.Untracked ||
    status.kind === AppFileStatusKind.Conflicted ||
    status.staging === undefined
  ) {
    return true
  }
  return status.staging.workingTree !== GitStatusEntry.Unchanged
}

function kindForEntry(
  entry: GitStatusEntry
): Exclude<AppFileStatusKind, AppFileStatusKind.Conflicted> {
  switch (entry) {
    case GitStatusEntry.Added:
      return AppFileStatusKind.New
    case GitStatusEntry.Deleted:
      return AppFileStatusKind.Deleted
    case GitStatusEntry.Renamed:
      return AppFileStatusKind.Renamed
    case GitStatusEntry.Copied:
      return AppFileStatusKind.Copied
    case GitStatusEntry.Untracked:
      return AppFileStatusKind.Untracked
    default:
      return AppFileStatusKind.Modified
  }
}

/**
 * The status of only the staged or only the unstaged half of a file's
 * changes, so that a diff of that half and a patch built from it get the
 * right file header (e.g. a file that is added in the index but modified in
 * the working tree is "modified" on the unstaged side).
 */
function sideStatus(
  file: WorkingDirectoryFileChange,
  staged: boolean
): AppFileStatus {
  const { status } = file
  if (
    status.kind === AppFileStatusKind.Untracked ||
    status.kind === AppFileStatusKind.Conflicted ||
    status.staging === undefined
  ) {
    return status
  }

  const kind = kindForEntry(
    staged ? status.staging.index : status.staging.workingTree
  )
  const { submoduleStatus } = status

  if (kind === AppFileStatusKind.Renamed || kind === AppFileStatusKind.Copied) {
    return status.kind === AppFileStatusKind.Renamed ||
      status.kind === AppFileStatusKind.Copied
      ? { ...status, kind }
      : { kind: AppFileStatusKind.Modified, submoduleStatus }
  }
  if (kind === AppFileStatusKind.Untracked) {
    return { kind, submoduleStatus }
  }
  return { kind, submoduleStatus, staging: status.staging }
}

/**
 * A copy of the file describing only its staged (or unstaged) changes, with
 * an empty line selection.
 */
export function stagingSideFile(
  file: WorkingDirectoryFileChange,
  staged: boolean
): WorkingDirectoryFileChange {
  return new WorkingDirectoryFileChange(
    file.path,
    sideStatus(file, staged),
    DiffSelection.fromInitialSelection(DiffSelectionType.None)
  )
}

/** The working directory files split into GitKraken's two lists. */
export function splitStagedFiles(
  files: ReadonlyArray<WorkingDirectoryFileChange>
) {
  return {
    unstaged: files.filter(hasUnstagedChanges),
    staged: files.filter(hasStagedChanges),
  }
}
