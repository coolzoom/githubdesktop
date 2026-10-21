import * as Path from 'path'
import type {
  PermissionRequest,
  PermissionRequestResult,
} from '@github/copilot-sdk'

/** True when `target` is the repository root or a path inside it. */
export function isPathInsideRepository(
  repositoryPath: string,
  target: string
): boolean {
  const root = Path.resolve(repositoryPath)
  const resolved = Path.isAbsolute(target)
    ? Path.resolve(target)
    : Path.resolve(root, target)
  const relative = Path.relative(root, resolved)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !Path.isAbsolute(relative))
  )
}

function pathsOf(request: PermissionRequest): ReadonlyArray<string> {
  switch (request.kind) {
    case 'read':
      return [request.path]
    case 'write':
      return [request.fileName]
    case 'shell':
      return request.possiblePaths
    default:
      return []
  }
}

/**
 * Auto-approve safe reads inside the repo, reject anything that leaves it,
 * and return null when the user has to decide (writes and shell commands).
 */
export function decideAgentPermission(
  repositoryPath: string,
  request: PermissionRequest
): PermissionRequestResult | null {
  if (request.managedApprovalRequired === true) {
    return null
  }

  const outside = pathsOf(request).some(
    path => !isPathInsideRepository(repositoryPath, path)
  )

  switch (request.kind) {
    case 'read':
      return outside
        ? {
            kind: 'reject',
            feedback: 'Reads are limited to this repository.',
          }
        : { kind: 'approve-once' }
    case 'write':
      return outside
        ? {
            kind: 'reject',
            feedback: 'Writes are limited to this repository.',
          }
        : null
    case 'shell':
      return outside
        ? {
            kind: 'reject',
            feedback:
              'Commands that touch files outside this repository are blocked.',
          }
        : null
    default:
      return {
        kind: 'reject',
        feedback: 'This kind of permission is not allowed here.',
      }
  }
}

/** One-line description of a permission request for the approval banner. */
export function summarizeAgentPermission(request: PermissionRequest): string {
  switch (request.kind) {
    case 'read':
      return `Read ${request.path}`
    case 'write':
      return request.intention || `Edit ${request.fileName}`
    case 'shell':
      return request.intention || request.fullCommandText
    default:
      return `Allow ${request.kind}`
  }
}

export function canOfferSessionApproval(request: PermissionRequest): boolean {
  return (
    (request.kind === 'write' || request.kind === 'shell') &&
    request.canOfferSessionApproval
  )
}
