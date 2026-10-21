import * as React from 'react'
import * as Path from 'path'
import { promises as Fs } from 'fs'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import { AutoSizer, List, ListRowProps } from 'react-virtualized'
import { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { IMenuItem, showContextualMenu } from '../../lib/menu-item'
import { revealInFileManager } from '../../lib/app-shell'
import { Dispatcher } from '../dispatcher'
import { moveItemToTrash, writeClipboardText } from '../main-process-proxy'
import { openFile } from '../lib/open-file'
import {
  CopyFilePathLabel,
  CopyRelativeFilePathLabel,
  DefaultEditorLabel,
  isSafeFileExtension,
  OpenWithDefaultProgramLabel,
  RevealInFileManagerLabel,
  TrashNameLabel,
} from '../lib/context-menu'
import { TooltippedContent } from '../lib/tooltipped-content'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import {
  ExplorerEditKind,
  ExplorerRow,
  flattenTree,
  getDecorations,
  getIgnoredPaths,
  IExplorerDecoration,
  IExplorerEdit,
  IExplorerEntry,
  joinPath,
  parentPath,
  readFolder,
} from './file-explorer-model'

const RowHeight = 22
const IndentWidth = 12

/** Expanded folders per repository so they survive switching views. */
const expandedByRepository = new Map<number, ReadonlySet<string>>()

interface IEntryRowProps {
  readonly entry: IExplorerEntry
  readonly depth: number
  readonly isExpanded: boolean
  readonly isSelected: boolean
  readonly isIgnored: boolean
  readonly decoration: IExplorerDecoration | null
  readonly onClick: (entry: IExplorerEntry) => void
  readonly onDoubleClick: (entry: IExplorerEntry) => void
  readonly onContextMenu: (entry: IExplorerEntry) => void
}

class EntryRow extends React.PureComponent<IEntryRowProps> {
  private onClick = () => this.props.onClick(this.props.entry)

  private onDoubleClick = () => this.props.onDoubleClick(this.props.entry)

  private onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    this.props.onContextMenu(this.props.entry)
  }

  public render() {
    const { entry, depth, isExpanded, isSelected, isIgnored, decoration } =
      this.props
    const folderIcon = isExpanded
      ? octicons.fileDirectoryOpenFill
      : octicons.fileDirectoryFill

    // The tree handles the keyboard for all of its rows.
    return (
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events
      <div
        tabIndex={-1}
        className={classNames(
          'explorer-row',
          decoration?.className,
          entry.isDirectory ? 'folder' : 'file',
          { selected: isSelected, ignored: isIgnored }
        )}
        style={{ paddingLeft: 6 + depth * IndentWidth }}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={entry.isDirectory ? isExpanded : undefined}
        onClick={this.onClick}
        onDoubleClick={this.onDoubleClick}
        onContextMenu={this.onContextMenu}
      >
        <span className="explorer-twistie">
          {entry.isDirectory ? (
            <Octicon
              symbol={isExpanded ? octicons.chevronDown : octicons.chevronRight}
            />
          ) : null}
        </span>
        <Octicon
          className="explorer-icon"
          symbol={entry.isDirectory ? folderIcon : octicons.file}
        />
        <span className="explorer-name">{entry.name}</span>
        {decoration !== null ? (
          <span className="explorer-decoration">
            {entry.isDirectory ? '\u25CF' : decoration.letter}
          </span>
        ) : null}
      </div>
    )
  }
}

interface IInputRowProps {
  readonly edit: ExplorerEditKind
  readonly initialValue: string
  readonly depth: number
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
}

class InputRow extends React.Component<IInputRowProps> {
  private readonly inputRef = React.createRef<HTMLInputElement>()
  private isDone = false

  public componentDidMount() {
    const input = this.inputRef.current
    if (input !== null) {
      input.focus()
      const extension = Path.extname(input.value)
      input.setSelectionRange(0, input.value.length - extension.length)
    }
  }

  private finish(submit: boolean) {
    if (this.isDone) {
      return
    }
    this.isDone = true
    const value = this.inputRef.current?.value.trim() ?? ''
    if (submit && value.length > 0) {
      this.props.onSubmit(value)
    } else {
      this.props.onCancel()
    }
  }

  private onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      this.finish(true)
    } else if (event.key === 'Escape') {
      this.finish(false)
    }
  }

  private onBlur = () => this.finish(true)

  public render() {
    const { edit, depth } = this.props
    const icon = edit === 'new-folder' ? octicons.fileDirectoryFill : null
    return (
      <div
        className="explorer-row editing"
        style={{
          paddingLeft:
            6 + (edit === 'rename' ? depth : depth + 1) * IndentWidth,
        }}
      >
        <span className="explorer-twistie" />
        <Octicon className="explorer-icon" symbol={icon ?? octicons.file} />
        <input
          ref={this.inputRef}
          className="explorer-input"
          defaultValue={this.props.initialValue}
          aria-label={edit === 'rename' ? 'New name' : 'Name'}
          spellCheck={false}
          onKeyDown={this.onKeyDown}
          onBlur={this.onBlur}
        />
      </div>
    )
  }
}

interface IFileExplorerProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly files: ReadonlyArray<WorkingDirectoryFileChange>
  readonly externalEditorLabel?: string
  /** Opens a path relative to the repository root in the external editor */
  readonly onOpenInExternalEditor: (path: string) => void
  /** Shows the working directory diff of a changed file */
  readonly onOpenChangedFile: (path: string) => void
  /** Opens the integrated terminal in a folder of the repository */
  readonly onOpenInTerminal: (path: string) => void
}

interface IFileExplorerState {
  readonly children: ReadonlyMap<string, ReadonlyArray<IExplorerEntry>>
  readonly expanded: ReadonlySet<string>
  readonly ignored: ReadonlySet<string>
  readonly selected: string | null
  readonly edit: IExplorerEdit | null
}

/** VS Code's Explorer: the working directory as a tree. */
export class FileExplorer extends React.Component<
  IFileExplorerProps,
  IFileExplorerState
> {
  private readonly listRef = React.createRef<List>()
  private loadGeneration = 0

  private getRows = memoizeOne(flattenTree)

  private getDecorations = memoizeOne(getDecorations)

  public constructor(props: IFileExplorerProps) {
    super(props)
    this.state = {
      children: new Map(),
      expanded: expandedByRepository.get(props.repository.id) ?? new Set(),
      ignored: new Set(),
      selected: null,
      edit: null,
    }
  }

  public componentDidMount() {
    this.refresh()
  }

  public componentDidUpdate(
    prevProps: IFileExplorerProps,
    prevState: IFileExplorerState
  ) {
    const { repository } = this.props
    if (prevProps.repository.id !== repository.id) {
      this.loadGeneration++
      this.setState(
        {
          children: new Map(),
          expanded: expandedByRepository.get(repository.id) ?? new Set(),
          ignored: new Set(),
          selected: null,
          edit: null,
        },
        () => this.refresh()
      )
      return
    }
    if (prevState.expanded !== this.state.expanded) {
      expandedByRepository.set(repository.id, this.state.expanded)
    }
    if (prevProps.files !== this.props.files) {
      this.refresh()
    }
  }

  private get rows() {
    return this.getRows(
      this.state.children,
      this.state.expanded,
      this.state.edit
    )
  }

  private get decorations() {
    return this.getDecorations(this.props.files)
  }

  /** Reload the root and every expanded folder. */
  private refresh = () => {
    const folders = ['', ...this.state.expanded]
    return Promise.all(folders.map(dir => this.loadFolder(dir)))
  }

  private async loadFolder(dir: string) {
    const { repository } = this.props
    const generation = this.loadGeneration
    let entries: ReadonlyArray<IExplorerEntry> | null = null
    let ignored: ReadonlyArray<string> = []
    try {
      entries = await readFolder(repository, dir)
      ignored = await getIgnoredPaths(repository, entries).catch(() => [])
    } catch (e) {
      if (dir === '') {
        log.warn(`Failed to read ${repository.path}`, e)
      }
    }
    if (generation !== this.loadGeneration) {
      return
    }
    this.setState(state => {
      const children = new Map(state.children)
      const expanded = new Set(state.expanded)
      const ignoredPaths = new Set(state.ignored)
      for (const entry of state.children.get(dir) ?? []) {
        ignoredPaths.delete(entry.path)
      }
      if (entries === null) {
        children.delete(dir)
        expanded.delete(dir)
      } else {
        children.set(dir, entries)
        ignored.forEach(p => ignoredPaths.add(p))
      }
      return { children, expanded, ignored: ignoredPaths }
    })
  }

  private setExpanded(dir: string, expand: boolean) {
    if (this.state.expanded.has(dir) === expand) {
      return
    }
    const expanded = new Set(this.state.expanded)
    if (expand) {
      expanded.add(dir)
      this.loadFolder(dir)
    } else {
      for (const path of this.state.expanded) {
        if (path === dir || path.startsWith(`${dir}/`)) {
          expanded.delete(path)
        }
      }
    }
    this.setState({ expanded })
  }

  private onCollapseAll = () => this.setState({ expanded: new Set() })

  private open(entry: IExplorerEntry) {
    const decoration = this.decorations.fileDecorations.get(entry.path)
    if (decoration !== undefined) {
      this.props.onOpenChangedFile(entry.path)
    } else {
      this.props.onOpenInExternalEditor(entry.path)
    }
  }

  private onRowClick = (entry: IExplorerEntry) => {
    this.setState({ selected: entry.path })
    if (entry.isDirectory) {
      this.setExpanded(entry.path, !this.state.expanded.has(entry.path))
    } else if (this.decorations.fileDecorations.has(entry.path)) {
      this.props.onOpenChangedFile(entry.path)
    }
  }

  private onRowDoubleClick = (entry: IExplorerEntry) => {
    if (!entry.isDirectory) {
      this.props.onOpenInExternalEditor(entry.path)
    }
  }

  /** The folder new entries go into when `entry` is selected. */
  private targetFolder(entry: IExplorerEntry | null) {
    if (entry === null) {
      return ''
    }
    return entry.isDirectory ? entry.path : parentPath(entry.path)
  }

  private get selectedEntry(): IExplorerEntry | null {
    const { selected } = this.state
    for (const row of this.rows) {
      if (row.kind === 'entry' && row.entry.path === selected) {
        return row.entry
      }
    }
    return null
  }

  private startEdit(kind: ExplorerEditKind, path: string) {
    if (kind !== 'rename' && path !== '') {
      this.setExpanded(path, true)
    }
    this.setState({ edit: { kind, path } })
  }

  private onNewFile = () =>
    this.startEdit('new-file', this.targetFolder(this.selectedEntry))

  private onNewFolder = () =>
    this.startEdit('new-folder', this.targetFolder(this.selectedEntry))

  private onCancelEdit = () => this.setState({ edit: null })

  private onSubmitEdit = async (name: string) => {
    const { edit } = this.state
    const { repository, dispatcher } = this.props
    this.setState({ edit: null })
    if (edit === null) {
      return
    }
    const folder = edit.kind === 'rename' ? parentPath(edit.path) : edit.path
    const target = joinPath(folder, name.replace(/\\/g, '/'))
    const fullTarget = Path.join(repository.path, target)
    if (edit.kind === 'rename' && target === edit.path) {
      return
    }
    try {
      const exists = await Fs.access(fullTarget).then(
        () => true,
        () => false
      )
      if (exists) {
        throw new Error(`A file or folder named "${name}" already exists.`)
      }
      if (edit.kind === 'new-folder') {
        await Fs.mkdir(fullTarget, { recursive: true })
      } else if (edit.kind === 'new-file') {
        await Fs.mkdir(Path.dirname(fullTarget), { recursive: true })
        await Fs.writeFile(fullTarget, '', { flag: 'wx' })
      } else {
        await Fs.mkdir(Path.dirname(fullTarget), { recursive: true })
        await Fs.rename(Path.join(repository.path, edit.path), fullTarget)
      }
    } catch (e) {
      dispatcher.postError(e instanceof Error ? e : new Error(`${e}`))
      return
    }
    this.setState({ selected: target })
    await this.loadFolder(folder)
    await this.loadFolder(parentPath(target))
    dispatcher.refreshStatus(repository)
  }

  private async deleteEntry(entry: IExplorerEntry) {
    const { repository, dispatcher } = this.props
    const what = entry.isDirectory ? 'folder' : 'file'
    if (!window.confirm(`Move the ${what} "${entry.name}" to the trash?`)) {
      return
    }
    try {
      await moveItemToTrash(Path.join(repository.path, entry.path))
    } catch (e) {
      dispatcher.postError(e instanceof Error ? e : new Error(`${e}`))
    }
    await this.loadFolder(parentPath(entry.path))
    dispatcher.refreshStatus(repository)
  }

  private onRowContextMenu = (entry: IExplorerEntry) => {
    this.setState({ selected: entry.path })
    const { repository, dispatcher, externalEditorLabel } = this.props
    const fullPath = Path.join(repository.path, entry.path)
    const folder = this.targetFolder(entry)
    const decoration = this.decorations.fileDecorations.get(entry.path)
    const isUntracked =
      this.props.files.find(f => f.path === entry.path)?.status.kind ===
      AppFileStatusKind.Untracked

    const items: IMenuItem[] = [
      {
        label: __DARWIN__ ? 'New File…' : 'New file…',
        action: () => this.startEdit('new-file', folder),
      },
      {
        label: __DARWIN__ ? 'New Folder…' : 'New folder…',
        action: () => this.startEdit('new-folder', folder),
      },
      { type: 'separator' },
    ]
    if (!entry.isDirectory) {
      items.push(
        {
          label: __DARWIN__ ? 'Open Changes' : 'Open changes',
          enabled: decoration !== undefined,
          action: () => this.props.onOpenChangedFile(entry.path),
        },
        {
          label: externalEditorLabel
            ? `Open in ${externalEditorLabel}`
            : DefaultEditorLabel,
          action: () => this.props.onOpenInExternalEditor(entry.path),
        },
        {
          label: OpenWithDefaultProgramLabel,
          enabled: isSafeFileExtension(Path.extname(entry.path)),
          action: () => openFile(fullPath, dispatcher),
        }
      )
    }
    items.push(
      {
        label: RevealInFileManagerLabel,
        action: () => revealInFileManager(repository, entry.path),
      },
      {
        label: __DARWIN__ ? 'Open in Integrated Terminal' : 'Open in terminal',
        action: () => this.props.onOpenInTerminal(folder),
      },
      { type: 'separator' },
      { label: CopyFilePathLabel, action: () => writeClipboardText(fullPath) },
      {
        label: CopyRelativeFilePathLabel,
        action: () => writeClipboardText(entry.path),
      },
      { type: 'separator' },
      {
        label: 'Add to .gitignore',
        enabled: isUntracked || entry.isDirectory,
        action: () =>
          dispatcher.appendIgnoreFile(
            repository,
            entry.isDirectory ? `${entry.path}/` : entry.path
          ),
      },
      {
        label: 'Rename…',
        action: () => this.startEdit('rename', entry.path),
      },
      {
        label: `Move to ${TrashNameLabel}`,
        action: () => this.deleteEntry(entry),
      }
    )
    showContextualMenu(items)
  }

  private onBackgroundContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    showContextualMenu([
      {
        label: __DARWIN__ ? 'New File…' : 'New file…',
        action: () => this.startEdit('new-file', ''),
      },
      {
        label: __DARWIN__ ? 'New Folder…' : 'New folder…',
        action: () => this.startEdit('new-folder', ''),
      },
      { type: 'separator' },
      {
        label: __DARWIN__ ? 'Open in Integrated Terminal' : 'Open in terminal',
        action: () => this.props.onOpenInTerminal(''),
      },
      {
        label: RevealInFileManagerLabel,
        action: () => revealInFileManager(this.props.repository, ''),
      },
    ])
  }

  private onKeyDown = (event: React.KeyboardEvent) => {
    if (this.state.edit !== null) {
      return
    }
    const entries = this.rows.flatMap(r => (r.kind === 'entry' ? [r] : []))
    const index = entries.findIndex(r => r.entry.path === this.state.selected)
    const current = index === -1 ? null : entries[index].entry
    const select = (i: number) => {
      const row = entries[Math.max(0, Math.min(entries.length - 1, i))]
      if (row !== undefined) {
        this.setState({ selected: row.entry.path })
      }
    }

    switch (event.key) {
      case 'ArrowDown':
        select(index + 1)
        break
      case 'ArrowUp':
        select(index === -1 ? 0 : index - 1)
        break
      case 'ArrowRight':
        if (current?.isDirectory) {
          this.setExpanded(current.path, true)
        }
        break
      case 'ArrowLeft':
        if (current?.isDirectory && this.state.expanded.has(current.path)) {
          this.setExpanded(current.path, false)
        } else if (current !== null && parentPath(current.path) !== '') {
          this.setState({ selected: parentPath(current.path) })
        }
        break
      case 'Enter':
        if (current?.isDirectory) {
          this.setExpanded(current.path, !this.state.expanded.has(current.path))
        } else if (current !== null) {
          this.open(current)
        }
        break
      case 'F2':
        if (current !== null) {
          this.startEdit('rename', current.path)
        }
        break
      case 'Delete':
      case 'Backspace':
        if (current !== null && (event.key === 'Delete' || event.metaKey)) {
          this.deleteEntry(current)
        }
        break
      default:
        return
    }
    event.preventDefault()
  }

  private renderRow = ({ index, key, style }: ListRowProps) => {
    const row: ExplorerRow = this.rows[index]
    if (row.kind === 'input') {
      const initialValue = row.edit === 'rename' ? Path.basename(row.path) : ''
      return (
        <div key={key} style={style}>
          <InputRow
            edit={row.edit}
            initialValue={initialValue}
            depth={row.depth}
            onSubmit={this.onSubmitEdit}
            onCancel={this.onCancelEdit}
          />
        </div>
      )
    }

    const { entry } = row
    const { fileDecorations, folderDecorations } = this.decorations
    const decoration =
      (entry.isDirectory ? folderDecorations : fileDecorations).get(
        entry.path
      ) ?? null
    return (
      <div key={key} style={style}>
        <EntryRow
          entry={entry}
          depth={row.depth}
          isExpanded={this.state.expanded.has(entry.path)}
          isSelected={this.state.selected === entry.path}
          isIgnored={this.state.ignored.has(entry.path)}
          decoration={decoration}
          onClick={this.onRowClick}
          onDoubleClick={this.onRowDoubleClick}
          onContextMenu={this.onRowContextMenu}
        />
      </div>
    )
  }

  private renderHeaderButton(
    label: string,
    symbol: typeof octicons.x,
    onClick: () => void
  ) {
    return (
      <TooltippedContent tagName="span" tooltip={label}>
        <button type="button" aria-label={label} onClick={onClick}>
          <Octicon symbol={symbol} />
        </button>
      </TooltippedContent>
    )
  }

  private renderList = ({
    width,
    height,
  }: {
    width: number
    height: number
  }) => {
    const rows = this.rows
    const selectedIndex = rows.findIndex(
      r => r.kind === 'entry' && r.entry.path === this.state.selected
    )
    const editIndex = rows.findIndex(r => r.kind === 'input')
    return (
      <List
        ref={this.listRef}
        width={width}
        height={height}
        rowCount={rows.length}
        rowHeight={RowHeight}
        rowRenderer={this.renderRow}
        scrollToIndex={editIndex !== -1 ? editIndex : selectedIndex}
        // Re-render rows whenever anything they show changes.
        rows={rows}
        explorerState={this.state}
        decorations={this.decorations}
      />
    )
  }

  public render() {
    return (
      <div className="file-explorer">
        <div className="file-explorer-header">
          <span className="file-explorer-title">
            {this.props.repository.name}
          </span>
          <span className="file-explorer-actions">
            {this.renderHeaderButton(
              'New File…',
              octicons.fileAdded,
              this.onNewFile
            )}
            {this.renderHeaderButton(
              'New Folder…',
              octicons.fileDirectory,
              this.onNewFolder
            )}
            {this.renderHeaderButton('Refresh', octicons.sync, this.refresh)}
            {this.renderHeaderButton(
              'Collapse Folders',
              octicons.fold,
              this.onCollapseAll
            )}
          </span>
        </div>
        <div
          className="file-explorer-tree"
          role="tree"
          tabIndex={0}
          onKeyDown={this.onKeyDown}
          onContextMenu={this.onBackgroundContextMenu}
        >
          <AutoSizer>{this.renderList}</AutoSizer>
        </div>
      </div>
    )
  }
}
