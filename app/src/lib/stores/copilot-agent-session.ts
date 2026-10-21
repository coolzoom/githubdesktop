import { Emitter, Disposable } from 'event-kit'
import {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  ToolSet,
} from '@github/copilot-sdk'
import {
  canOfferSessionApproval,
  decideAgentPermission,
  summarizeAgentPermission,
} from '../copilot-agent-permissions'

const AgentClientName = 'github/desktop:agent-chat'

const WriteTools = new Set([
  'edit',
  'create',
  'apply_patch',
  'str_replace_editor',
  'edit_file',
])

export type AgentMessageKind = 'user' | 'assistant' | 'tool' | 'error'

export interface IAgentChatMessage {
  readonly id: string
  readonly kind: AgentMessageKind
  readonly text: string
  readonly toolName?: string
  readonly toolStatus?: 'running' | 'done'
}

export interface IAgentPermissionPrompt {
  readonly request: PermissionRequest
  readonly summary: string
  readonly canOfferSessionApproval: boolean
}

export interface ICopilotAgentState {
  readonly messages: ReadonlyArray<IAgentChatMessage>
  readonly streaming: string
  readonly reasoning: string
  readonly busy: boolean
  readonly permission: IAgentPermissionPrompt | null
  readonly error: string | null
}

interface IAgentSessionFactories {
  readonly createClient: () => Promise<CopilotClient>
  readonly createSession: (
    client: CopilotClient,
    config: SessionConfig
  ) => Promise<CopilotSession>
  readonly stopClient: (client: CopilotClient) => void
}

interface IPendingPermission {
  readonly request: PermissionRequest
  readonly resolve: (result: PermissionRequestResult) => void
}

let messageCounter = 0
const nextId = (prefix: string) => `${prefix}-${++messageCounter}`

/**
 * One long-lived Copilot agent conversation for a repository. The SDK
 * runtime reads and writes the working directory once the user approves.
 */
export class CopilotAgentSession {
  private readonly emitter = new Emitter()
  private client: CopilotClient | null = null
  private session: CopilotSession | null = null
  private unsubscribe: (() => void) | null = null
  private pendingPermission: IPendingPermission | null = null
  private connecting: Promise<void> | null = null
  private messages: IAgentChatMessage[] = []
  private streaming = ''
  private reasoning = ''
  private busy = false
  private error: string | null = null
  private changedPaths = new Set<string>()
  public readonly createdAt = new Date()

  public constructor(
    public readonly repositoryPath: string,
    private readonly factories: IAgentSessionFactories,
    private readonly onWorkspaceChanged: (paths: ReadonlyArray<string>) => void
  ) {}

  public get state(): ICopilotAgentState {
    return {
      messages: this.messages,
      streaming: this.streaming,
      reasoning: this.reasoning,
      busy: this.busy,
      permission:
        this.pendingPermission === null
          ? null
          : {
              request: this.pendingPermission.request,
              summary: summarizeAgentPermission(this.pendingPermission.request),
              canOfferSessionApproval: canOfferSessionApproval(
                this.pendingPermission.request
              ),
            },
      error: this.error,
    }
  }

  public get isEmpty() {
    return this.messages.length === 0 && !this.busy
  }

  /** The first line of the first prompt, without the editor context hint. */
  public get title() {
    const first = this.messages.find(m => m.kind === 'user')
    if (first === undefined) {
      return 'New chat'
    }
    const line = first.text.split('\n')[0].trim()
    return line.length > 0 ? line : 'New chat'
  }

  public onDidChange(fn: () => void): Disposable {
    return this.emitter.on('change', fn)
  }

  private changed() {
    this.emitter.emit('change')
  }

  public async send(prompt: string) {
    const text = prompt.trim()
    if (text.length === 0 || this.busy) {
      return
    }
    try {
      await this.ensureSession()
    } catch (e) {
      log.error('Copilot agent: unable to start session', e)
      this.pushError(e instanceof Error ? e.message : `${e}`)
      return
    }
    const session = this.session
    if (session === null) {
      return
    }
    this.messages = [
      ...this.messages,
      { id: nextId('user'), kind: 'user', text },
    ]
    this.streaming = ''
    this.reasoning = ''
    this.busy = true
    this.error = null
    this.changedPaths = new Set()
    this.changed()
    try {
      await session.send({ prompt: text })
    } catch (e) {
      this.busy = false
      this.pushError(e instanceof Error ? e.message : `${e}`)
    }
  }

  public async abort() {
    if (this.pendingPermission !== null) {
      this.respondToPermission({ kind: 'reject', feedback: 'Stopped.' })
    }
    try {
      await this.session?.abort()
    } catch (e) {
      log.warn('Copilot agent: failed to abort the turn', e)
    }
    this.busy = false
    this.flushStreaming()
    this.changed()
  }

  public respondToPermission(result: PermissionRequestResult) {
    const pending = this.pendingPermission
    if (pending === null) {
      return
    }
    if (
      result.kind === 'approve-once' ||
      result.kind === 'approve-for-session'
    ) {
      this.rememberWritePath(pending.request)
    }
    pending.resolve(result)
    this.pendingPermission = null
    this.changed()
  }

  public async reset() {
    await this.dispose()
    this.messages = []
    this.streaming = ''
    this.reasoning = ''
    this.busy = false
    this.error = null
    this.changed()
  }

  public async dispose() {
    if (this.pendingPermission !== null) {
      this.pendingPermission.resolve({ kind: 'user-not-available' })
      this.pendingPermission = null
    }
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.session?.disconnect().catch(() => {})
    this.session = null
    if (this.client !== null) {
      this.factories.stopClient(this.client)
      this.client = null
    }
    this.connecting = null
  }

  private async ensureSession() {
    if (this.session !== null) {
      return
    }
    if (this.connecting !== null) {
      await this.connecting
      return
    }
    this.connecting = this.connect()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private async connect() {
    const client = await this.factories.createClient()
    this.client = client
    let session: CopilotSession
    try {
      session = await this.createAgentSession(client)
    } catch (e) {
      this.client = null
      this.factories.stopClient(client)
      throw e
    }
    this.session = session
    this.unsubscribe = session.on(event => this.onEvent(event))
  }

  private createAgentSession(client: CopilotClient) {
    return this.factories.createSession(client, {
      clientName: AgentClientName,
      model: 'auto',
      workingDirectory: this.repositoryPath,
      streaming: true,
      enableHostGitOperations: true,
      enableFileChangeTracking: true,
      enableSessionStore: false,
      availableTools: new ToolSet().addBuiltIn([
        'view',
        'grep',
        'glob',
        'bash',
        'powershell',
        'edit',
        'create',
        'ask_user',
      ]),
      systemMessage: {
        mode: 'append',
        content:
          'You are the GitHub Copilot agent inside GitHub Desktop. The working directory is this repository. Edit files on disk; the user will review them in the editor and the Changes list.',
      },
      onPermissionRequest: request => this.onPermissionRequest(request),
    })
  }

  private onPermissionRequest(request: PermissionRequest) {
    const decided = decideAgentPermission(this.repositoryPath, request)
    if (decided !== null) {
      if (decided.kind === 'approve-once') {
        this.rememberWritePath(request)
      }
      return decided
    }
    return new Promise<PermissionRequestResult>(resolve => {
      this.pendingPermission = { request, resolve }
      this.changed()
    })
  }

  private onEvent(event: { type: string; data?: any; id?: string }) {
    switch (event.type) {
      case 'assistant.message_delta':
        this.streaming += event.data?.deltaContent ?? ''
        this.changed()
        return
      case 'assistant.reasoning_delta':
        this.reasoning += event.data?.deltaContent ?? ''
        this.changed()
        return
      case 'assistant.message':
        this.streaming = ''
        this.reasoning = ''
        if (typeof event.data?.content === 'string' && event.data.content) {
          this.messages = [
            ...this.messages,
            {
              id: event.id ?? nextId('assistant'),
              kind: 'assistant',
              text: event.data.content,
            },
          ]
        }
        this.changed()
        return
      case 'tool.execution_start': {
        const toolName = `${event.data?.toolName ?? 'tool'}`
        this.rememberToolPath(toolName, event.data?.arguments)
        this.messages = [
          ...this.messages,
          {
            id: event.data?.toolCallId ?? nextId('tool'),
            kind: 'tool',
            text: toolTitle(toolName, event.data),
            toolName,
            toolStatus: 'running',
          },
        ]
        this.changed()
        return
      }
      case 'tool.execution_complete': {
        const id = event.data?.toolCallId
        this.messages = this.messages.map(message =>
          message.kind === 'tool' && message.id === id
            ? { ...message, toolStatus: 'done' }
            : message
        )
        this.changed()
        return
      }
      case 'session.idle':
        this.busy = false
        this.flushStreaming()
        this.emitWorkspaceChanged()
        this.changed()
        return
      case 'session.error':
        this.busy = false
        this.pushError(event.data?.message ?? 'Copilot agent error')
        return
      default:
        return
    }
  }

  private flushStreaming() {
    if (this.streaming.trim().length === 0) {
      this.streaming = ''
      this.reasoning = ''
      return
    }
    this.messages = [
      ...this.messages,
      {
        id: nextId('assistant'),
        kind: 'assistant',
        text: this.streaming,
      },
    ]
    this.streaming = ''
    this.reasoning = ''
  }

  private pushError(text: string) {
    this.error = text
    this.messages = [
      ...this.messages,
      { id: nextId('error'), kind: 'error', text },
    ]
    this.changed()
  }

  private rememberWritePath(request: PermissionRequest) {
    if (request.kind === 'write') {
      this.changedPaths.add(request.fileName)
    }
  }

  private rememberToolPath(toolName: string, args: unknown) {
    if (
      !WriteTools.has(toolName) ||
      args === null ||
      typeof args !== 'object'
    ) {
      return
    }
    const record = args as Record<string, unknown>
    for (const key of ['path', 'fileName', 'file_path']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) {
        this.changedPaths.add(value)
      }
    }
  }

  private emitWorkspaceChanged() {
    if (this.changedPaths.size === 0) {
      this.onWorkspaceChanged([])
      return
    }
    const paths = [...this.changedPaths]
    this.changedPaths = new Set()
    this.onWorkspaceChanged(paths)
  }
}

function toolTitle(toolName: string, data: any): string {
  const args = data?.arguments
  if (args !== null && typeof args === 'object') {
    const path = args.path ?? args.fileName ?? args.file_path ?? args.pattern
    if (typeof path === 'string' && path.length > 0) {
      return `${toolName} ${path}`
    }
    const command = args.command ?? args.cmd
    if (typeof command === 'string' && command.length > 0) {
      return `${toolName} ${command}`
    }
  }
  return data?.toolTitle ?? toolName
}
