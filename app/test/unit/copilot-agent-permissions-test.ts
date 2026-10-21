import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Path from 'path'
import type { PermissionRequest } from '@github/copilot-sdk'
import {
  decideAgentPermission,
  isPathInsideRepository,
  summarizeAgentPermission,
} from '../../src/lib/copilot-agent-permissions'

const repo = Path.resolve('/tmp/gk-repo')

describe('copilot agent permissions', () => {
  it('treats files inside the repository as inside', () => {
    assert.equal(isPathInsideRepository(repo, 'src/app.ts'), true)
    assert.equal(
      isPathInsideRepository(repo, Path.join(repo, 'src/app.ts')),
      true
    )
    assert.equal(isPathInsideRepository(repo, repo), true)
  })

  it('rejects paths that leave the repository', () => {
    assert.equal(isPathInsideRepository(repo, '../secret'), false)
    assert.equal(isPathInsideRepository(repo, '/etc/passwd'), false)
  })

  it('auto-approves reads inside the repository', () => {
    const request = {
      kind: 'read',
      path: 'README.md',
      intention: 'Read the file',
    } as PermissionRequest
    assert.deepStrictEqual(decideAgentPermission(repo, request), {
      kind: 'approve-once',
    })
  })

  it('rejects reads outside the repository', () => {
    const request = {
      kind: 'read',
      path: '/etc/passwd',
      intention: 'Read the file',
    } as PermissionRequest
    const result = decideAgentPermission(repo, request)
    assert.equal(result?.kind, 'reject')
  })

  it('asks the user before writing or running a command in the repo', () => {
    const write = {
      kind: 'write',
      fileName: 'app.ts',
      intention: 'Update app.ts',
      diff: '',
      canOfferSessionApproval: true,
    } as PermissionRequest
    const shell = {
      kind: 'shell',
      fullCommandText: 'npm test',
      intention: 'Run tests',
      commands: [],
      hasWriteFileRedirection: false,
      possiblePaths: [],
      possibleUrls: [],
      canOfferSessionApproval: true,
    } as PermissionRequest
    assert.equal(decideAgentPermission(repo, write), null)
    assert.equal(decideAgentPermission(repo, shell), null)
    assert.equal(summarizeAgentPermission(write), 'Update app.ts')
    assert.equal(summarizeAgentPermission(shell), 'Run tests')
  })
})
