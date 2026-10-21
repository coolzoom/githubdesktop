import * as React from 'react'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import { Repository } from '../../models/repository'
import { Commit } from '../../models/commit'
import { AppFileStatusKind, CommittedFileChange } from '../../models/status'
import { Account } from '../../models/account'
import { IGraphStash } from '../../models/stash-entry'
import { getAvatarUsersForCommit } from '../../models/avatar'
import { IChangesetData } from '../../lib/git'
import { getCommitTreePaths } from '../../lib/git/graph'
import { Emoji } from '../../lib/emoji'
import { formatDate } from '../../lib/format-date'
import { mapStatus } from '../../lib/status'
import { List } from '../lib/list'
import { Avatar } from '../lib/avatar'
import { RichText } from '../lib/rich-text'
import { TooltippedContent } from '../lib/tooltipped-content'
import { Octicon, iconForStatus } from '../octicons'
import * as octicons from '../octicons/octicons.generated'

interface ICommitDetailsProps {
  readonly repository: Repository
  readonly commits: ReadonlyArray<Commit>
  readonly isContiguous: boolean
  readonly changesetData: IChangesetData
  readonly selectedFile: CommittedFileChange | null
  readonly isDiffOpen: boolean
  readonly stash: IGraphStash | null
  readonly emoji: Map<string, Emoji>
  readonly accounts: ReadonlyArray<Account>
  readonly treeView: boolean
  readonly onTreeViewChanged: (treeView: boolean) => void
  readonly onFileSelected: (file: CommittedFileChange) => void
  readonly onFileDoubleClick: (file: CommittedFileChange) => void
  readonly onFileContextMenu: (
    file: CommittedFileChange,
    event: React.MouseEvent<HTMLDivElement>
  ) => void
  readonly onCommitShaClicked: (sha: string) => void
}

interface ICommitDetailsState {
  readonly viewAllFiles: boolean
  readonly allFiles: ReadonlyArray<string> | null
  readonly collapsedFolders: ReadonlySet<string>
}

type FileRow =
  | {
      readonly kind: 'folder'
      readonly path: string
      readonly name: string
      readonly depth: number
    }
  | {
      readonly kind: 'file'
      readonly path: string
      readonly depth: number
      readonly file: CommittedFileChange | null
    }

interface ITreeNode {
  readonly folders: Map<string, ITreeNode>
  readonly files: Array<{ path: string; file: CommittedFileChange | null }>
}

function statusCounts(files: ReadonlyArray<CommittedFileChange>) {
  let added = 0
  let deleted = 0
  let modified = 0
  for (const f of files) {
    switch (f.status.kind) {
      case AppFileStatusKind.New:
      case AppFileStatusKind.Untracked:
      case AppFileStatusKind.Copied:
        added++
        break
      case AppFileStatusKind.Deleted:
        deleted++
        break
      default:
        modified++
    }
  }
  return { added, deleted, modified }
}

interface IShaLinkProps {
  readonly sha: string
  readonly onClick: (sha: string) => void
}

class ShaLink extends React.PureComponent<IShaLinkProps> {
  private onClick = () => this.props.onClick(this.props.sha)

  public render() {
    return (
      <button className="sha-link" onClick={this.onClick}>
        {this.props.sha.slice(0, 6)}
      </button>
    )
  }
}

/** The right panel of the History view: the selected commit and its files. */
export class CommitDetails extends React.Component<
  ICommitDetailsProps,
  ICommitDetailsState
> {
  private getRows = memoizeOne(
    (
      _changeset: IChangesetData,
      _allFiles: ReadonlyArray<string> | null,
      _viewAllFiles: boolean,
      _treeView: boolean,
      _collapsed: ReadonlySet<string>
    ) => this.buildRows()
  )

  public constructor(props: ICommitDetailsProps) {
    super(props)
    this.state = {
      viewAllFiles: false,
      allFiles: null,
      collapsedFolders: new Set(),
    }
  }

  public componentDidUpdate(prevProps: ICommitDetailsProps) {
    const prevSha = prevProps.commits[0]?.sha
    const sha = this.props.commits[0]?.sha
    if (prevSha !== sha && this.state.allFiles !== null) {
      this.setState({ allFiles: null })
      if (this.state.viewAllFiles) {
        this.loadAllFiles()
      }
    }
  }

  private async loadAllFiles() {
    const commit = this.props.commits[0]
    if (commit === undefined) {
      return
    }
    try {
      const allFiles = await getCommitTreePaths(
        this.props.repository,
        commit.sha
      )
      if (this.props.commits[0]?.sha === commit.sha) {
        this.setState({ allFiles })
      }
    } catch (e) {
      log.warn('Failed to list commit tree', e)
    }
  }

  private onViewAllFilesChanged = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const viewAllFiles = event.currentTarget.checked
    this.setState({ viewAllFiles })
    if (viewAllFiles && this.state.allFiles === null) {
      this.loadAllFiles()
    }
  }

  private get fileEntries(): ReadonlyArray<{
    path: string
    file: CommittedFileChange | null
  }> {
    const { files } = this.props.changesetData
    const changed = files.map(file => ({ path: file.path, file }))
    if (!this.state.viewAllFiles || this.state.allFiles === null) {
      return changed
    }
    const byPath = new Map(files.map(f => [f.path, f]))
    return this.state.allFiles.map(path => ({
      path,
      file: byPath.get(path) ?? null,
    }))
  }

  private get rows(): ReadonlyArray<FileRow> {
    return this.getRows(
      this.props.changesetData,
      this.state.allFiles,
      this.state.viewAllFiles,
      this.props.treeView,
      this.state.collapsedFolders
    )
  }

  private buildRows(): ReadonlyArray<FileRow> {
    const entries = this.fileEntries
    if (!this.props.treeView) {
      return entries.map(e => ({
        kind: 'file' as const,
        path: e.path,
        depth: 0,
        file: e.file,
      }))
    }

    const root: ITreeNode = { folders: new Map(), files: [] }
    for (const entry of entries) {
      const parts = entry.path.split('/')
      let node = root
      for (const part of parts.slice(0, -1)) {
        let child = node.folders.get(part)
        if (child === undefined) {
          child = { folders: new Map(), files: [] }
          node.folders.set(part, child)
        }
        node = child
      }
      node.files.push(entry)
    }

    const rows: FileRow[] = []
    const walk = (node: ITreeNode, prefix: string, depth: number) => {
      for (const [name, child] of [...node.folders].sort((a, b) =>
        a[0].localeCompare(b[0])
      )) {
        // Collapse chains of single-child folders into one row.
        let label = name
        let folder = child
        let path = prefix + name
        while (folder.files.length === 0 && folder.folders.size === 1) {
          const [[nextName, next]] = [...folder.folders]
          label = `${label}/${nextName}`
          path = `${path}/${nextName}`
          folder = next
        }
        rows.push({ kind: 'folder', path, name: label, depth })
        if (!this.state.collapsedFolders.has(path)) {
          walk(folder, `${path}/`, depth + 1)
        }
      }
      for (const entry of node.files) {
        rows.push({ kind: 'file', path: entry.path, depth, file: entry.file })
      }
    }
    walk(root, '', 0)
    return rows
  }

  private renderFileRow = (index: number) => {
    const row = this.rows[index]
    if (row === undefined) {
      return null
    }
    const padding = 8 + row.depth * 14

    if (row.kind === 'folder') {
      const collapsed = this.state.collapsedFolders.has(row.path)
      return (
        <div className="details-file folder" style={{ paddingLeft: padding }}>
          <Octicon
            symbol={collapsed ? octicons.chevronRight : octicons.chevronDown}
          />
          <Octicon symbol={octicons.fileDirectory} />
          <span className="file-name">{row.name}</span>
        </div>
      )
    }

    const name = row.path.split('/').pop() ?? row.path
    const dir = this.props.treeView
      ? ''
      : row.path.slice(0, row.path.length - name.length)
    const status = row.file?.status

    return (
      <div
        className={classNames('details-file', { unchanged: row.file === null })}
        style={{ paddingLeft: padding }}
      >
        {status !== undefined ? (
          <Octicon
            symbol={iconForStatus(status)}
            className={`status status-${mapStatus(status).toLowerCase()}`}
          />
        ) : (
          <span className="status-placeholder" />
        )}
        <TooltippedContent
          className="file-path"
          tagName="span"
          tooltip={row.path}
        >
          {dir.length > 0 ? <span className="file-dir">{dir}</span> : null}
          <span className="file-name">{name}</span>
        </TooltippedContent>
      </div>
    )
  }

  private onFileRowClick = (index: number) => {
    const row = this.rows[index]
    if (row === undefined) {
      return
    }
    if (row.kind === 'folder') {
      const collapsedFolders = new Set(this.state.collapsedFolders)
      if (collapsedFolders.has(row.path)) {
        collapsedFolders.delete(row.path)
      } else {
        collapsedFolders.add(row.path)
      }
      this.setState({ collapsedFolders })
    } else if (row.file !== null) {
      this.props.onFileSelected(row.file)
    }
  }

  private onFileRowDoubleClick = (index: number) => {
    const row = this.rows[index]
    if (row?.kind === 'file' && row.file !== null) {
      this.props.onFileDoubleClick(row.file)
    }
  }

  private onFileRowContextMenu = (
    index: number,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    const row = this.rows[index]
    if (row?.kind === 'file' && row.file !== null) {
      this.props.onFileContextMenu(row.file, event)
    }
  }

  private renderAuthor(commit: Commit) {
    const users = getAvatarUsersForCommit(
      this.props.repository.gitHubRepository,
      commit
    )
    const date = formatDate(commit.author.date, {
      dateStyle: 'short',
      timeStyle: 'short',
    })
    return (
      <div className="details-author">
        {users.length > 0 ? (
          <Avatar
            user={users[0]}
            title={null}
            size={32}
            accounts={this.props.accounts}
          />
        ) : null}
        <div className="details-author-text">
          <div className="author-name">{commit.author.name}</div>
          <div className="author-date">authored {date}</div>
          {commit.committer.name !== commit.author.name ? (
            <div className="author-date">
              committed by {commit.committer.name}
            </div>
          ) : null}
        </div>
        <div className="details-parents">
          {commit.parentSHAs.map(p => (
            <div key={p}>
              parent:{' '}
              <ShaLink sha={p} onClick={this.props.onCommitShaClicked} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  private renderHeader() {
    const { commits, stash, emoji } = this.props
    if (commits.length > 1) {
      return (
        <div className="details-header">
          <div className="details-sha">{commits.length} commits selected</div>
          <div className="details-message">
            {commits.map(c => (
              <div key={c.sha} className="multi-commit">
                <ShaLink sha={c.sha} onClick={this.props.onCommitShaClicked} />{' '}
                {c.summary}
              </div>
            ))}
          </div>
        </div>
      )
    }

    const commit = commits[0]
    return (
      <div className="details-header">
        <div className="details-sha">
          {stash !== null ? `${stash.name}: ` : 'commit: '}
          <span className="sha">{commit.sha.slice(0, 6)}</span>
        </div>
        <div className="details-message">
          <RichText
            className="summary"
            emoji={emoji}
            text={stash?.message ?? commit.summary}
            renderUrlsAsLinks={true}
          />
          {commit.body.trim().length > 0 ? (
            <RichText
              className="body"
              emoji={emoji}
              text={commit.body.trim()}
              renderUrlsAsLinks={true}
            />
          ) : null}
        </div>
        {this.renderAuthor(commit)}
      </div>
    )
  }

  private renderStats() {
    const { files, linesAdded, linesDeleted } = this.props.changesetData
    const { added, deleted, modified } = statusCounts(files)
    return (
      <div className="details-stats">
        {modified > 0 ? (
          <span className="stat-modified">
            <Octicon symbol={octicons.diffModified} /> {modified} modified
          </span>
        ) : null}
        {added > 0 ? (
          <span className="stat-added">
            <Octicon symbol={octicons.diffAdded} /> {added} added
          </span>
        ) : null}
        {deleted > 0 ? (
          <span className="stat-deleted">
            <Octicon symbol={octicons.diffRemoved} /> {deleted} deleted
          </span>
        ) : null}
        {linesAdded + linesDeleted > 0 ? (
          <span className="stat-lines">
            <span className="lines-added">+{linesAdded}</span>{' '}
            <span className="lines-deleted">-{linesDeleted}</span>
          </span>
        ) : null}
      </div>
    )
  }

  private onPathViewClicked = () => this.props.onTreeViewChanged(false)

  private onTreeViewClicked = () => this.props.onTreeViewChanged(true)

  private renderControls() {
    const { treeView } = this.props
    return (
      <div className="details-controls">
        <div className="segmented">
          <button
            className={classNames({ active: !treeView })}
            onClick={this.onPathViewClicked}
          >
            <Octicon symbol={octicons.listUnordered} /> Path
          </button>
          <button
            className={classNames({ active: treeView })}
            onClick={this.onTreeViewClicked}
          >
            <Octicon symbol={octicons.fileDirectory} /> Tree
          </button>
        </div>
        {this.props.commits.length === 1 ? (
          <label className="view-all-files">
            <input
              type="checkbox"
              checked={this.state.viewAllFiles}
              onChange={this.onViewAllFilesChanged}
            />
            View all files
          </label>
        ) : null}
      </div>
    )
  }

  private get selectedRows() {
    const { selectedFile, isDiffOpen } = this.props
    if (selectedFile === null || !isDiffOpen) {
      return []
    }
    const index = this.rows.findIndex(
      r => r.kind === 'file' && r.path === selectedFile.path
    )
    return index === -1 ? [] : [index]
  }

  public render() {
    const { commits, isContiguous } = this.props
    if (commits.length === 0) {
      return (
        <div className="commit-details-panel gk-theme empty">
          No commit selected
        </div>
      )
    }

    const rows = this.rows
    return (
      <div className="commit-details-panel gk-theme">
        {this.renderHeader()}
        {commits.length > 1 && !isContiguous ? (
          <div className="details-note">
            The selected commits are not a single first-parent range, so no
            combined diff can be shown.
          </div>
        ) : (
          <>
            {this.renderStats()}
            {this.renderControls()}
            <div className="details-files">
              <List
                ariaLabel="Changed files"
                rowCount={rows.length}
                rowHeight={24}
                rowRenderer={this.renderFileRow}
                selectedRows={this.selectedRows}
                onRowClick={this.onFileRowClick}
                onRowDoubleClick={this.onFileRowDoubleClick}
                onRowContextMenu={this.onFileRowContextMenu}
                invalidationProps={{
                  rows,
                  selected: this.props.selectedFile,
                  open: this.props.isDiffOpen,
                }}
              />
            </div>
          </>
        )}
      </div>
    )
  }
}
