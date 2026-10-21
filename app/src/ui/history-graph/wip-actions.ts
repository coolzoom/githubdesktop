import { Repository } from '../../models/repository'
import { WorkingDirectoryFileChange } from '../../models/status'
import { DiffSelection, ITextDiff } from '../../models/diff'
import {
  stageAllToIndex,
  stageFilesToIndex,
  stageLinesToIndex,
  unstageAllFromIndex,
  unstageFilesFromIndex,
  unstageLinesFromIndex,
} from '../../lib/git/staging'
import { Dispatcher } from '../dispatcher'

/**
 * Run a staging operation from the WIP panel, report failures through
 * Desktop's error handling and reload the status so both file lists update.
 */
async function runStagingAction(
  dispatcher: Dispatcher,
  repository: Repository,
  fn: () => Promise<unknown>
): Promise<void> {
  try {
    await fn()
  } catch (e) {
    dispatcher.postError(e instanceof Error ? e : new Error(`${e}`))
  } finally {
    await dispatcher.refreshStatus(repository)
  }
}

export function stageFiles(
  dispatcher: Dispatcher,
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>
) {
  return runStagingAction(dispatcher, repository, () =>
    stageFilesToIndex(repository, files)
  )
}

export function unstageFiles(
  dispatcher: Dispatcher,
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>
) {
  return runStagingAction(dispatcher, repository, () =>
    unstageFilesFromIndex(repository, files)
  )
}

export function stageAll(dispatcher: Dispatcher, repository: Repository) {
  return runStagingAction(dispatcher, repository, () =>
    stageAllToIndex(repository)
  )
}

export function unstageAll(dispatcher: Dispatcher, repository: Repository) {
  return runStagingAction(dispatcher, repository, () =>
    unstageAllFromIndex(repository)
  )
}

/**
 * Stage (or, for a staged diff, unstage) the selected lines of the diff of
 * one half of a file's changes.
 */
export function applyLineSelection(
  dispatcher: Dispatcher,
  repository: Repository,
  file: WorkingDirectoryFileChange,
  staged: boolean,
  diff: ITextDiff,
  selection: DiffSelection
) {
  return runStagingAction(dispatcher, repository, () =>
    staged
      ? unstageLinesFromIndex(repository, file, diff, selection)
      : stageLinesToIndex(repository, file, diff, selection)
  )
}
