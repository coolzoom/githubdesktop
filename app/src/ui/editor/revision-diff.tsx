import * as React from 'react'
import { Repository } from '../../models/repository'
import { getBlobContents } from '../../lib/git/show'
import { getIndexFileContents } from '../../lib/git/index-file'
import { MonacoDiff } from './monaco-diff'
import { EditorDocument, RepositoryEditors } from './editor-store'

/** One side of a diff: a file in a commit, in the index, or nothing. */
export type DiffRevision =
  | {
      readonly kind: 'commit'
      readonly commitish: string
      readonly path: string
    }
  | { readonly kind: 'index'; readonly path: string }
  | { readonly kind: 'empty' }

async function readRevision(repository: Repository, revision: DiffRevision) {
  try {
    switch (revision.kind) {
      case 'commit':
        return (
          await getBlobContents(repository, revision.commitish, revision.path)
        ).toString('utf8')
      case 'index':
        return (
          (await getIndexFileContents(repository, revision.path))?.toString(
            'utf8'
          ) ?? ''
        )
      case 'empty':
        return ''
    }
  } catch {
    // Missing on that side, e.g. the parent of a root commit.
    return ''
  }
}

interface IRevisionDiffProps {
  readonly repository: Repository
  readonly path: string
  readonly original: DiffRevision
  readonly modified: DiffRevision
  /** Reloads both sides when it changes, e.g. after the status refreshed */
  readonly refreshKey?: unknown
  readonly sideBySide: boolean
  readonly ignoreTrimWhitespace: boolean
}

interface IRevisionDiffState {
  readonly texts: {
    readonly original: string
    readonly modified: string
  } | null
}

const sameRevision = (a: DiffRevision, b: DiffRevision) =>
  JSON.stringify(a) === JSON.stringify(b)

/** A read-only Monaco diff between two stored versions of a file. */
export class RevisionDiff extends React.Component<
  IRevisionDiffProps,
  IRevisionDiffState
> {
  private request = 0

  public constructor(props: IRevisionDiffProps) {
    super(props)
    this.state = { texts: null }
  }

  public componentDidMount() {
    this.load()
  }

  public componentDidUpdate(prevProps: IRevisionDiffProps) {
    const props = this.props
    if (
      prevProps.repository.id !== props.repository.id ||
      !sameRevision(prevProps.original, props.original) ||
      !sameRevision(prevProps.modified, props.modified) ||
      prevProps.refreshKey !== props.refreshKey
    ) {
      this.load()
    }
  }

  public componentWillUnmount() {
    this.request++
  }

  private async load() {
    const request = ++this.request
    const { repository, original, modified } = this.props
    const [originalText, modifiedText] = await Promise.all([
      readRevision(repository, original),
      readRevision(repository, modified),
    ])
    if (request === this.request) {
      this.setState({
        texts: { original: originalText, modified: modifiedText },
      })
    }
  }

  public render() {
    const { texts } = this.state
    if (texts === null) {
      return <div className="monaco-diff-host" />
    }
    return (
      <MonacoDiff
        path={this.props.path}
        original={texts.original}
        modified={texts.modified}
        sideBySide={this.props.sideBySide}
        ignoreTrimWhitespace={this.props.ignoreTrimWhitespace}
      />
    )
  }
}

interface IDocumentDiffProps {
  readonly editors: RepositoryEditors
  readonly path: string
  readonly sideBySide: boolean
  readonly ignoreTrimWhitespace: boolean
  readonly revealLine?: number
  /** Shown when the working copy can't be edited as text */
  readonly fallback?: React.ReactNode
}

/**
 * The staged version against the working copy, which can be edited right in
 * the diff and is shared with the file's editor tab.
 */
export class DocumentDiff extends React.Component<IDocumentDiffProps> {
  private document: EditorDocument | null = null
  private subscription: { dispose(): void } | null = null

  public componentDidMount() {
    this.acquire()
    this.subscription = this.props.editors.onDidChange(() => this.forceUpdate())
  }

  public componentDidUpdate(prevProps: IDocumentDiffProps) {
    if (
      prevProps.editors !== this.props.editors ||
      prevProps.path !== this.props.path
    ) {
      this.releaseDocument(prevProps.editors)
      this.subscription?.dispose()
      this.acquire()
      this.subscription = this.props.editors.onDidChange(() =>
        this.forceUpdate()
      )
    }
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
    this.releaseDocument(this.props.editors)
  }

  private acquire() {
    this.document = this.props.editors.acquire(this.props.path)
    this.document.ready.then(() => this.forceUpdate())
    this.forceUpdate()
  }

  /**
   * Deferred because the child diff editor still holds the document's model
   * until it has unmounted or switched models, which happens after this.
   */
  private releaseDocument(editors: RepositoryEditors) {
    const document = this.document
    if (document !== null) {
      this.document = null
      window.setTimeout(() => editors.release(document), 0)
    }
  }

  private onSave = () => {
    this.document?.save()
  }

  public render() {
    const document = this.document
    if (document !== null && document.unsupported !== null) {
      return this.props.fallback ?? null
    }
    if (document === null || document.model === null) {
      return <div className="monaco-diff-host" />
    }
    return (
      <MonacoDiff
        path={this.props.path}
        original={document.indexText ?? ''}
        modified={document.model}
        sideBySide={this.props.sideBySide}
        ignoreTrimWhitespace={this.props.ignoreTrimWhitespace}
        revealLine={this.props.revealLine}
        onSave={this.onSave}
      />
    )
  }
}
