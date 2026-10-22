import * as React from 'react'
import * as Path from 'path'
import classNames from 'classnames'
import { Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { Account } from '../../models/account'
import { Dispatcher } from '../dispatcher'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { getAccountForCopilotAgent } from '../../lib/get-account-for-repository'
import {
  CopilotAgentSession,
  IAgentChatMessage,
  IAgentPermissionPrompt,
} from '../../lib/stores/copilot-agent-session'
import { getRepositoryEditors } from '../editor/editor-store'

interface ICopilotAgentPanelProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly accounts: ReadonlyArray<Account>
}

interface ICopilotAgentPanelState {
  readonly draft: string
  readonly showHistory: boolean
}

const formatChatTime = (date: Date) =>
  date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

class ChatRow extends React.PureComponent<{
  readonly message: IAgentChatMessage
}> {
  public render() {
    const { message } = this.props
    if (message.kind === 'tool') {
      return (
        <div
          className={classNames('copilot-agent-tool', {
            running: message.toolStatus === 'running',
          })}
        >
          <Octicon
            symbol={
              message.toolStatus === 'running' ? octicons.sync : octicons.check
            }
          />
          <span>{message.text}</span>
        </div>
      )
    }
    return (
      <div className={classNames('copilot-agent-bubble', message.kind)}>
        {message.text}
      </div>
    )
  }
}

interface IChatHistoryItemProps {
  readonly session: CopilotAgentSession
  readonly active: boolean
  readonly onSelect: (session: CopilotAgentSession) => void
  readonly onDelete: (session: CopilotAgentSession) => void
}

class ChatHistoryItem extends React.Component<IChatHistoryItemProps> {
  private onSelect = () => this.props.onSelect(this.props.session)
  private onDelete = () => this.props.onDelete(this.props.session)

  public render() {
    const { session, active } = this.props
    return (
      <div className={classNames('copilot-agent-history-item', { active })}>
        <button
          type="button"
          className="copilot-agent-history-open"
          onClick={this.onSelect}
        >
          <Octicon
            symbol={
              session.state.busy ? octicons.sync : octicons.commentDiscussion
            }
          />
          <span className="copilot-agent-history-title">{session.title}</span>
          <span className="copilot-agent-history-time">
            {formatChatTime(session.createdAt)}
          </span>
        </button>
        <button
          type="button"
          className="copilot-agent-icon-button"
          aria-label="Delete chat"
          onClick={this.onDelete}
        >
          <Octicon symbol={octicons.trash} />
        </button>
      </div>
    )
  }
}

/** VS Code-style Copilot agent chat for the current repository. */
export class CopilotAgentPanel extends React.Component<
  ICopilotAgentPanelProps,
  ICopilotAgentPanelState
> {
  private subscription: Disposable | null = null
  private session: CopilotAgentSession | null = null
  private readonly listRef = React.createRef<HTMLDivElement>()

  public constructor(props: ICopilotAgentPanelProps) {
    super(props)
    this.state = { draft: '', showHistory: false }
  }

  public componentDidMount() {
    this.attachSession(
      this.props.dispatcher.getCopilotAgentSession(this.props.repository)
    )
  }

  public componentDidUpdate(prevProps: ICopilotAgentPanelProps) {
    if (prevProps.repository.path !== this.props.repository.path) {
      this.attachSession(
        this.props.dispatcher.getCopilotAgentSession(this.props.repository)
      )
      this.setState({ showHistory: false })
    }
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
  }

  private attachSession(session: CopilotAgentSession | null) {
    this.subscription?.dispose()
    this.session = session
    this.subscription =
      session?.onDidChange(() => {
        this.forceUpdate()
        this.scrollToEnd()
      }) ?? null
    this.forceUpdate()
  }

  private scrollToEnd() {
    const list = this.listRef.current
    if (list !== null) {
      list.scrollTop = list.scrollHeight
    }
  }

  private get account() {
    return getAccountForCopilotAgent(this.props.accounts, this.props.repository)
  }

  private ensureSession() {
    if (this.session !== null) {
      return this.session
    }
    const session = this.props.dispatcher.getOrCreateCopilotAgentSession(
      this.props.repository,
      paths => this.openChangedFiles(paths)
    )
    this.attachSession(session)
    return session
  }

  private openChangedFiles(paths: ReadonlyArray<string>) {
    const editors = getRepositoryEditors(this.props.repository)
    editors.refresh()
    for (const path of paths) {
      const relative = Path.isAbsolute(path)
        ? Path.relative(this.props.repository.path, path)
        : path
      if (
        relative.length > 0 &&
        !relative.startsWith('..') &&
        !Path.isAbsolute(relative)
      ) {
        editors.open(relative, { pin: true })
      }
    }
  }

  private onDraftChange = (event: React.FormEvent<HTMLTextAreaElement>) => {
    this.setState({ draft: event.currentTarget.value })
  }

  private onDraftKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      this.send()
    }
  }

  private onSendClick = () => this.send()

  private async send() {
    const session = this.ensureSession()
    if (session === null) {
      return
    }
    const draft = this.state.draft
    const editors = getRepositoryEditors(this.props.repository)
    const lookingAt =
      editors.activePath !== null
        ? `\n\nThe user is looking at ${editors.activePath}.`
        : ''
    this.setState({ draft: '' })
    await session.send(`${draft}${lookingAt}`)
  }

  private onStop = () => {
    this.session?.abort()
  }

  private onNewChat = () => {
    this.props.dispatcher.startNewCopilotAgentChat(this.props.repository)
    this.attachSession(null)
    this.setState({ draft: '', showHistory: false })
  }

  private onToggleHistory = () => {
    this.setState(state => ({ showHistory: !state.showHistory }))
  }

  private onSelectChat = (session: CopilotAgentSession) => {
    this.props.dispatcher.selectCopilotAgentSession(
      this.props.repository,
      session
    )
    this.attachSession(session)
    this.setState({ showHistory: false }, () => this.scrollToEnd())
  }

  private onDeleteChat = async (session: CopilotAgentSession) => {
    await this.props.dispatcher.deleteCopilotAgentSession(
      this.props.repository,
      session
    )
    if (this.session === session) {
      this.attachSession(null)
    } else {
      this.forceUpdate()
    }
  }

  private renderHistory() {
    const sessions = this.props.dispatcher.getCopilotAgentSessions(
      this.props.repository
    )
    if (sessions.length === 0) {
      return (
        <div className="copilot-agent-empty">
          <Octicon symbol={octicons.history} />
          <p>No chats yet in this repository.</p>
        </div>
      )
    }
    return (
      <div className="copilot-agent-history">
        {sessions.map(session => (
          <ChatHistoryItem
            key={session.createdAt.getTime()}
            session={session}
            active={session === this.session}
            onSelect={this.onSelectChat}
            onDelete={this.onDeleteChat}
          />
        ))}
      </div>
    )
  }

  private onAllowOnce = () => {
    this.session?.respondToPermission({
      kind: 'approve-once',
      approvedInteractively: true,
    })
  }

  private onAllowSession = () => {
    this.session?.respondToPermission({ kind: 'approve-for-session' })
  }

  private onReject = () => {
    this.session?.respondToPermission({
      kind: 'reject',
      feedback: 'The user rejected this request.',
    })
  }

  private renderEmpty() {
    if (this.account === undefined) {
      return (
        <div className="copilot-agent-empty">
          <Octicon symbol={octicons.copilot} />
          <p>
            Sign in with a GitHub account that has a Copilot subscription to use
            the agent here.
          </p>
        </div>
      )
    }
    return (
      <div className="copilot-agent-empty">
        <Octicon symbol={octicons.copilot} />
        <p>
          Ask Copilot to edit this repository. It can read files, change them,
          and run commands after you approve.
        </p>
      </div>
    )
  }

  private renderMessages(session: CopilotAgentSession) {
    const { messages, streaming, reasoning, error } = session.state
    if (messages.length === 0 && streaming.length === 0 && error === null) {
      return this.renderEmpty()
    }
    return (
      <div className="copilot-agent-messages" ref={this.listRef}>
        {messages.map(message => (
          <ChatRow key={message.id} message={message} />
        ))}
        {reasoning.length > 0 && (
          <div className="copilot-agent-reasoning">{reasoning}</div>
        )}
        {streaming.length > 0 && (
          <div className="copilot-agent-bubble assistant">{streaming}</div>
        )}
      </div>
    )
  }

  private renderPermission(permission: IAgentPermissionPrompt) {
    return (
      <div className="copilot-agent-permission">
        <Octicon symbol={octicons.alert} />
        <span>{permission.summary}</span>
        <div className="copilot-agent-permission-actions">
          <button type="button" onClick={this.onAllowOnce}>
            Allow
          </button>
          {permission.canOfferSessionApproval && (
            <button type="button" onClick={this.onAllowSession}>
              Allow for Session
            </button>
          )}
          <button type="button" onClick={this.onReject}>
            Reject
          </button>
        </div>
      </div>
    )
  }

  public render() {
    const session = this.session
    const account = this.account
    const busy = session?.state.busy === true
    const permission = session?.state.permission ?? null
    const canSend =
      account !== undefined &&
      this.state.draft.trim().length > 0 &&
      !busy &&
      permission === null
    return (
      <div className="copilot-agent-panel">
        <div className="copilot-agent-header">
          <span className="copilot-agent-title">
            {this.state.showHistory ? 'Chats' : 'Copilot Agent'}
          </span>
          <button
            type="button"
            className={classNames('copilot-agent-icon-button', {
              selected: this.state.showHistory,
            })}
            onClick={this.onToggleHistory}
            aria-label="Chat history"
            aria-pressed={this.state.showHistory}
          >
            <Octicon symbol={octicons.history} />
          </button>
          <button
            type="button"
            className="copilot-agent-icon-button"
            onClick={this.onNewChat}
            aria-label="New chat"
          >
            <Octicon symbol={octicons.plus} />
          </button>
        </div>
        {this.state.showHistory
          ? this.renderHistory()
          : session === null
          ? this.renderEmpty()
          : this.renderMessages(session)}
        {!this.state.showHistory &&
          permission !== null &&
          this.renderPermission(permission)}
        <div className="copilot-agent-composer">
          <textarea
            value={this.state.draft}
            placeholder={
              account === undefined
                ? 'Copilot is unavailable'
                : 'Ask Copilot to work in this repository'
            }
            disabled={account === undefined || permission !== null}
            rows={3}
            onChange={this.onDraftChange}
            onKeyDown={this.onDraftKeyDown}
          />
          {busy ? (
            <button type="button" onClick={this.onStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSend}
              onClick={this.onSendClick}
            >
              Send
            </button>
          )}
        </div>
      </div>
    )
  }
}
