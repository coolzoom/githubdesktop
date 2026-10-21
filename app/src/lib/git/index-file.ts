import { git } from './core'
import { Repository } from '../../models/repository'

/**
 * The contents of a file as staged in the index, or null when the index
 * has no entry for it (e.g. an untracked file).
 */
export async function getIndexFileContents(
  repository: Repository,
  path: string
): Promise<Buffer | null> {
  const result = await git(
    ['show', `:${path}`],
    repository.path,
    'getIndexFileContents',
    { successExitCodes: new Set([0, 128]), encoding: 'buffer' }
  )
  return result.exitCode === 0 ? result.stdout : null
}

/** The mode of a file's index entry such as `100644`, if it has one. */
export async function getIndexFileMode(
  repository: Repository,
  path: string
): Promise<string | null> {
  const result = await git(
    ['ls-files', '--stage', '-z', '--', path],
    repository.path,
    'getIndexFileMode'
  )
  const match = /^(\d{6}) /.exec(result.stdout)
  return match === null ? null : match[1]
}

/**
 * Replace the staged contents of a file without touching the working tree,
 * which is how a single change is staged from the editor.
 *
 * @param mode The mode for a file without an index entry yet
 */
export async function setIndexFileContents(
  repository: Repository,
  path: string,
  contents: string,
  mode: string = '100644'
) {
  const hash = await git(
    ['hash-object', '-w', '--stdin', `--path=${path}`],
    repository.path,
    'setIndexFileContents',
    { stdin: contents }
  )
  const entryMode = (await getIndexFileMode(repository, path)) ?? mode
  await git(
    [
      'update-index',
      '--add',
      '--cacheinfo',
      `${entryMode},${hash.stdout.trim()},${path}`,
    ],
    repository.path,
    'setIndexFileContents'
  )
}
