import { readFile, writeFile } from 'fs/promises'
import * as Path from 'path'
import { git } from './core'
import { Repository } from '../../models/repository'
import { ConflictMerge, detectLineEnding } from '../conflict-merge'

/** Read a conflicted file's index stage (1 ancestor, 2 ours, 3 theirs). */
async function readStage(
  repository: Repository,
  stage: 1 | 2 | 3,
  path: string
): Promise<Buffer | null> {
  const result = await git(
    ['show', `:${stage}:${path}`],
    repository.path,
    'readConflictStage',
    { successExitCodes: new Set([0, 128]), encoding: 'buffer' }
  )
  return result.exitCode === 0 ? result.stdout : null
}

function isBinary(buffer: Buffer) {
  return buffer.subarray(0, 8000).includes(0)
}

/**
 * Build the merge editor's model of a conflicted file from its index stages.
 * Returns null when a side is missing (a modify/delete conflict) or binary.
 */
export async function loadConflictMerge(
  repository: Repository,
  path: string
): Promise<ConflictMerge | null> {
  const [ancestor, ours, theirs] = await Promise.all([
    readStage(repository, 1, path),
    readStage(repository, 2, path),
    readStage(repository, 3, path),
  ])
  if (
    ours === null ||
    theirs === null ||
    isBinary(ours) ||
    isBinary(theirs) ||
    (ancestor !== null && isBinary(ancestor))
  ) {
    return null
  }

  let lineEnding: string | undefined
  try {
    const working = await readFile(Path.join(repository.path, path), 'utf8')
    lineEnding = detectLineEnding(working)
  } catch {
    lineEnding = undefined
  }

  return ConflictMerge.fromTexts(
    ancestor === null ? null : ancestor.toString('utf8'),
    ours.toString('utf8'),
    theirs.toString('utf8'),
    lineEnding
  )
}

/** Write the merged result over the conflicted file in the working tree. */
export function saveConflictResolution(
  repository: Repository,
  path: string,
  contents: string
) {
  return writeFile(Path.join(repository.path, path), contents, 'utf8')
}

async function revParse(repository: Repository, ref: string) {
  const result = await git(
    ['rev-parse', '--verify', '-q', ref],
    repository.path,
    'getConflictSideSha',
    { successExitCodes: new Set([0, 1]) }
  )
  const sha = result.stdout.trim()
  return result.exitCode === 0 && sha.length > 0 ? sha : null
}

/**
 * The commits on each side of the conflict: HEAD, and the commit being merged,
 * cherry-picked, reverted or rebased.
 */
export async function getConflictSideShas(repository: Repository) {
  const ours = await revParse(repository, 'HEAD')
  for (const ref of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REBASE_HEAD',
    'REVERT_HEAD',
  ]) {
    const theirs = await revParse(repository, ref)
    if (theirs !== null) {
      return { ours, theirs }
    }
  }
  return { ours, theirs: null }
}
