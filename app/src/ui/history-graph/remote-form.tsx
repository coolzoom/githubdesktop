import * as React from 'react'
import { Repository } from '../../models/repository'
import { IRemote } from '../../models/remote'
import { Dispatcher } from '../dispatcher'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { addRemote, editRemote, getRemotePushUrl } from './graph-git-actions'

interface IRemoteFormProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly remotes: ReadonlyArray<IRemote>
  /** The remote to edit, null to add a new one */
  readonly remote: IRemote | null
  readonly onClose: () => void
}

interface IRemoteFormState {
  readonly name: string
  readonly pullUrl: string
  readonly pushUrl: string
  /** The push URL the remote had when the form opened */
  readonly initialPushUrl: string
  readonly busy: boolean
}

/** Characters git refuses in ref names, plus whitespace. */
const InvalidNameCharacters = /[\s~^:?*[\\]|\.\.|@\{|^[-.]|[./]$|\.lock$/

/**
 * GitKraken's add / edit remote panel, docked above the commit graph: a name,
 * a pull URL and an optional push URL that defaults to the pull URL.
 */
export class RemoteForm extends React.Component<
  IRemoteFormProps,
  IRemoteFormState
> {
  private nameInput: HTMLInputElement | null = null
  private unmounted = false

  public constructor(props: IRemoteFormProps) {
    super(props)
    const { remote } = props
    this.state = {
      name: remote?.name ?? '',
      pullUrl: remote?.url ?? '',
      pushUrl: '',
      initialPushUrl: '',
      busy: false,
    }
  }

  public componentDidMount() {
    this.nameInput?.focus()
    this.nameInput?.select()
    const { remote, repository } = this.props
    if (remote !== null) {
      getRemotePushUrl(repository, remote.name)
        .then(url => {
          if (!this.unmounted && url !== null && url !== remote.url) {
            this.setState({ pushUrl: url, initialPushUrl: url })
          }
        })
        .catch(e => log.warn('Failed to read the remote push URL', e))
    }
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private get nameError(): string | null {
    const name = this.state.name.trim()
    if (name.length === 0) {
      return null
    }
    if (InvalidNameCharacters.test(name)) {
      return 'Not a valid remote name'
    }
    const taken = this.props.remotes.some(
      r => r.name === name && r.name !== this.props.remote?.name
    )
    return taken ? `A remote named ${name} already exists` : null
  }

  private get isUnchanged() {
    const { remote } = this.props
    const { name, pullUrl, pushUrl, initialPushUrl } = this.state
    return (
      remote !== null &&
      name.trim() === remote.name &&
      pullUrl.trim() === remote.url &&
      pushUrl.trim() === initialPushUrl
    )
  }

  private get canSubmit() {
    const { name, pullUrl, busy } = this.state
    return (
      !busy &&
      name.trim().length > 0 &&
      pullUrl.trim().length > 0 &&
      this.nameError === null &&
      !this.isUnchanged
    )
  }

  private onNameRef = (input: HTMLInputElement | null) => {
    this.nameInput = input
  }

  private onNameChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ name: event.currentTarget.value })
  }

  private onPullUrlChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ pullUrl: event.currentTarget.value })
  }

  private onPushUrlChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ pushUrl: event.currentTarget.value })
  }

  private onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.props.onClose()
    }
  }

  private onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!this.canSubmit) {
      return
    }
    const { repository, dispatcher, remote } = this.props
    const name = this.state.name.trim()
    const pullUrl = this.state.pullUrl.trim()
    const pushUrl = this.state.pushUrl.trim()

    this.setState({ busy: true })
    try {
      if (remote === null) {
        await addRemote(repository, name, pullUrl, pushUrl)
      } else {
        await editRemote(repository, remote.name, name, pullUrl, pushUrl)
      }
      this.props.onClose()
    } catch (e) {
      dispatcher.postError(e instanceof Error ? e : new Error(`${e}`))
      if (!this.unmounted) {
        this.setState({ busy: false })
      }
    } finally {
      await dispatcher.refreshRepository(repository)
    }
  }

  public render() {
    const { remote } = this.props
    const { name, pullUrl, pushUrl, busy } = this.state
    const isAdd = remote === null
    const nameError = this.nameError

    return (
      <form
        className="remote-form"
        onSubmit={this.onSubmit}
        aria-label={isAdd ? 'Add remote' : `Edit remote ${remote.name}`}
      >
        <div className="remote-form-header">
          <Octicon symbol={octicons.globe} />
          <span className="remote-form-title">
            {isAdd ? 'Add Remote' : `Edit Remote: ${remote.name}`}
          </span>
          <button
            type="button"
            className="remote-form-close"
            onClick={this.props.onClose}
            aria-label="Close"
          >
            <Octicon symbol={octicons.x} />
          </button>
        </div>
        <div className="remote-form-body">
          <label className="remote-form-field">
            <span className="remote-form-label">Name</span>
            <input
              ref={this.onNameRef}
              type="text"
              value={name}
              placeholder="e.g. upstream"
              spellCheck={false}
              disabled={busy}
              onKeyDown={this.onKeyDown}
              aria-invalid={nameError !== null}
              onChange={this.onNameChanged}
            />
            {nameError !== null ? (
              <span className="remote-form-error">{nameError}</span>
            ) : null}
          </label>
          <label className="remote-form-field">
            <span className="remote-form-label">Pull URL</span>
            <input
              type="text"
              value={pullUrl}
              placeholder="https://github.com/owner/repo.git"
              spellCheck={false}
              disabled={busy}
              onKeyDown={this.onKeyDown}
              onChange={this.onPullUrlChanged}
            />
          </label>
          <label className="remote-form-field">
            <span className="remote-form-label">Push URL</span>
            <input
              type="text"
              value={pushUrl}
              placeholder={
                pullUrl.trim().length > 0 ? pullUrl.trim() : 'Same as pull URL'
              }
              spellCheck={false}
              disabled={busy}
              onKeyDown={this.onKeyDown}
              onChange={this.onPushUrlChanged}
            />
          </label>
        </div>
        <div className="remote-form-footer">
          <button
            type="button"
            className="remote-form-button"
            onClick={this.props.onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="remote-form-button primary"
            disabled={!this.canSubmit}
          >
            {busy
              ? isAdd
                ? 'Adding…'
                : 'Saving…'
              : isAdd
              ? 'Add Remote'
              : 'Save Remote'}
          </button>
        </div>
      </form>
    )
  }
}
