import * as React from 'react'
import classNames from 'classnames'
import { Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { IRemote } from '../../models/remote'
import { IGraphStash } from '../../models/stash-entry'
import { Branch } from '../../models/branch'
import { IBranchTracking } from '../../lib/git/graph'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TooltippedContent } from '../lib/tooltipped-content'
import { getRefsBySha, GraphRefKind, IGraphRef } from './graph-model'
import { graphViewStore } from './graph-view-store'

export enum RefPanelSection {
  Local = 'local',
  Remote = 'remote',
  Tags = 'tags',
  Stashes = 'stashes',
}

const SectionTitles: Record<RefPanelSection, string> = {
  [RefPanelSection.Local]: 'LOCAL',
  [RefPanelSection.Remote]: 'REMOTE',
  [RefPanelSection.Tags]: 'TAGS',
  [RefPanelSection.Stashes]: 'STASHES',
}

interface IRefPanelProps {
  readonly repository: Repository
  readonly branches: ReadonlyArray<Branch>
  readonly currentBranchName: string | null
  readonly remotes: ReadonlyArray<IRemote>
  readonly tags: Map<string, string> | null
  readonly stashes: ReadonlyArray<IGraphStash>
  readonly onRefSelected: (ref: IGraphRef) => void
  readonly onRefDoubleClick: (ref: IGraphRef) => void
  readonly onStashSelected: (stash: IGraphStash) => void
  readonly onRefContextMenu: (
    ref: IGraphRef,
    selected: ReadonlyArray<IGraphRef>,
    event: React.MouseEvent
  ) => void
  readonly onRemoteContextMenu: (
    remote: IRemote,
    event: React.MouseEvent
  ) => void
  readonly onStashContextMenu: (
    stash: IGraphStash,
    event: React.MouseEvent
  ) => void
  readonly onSectionContextMenu: (
    section: RefPanelSection,
    refs: ReadonlyArray<IGraphRef>,
    event: React.MouseEvent
  ) => void
}

interface IRefPanelState {
  readonly filterText: string
  readonly selectedIds: ReadonlySet<string>
  readonly tick: number
}

interface IFolder {
  readonly folders: Map<string, IFolder>
  readonly refs: IGraphRef[]
}

/** Group refs into folders by the `/`-separated parts of their names. */
function buildTree(refs: ReadonlyArray<IGraphRef>, prefixLength: number) {
  const root: IFolder = { folders: new Map(), refs: [] }
  for (const ref of refs) {
    const parts = ref.name.slice(prefixLength).split('/')
    let folder = root
    for (const part of parts.slice(0, -1)) {
      let child = folder.folders.get(part)
      if (child === undefined) {
        child = { folders: new Map(), refs: [] }
        folder.folders.set(part, child)
      }
      folder = child
    }
    folder.refs.push(ref)
  }
  return root
}

/** Row keys carry their kind so one set of handlers serves every row. */
const enum RowKind {
  Ref = 'ref',
  Folder = 'folder',
  Section = 'section',
  Remote = 'remote',
  Stash = 'stash',
}

function rowKey(kind: RowKind, id: string) {
  return `${kind}:${id}`
}

function parseRowKey(key: string): [RowKind, string] {
  const index = key.indexOf(':')
  return [key.slice(0, index) as RowKind, key.slice(index + 1)]
}

interface IPanelRowProps {
  readonly rowKey: string
  readonly className: string
  /** Indentation level; rows without one use their stylesheet padding */
  readonly depth?: number
  readonly selected?: boolean
  readonly onClick: (key: string, multi: boolean) => void
  readonly onDoubleClick?: (key: string) => void
  readonly onContextMenu?: (key: string, event: React.MouseEvent) => void
  readonly children?: React.ReactNode
}

class PanelRow extends React.PureComponent<IPanelRowProps> {
  private onClick = (event: React.MouseEvent) => {
    this.props.onClick(
      this.props.rowKey,
      __DARWIN__ ? event.metaKey : event.ctrlKey
    )
  }

  private onDoubleClick = () => {
    this.props.onDoubleClick?.(this.props.rowKey)
  }

  private onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    this.props.onContextMenu?.(this.props.rowKey, event)
  }

  private onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.props.onClick(this.props.rowKey, false)
    }
  }

  public render() {
    return (
      <div
        role="treeitem"
        aria-selected={this.props.selected ?? false}
        tabIndex={-1}
        className={this.props.className}
        style={
          this.props.depth === undefined
            ? undefined
            : { paddingLeft: 12 + this.props.depth * 12 }
        }
        onClick={this.onClick}
        onDoubleClick={this.onDoubleClick}
        onContextMenu={this.onContextMenu}
        onKeyDown={this.onKeyDown}
      >
        {this.props.children}
      </div>
    )
  }
}

interface IVisibilityButtonProps {
  readonly refId: string
  readonly hidden: boolean
  readonly onToggle: (refId: string) => void
}

class VisibilityButton extends React.PureComponent<IVisibilityButtonProps> {
  private onClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    this.props.onToggle(this.props.refId)
  }

  public render() {
    return (
      <button
        className="ref-visibility"
        aria-label={this.props.hidden ? 'Show in graph' : 'Hide from graph'}
        onClick={this.onClick}
      >
        <Octicon
          symbol={this.props.hidden ? octicons.eyeClosed : octicons.eye}
        />
      </button>
    )
  }
}

interface ISectionActionProps {
  readonly label: string
  readonly onClick: () => void
}

/** A `+` button on a section header, e.g. Add Remote. */
class SectionAction extends React.PureComponent<ISectionActionProps> {
  private onClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    this.props.onClick()
  }

  public render() {
    return (
      <TooltippedContent
        className="section-action"
        tagName="span"
        tooltip={this.props.label}
      >
        <button aria-label={this.props.label} onClick={this.onClick}>
          <Octicon symbol={octicons.plus} />
        </button>
      </TooltippedContent>
    )
  }
}

function renderTracking(tracking: IBranchTracking | undefined) {
  if (tracking === undefined) {
    return null
  }
  if (tracking.gone) {
    return (
      <span className="ref-tracking gone">
        <Octicon symbol={octicons.alert} />
      </span>
    )
  }
  if (tracking.ahead === 0 && tracking.behind === 0) {
    return null
  }
  const cap = (n: number) => (n > 99 ? '99+' : `${n}`)
  return (
    <span className="ref-tracking">
      {tracking.behind > 0 ? (
        <span>
          {cap(tracking.behind)}
          <Octicon symbol={octicons.arrowDown} />
        </span>
      ) : null}
      {tracking.ahead > 0 ? (
        <span>
          {cap(tracking.ahead)}
          <Octicon symbol={octicons.arrowUp} />
        </span>
      ) : null}
    </span>
  )
}

/**
 * The left panel of the History view: local branches, remotes, tags and
 * stashes, like GitKraken's ref panel.
 */
export class RefPanel extends React.Component<IRefPanelProps, IRefPanelState> {
  private subscription: Disposable | null = null

  public constructor(props: IRefPanelProps) {
    super(props)
    this.state = { filterText: '', selectedIds: new Set(), tick: 0 }
  }

  public componentDidMount() {
    this.subscription = graphViewStore.onDidUpdate(() =>
      this.setState(s => ({ tick: s.tick + 1 }))
    )
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
  }

  private get settings() {
    return graphViewStore.getSettings(this.props.repository.id)
  }

  private get allRefs(): ReadonlyArray<IGraphRef> {
    const bySha = getRefsBySha(
      this.props.branches,
      this.props.tags,
      this.props.currentBranchName
    )
    const refs = [...bySha.values()].flat()
    return refs.sort((a, b) => a.name.localeCompare(b.name))
  }

  private findRef(id: string) {
    return this.allRefs.find(r => r.id === id)
  }

  private refsInSection(section: RefPanelSection) {
    const kind =
      section === RefPanelSection.Local
        ? GraphRefKind.Local
        : section === RefPanelSection.Remote
        ? GraphRefKind.Remote
        : section === RefPanelSection.Tags
        ? GraphRefKind.Tag
        : null
    return this.allRefs.filter(r => r.kind === kind)
  }

  private matchesFilter(name: string) {
    const filter = this.state.filterText.trim().toLowerCase()
    return filter.length === 0 || name.toLowerCase().includes(filter)
  }

  private onFilterChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ filterText: event.currentTarget.value })
  }

  private onShowAll = () => {
    graphViewStore.updateSettings(this.props.repository.id, {
      soloRefs: [],
      hiddenRefs: [],
    })
  }

  private onToggleHidden = (refId: string) => {
    const { id } = this.props.repository
    graphViewStore.setHidden(id, [refId], !graphViewStore.isHidden(id, refId))
  }

  private onRowClick = (key: string, multi: boolean) => {
    const [kind, id] = parseRowKey(key)
    switch (kind) {
      case RowKind.Ref: {
        const ref = this.findRef(id)
        if (ref === undefined) {
          return
        }
        const selectedIds = new Set(multi ? this.state.selectedIds : [])
        if (multi && selectedIds.has(id)) {
          selectedIds.delete(id)
        } else {
          selectedIds.add(id)
        }
        this.setState({ selectedIds })
        this.props.onRefSelected(ref)
        return
      }
      case RowKind.Stash: {
        const stash = this.props.stashes.find(s => s.sha === id)
        if (stash !== undefined) {
          this.setState({ selectedIds: new Set([id]) })
          this.props.onStashSelected(stash)
        }
        return
      }
      case RowKind.Folder:
      case RowKind.Section:
      case RowKind.Remote:
        graphViewStore.toggleSection(this.props.repository.id, id)
        return
    }
  }

  private onRowDoubleClick = (key: string) => {
    const [kind, id] = parseRowKey(key)
    if (kind === RowKind.Ref) {
      const ref = this.findRef(id)
      if (ref !== undefined) {
        this.props.onRefDoubleClick(ref)
      }
    }
  }

  private onRowContextMenu = (key: string, event: React.MouseEvent) => {
    const [kind, id] = parseRowKey(key)
    switch (kind) {
      case RowKind.Ref: {
        const ref = this.findRef(id)
        if (ref === undefined) {
          return
        }
        let { selectedIds } = this.state
        if (!selectedIds.has(id)) {
          selectedIds = new Set([id])
          this.setState({ selectedIds })
        }
        const selected = this.allRefs.filter(r => selectedIds.has(r.id))
        this.props.onRefContextMenu(ref, selected, event)
        return
      }
      case RowKind.Stash: {
        const stash = this.props.stashes.find(s => s.sha === id)
        if (stash !== undefined) {
          this.setState({ selectedIds: new Set([id]) })
          this.props.onStashContextMenu(stash, event)
        }
        return
      }
      case RowKind.Remote: {
        const name = id.slice(RefPanelSection.Remote.length + 1)
        const remote = this.props.remotes.find(r => r.name === name)
        if (remote !== undefined) {
          this.props.onRemoteContextMenu(remote, event)
        }
        return
      }
      case RowKind.Section: {
        const section = id as RefPanelSection
        this.props.onSectionContextMenu(
          section,
          this.refsInSection(section),
          event
        )
        return
      }
    }
  }

  private isCollapsed(path: string) {
    return (
      this.settings.collapsedSections.includes(path) &&
      this.state.filterText.length === 0
    )
  }

  private renderChevron(collapsed: boolean) {
    return (
      <Octicon
        symbol={collapsed ? octicons.chevronRight : octicons.chevronDown}
      />
    )
  }

  private renderRef(ref: IGraphRef, label: string, depth: number) {
    const { hiddenRefs, soloRefs, pinnedRef } = this.settings
    const hidden =
      hiddenRefs.includes(ref.id) ||
      (soloRefs.length > 0 && !soloRefs.includes(ref.id))
    const tracking =
      ref.kind === GraphRefKind.Local
        ? graphViewStore.getTracking(this.props.repository.id).get(ref.name)
        : undefined

    return (
      <PanelRow
        key={ref.id}
        rowKey={rowKey(RowKind.Ref, ref.id)}
        className={classNames('ref-panel-item', {
          selected: this.state.selectedIds.has(ref.id),
          current: ref.isCurrent,
          hidden,
        })}
        depth={depth}
        selected={this.state.selectedIds.has(ref.id)}
        onClick={this.onRowClick}
        onDoubleClick={this.onRowDoubleClick}
        onContextMenu={this.onRowContextMenu}
      >
        {ref.isCurrent ? (
          <Octicon className="ref-current" symbol={octicons.check} />
        ) : (
          <Octicon
            className="ref-icon"
            symbol={
              ref.kind === GraphRefKind.Tag ? octicons.tag : octicons.gitBranch
            }
          />
        )}
        <TooltippedContent
          className="ref-label"
          tagName="span"
          tooltip={ref.name}
        >
          {label}
        </TooltippedContent>
        {pinnedRef === ref.id ? <Octicon symbol={octicons.pin} /> : null}
        {renderTracking(tracking)}
        <VisibilityButton
          refId={ref.id}
          hidden={hidden}
          onToggle={this.onToggleHidden}
        />
      </PanelRow>
    )
  }

  private renderFolder(
    path: string,
    name: string,
    folder: IFolder,
    depth: number
  ): JSX.Element[] {
    const items: JSX.Element[] = []

    if (name.length > 0) {
      const collapsed = this.isCollapsed(path)
      items.push(
        <PanelRow
          key={`folder:${path}`}
          rowKey={rowKey(RowKind.Folder, path)}
          className="ref-panel-folder"
          depth={depth - 1}
          onClick={this.onRowClick}
        >
          {this.renderChevron(collapsed)}
          <Octicon symbol={octicons.fileDirectory} />
          <span className="ref-label">{name}</span>
        </PanelRow>
      )
      if (collapsed) {
        return items
      }
    }

    for (const [childName, child] of [...folder.folders].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      items.push(
        ...this.renderFolder(
          `${path}/${childName}`,
          childName,
          child,
          depth + 1
        )
      )
    }
    for (const ref of folder.refs) {
      const label = ref.name.split('/').pop() ?? ref.name
      items.push(this.renderRef(ref, label, depth))
    }
    return items
  }

  private onAddRemote = () => {
    graphViewStore.openRemoteForm(this.props.repository.id, null)
  }

  private renderSectionHeader(section: RefPanelSection, count: number) {
    return (
      <PanelRow
        rowKey={rowKey(RowKind.Section, section)}
        className="ref-panel-section-header"
        onClick={this.onRowClick}
        onContextMenu={this.onRowContextMenu}
      >
        {this.renderChevron(this.isCollapsed(section))}
        <span className="section-title">{SectionTitles[section]}</span>
        {section === RefPanelSection.Remote ? (
          <SectionAction label="Add remote" onClick={this.onAddRemote} />
        ) : null}
        <span className="section-count">{count}</span>
      </PanelRow>
    )
  }

  private renderLocal(refs: ReadonlyArray<IGraphRef>) {
    const local = refs.filter(
      r => r.kind === GraphRefKind.Local && this.matchesFilter(r.name)
    )
    return (
      <div className="ref-panel-section" role="group">
        {this.renderSectionHeader(RefPanelSection.Local, local.length)}
        {this.isCollapsed(RefPanelSection.Local)
          ? null
          : this.renderFolder(
              RefPanelSection.Local,
              '',
              buildTree(local, 0),
              1
            )}
      </div>
    )
  }

  private renderRemotes(refs: ReadonlyArray<IGraphRef>) {
    const remoteRefs = refs.filter(r => r.kind === GraphRefKind.Remote)
    const { remotes } = this.props
    return (
      <div className="ref-panel-section" role="group">
        {this.renderSectionHeader(RefPanelSection.Remote, remotes.length)}
        {this.isCollapsed(RefPanelSection.Remote)
          ? null
          : remotes.map(remote => {
              const path = `${RefPanelSection.Remote}/${remote.name}`
              const own = remoteRefs.filter(
                r => r.remoteName === remote.name && this.matchesFilter(r.name)
              )
              const collapsed = this.isCollapsed(path)
              return (
                <React.Fragment key={remote.name}>
                  <PanelRow
                    rowKey={rowKey(RowKind.Remote, path)}
                    className="ref-panel-folder remote-folder"
                    depth={0}
                    onClick={this.onRowClick}
                    onContextMenu={this.onRowContextMenu}
                  >
                    {this.renderChevron(collapsed)}
                    <Octicon symbol={octicons.cloud} />
                    <TooltippedContent
                      className="ref-label"
                      tagName="span"
                      tooltip={remote.url}
                    >
                      {remote.name}
                    </TooltippedContent>
                    <span className="section-count">{own.length}</span>
                  </PanelRow>
                  {collapsed
                    ? null
                    : this.renderFolder(
                        path,
                        '',
                        buildTree(own, remote.name.length + 1),
                        2
                      )}
                </React.Fragment>
              )
            })}
      </div>
    )
  }

  private renderTags(refs: ReadonlyArray<IGraphRef>) {
    const tags = refs.filter(
      r => r.kind === GraphRefKind.Tag && this.matchesFilter(r.name)
    )
    return (
      <div className="ref-panel-section" role="group">
        {this.renderSectionHeader(RefPanelSection.Tags, tags.length)}
        {this.isCollapsed(RefPanelSection.Tags)
          ? null
          : tags.map(t => this.renderRef(t, t.name, 1))}
      </div>
    )
  }

  private renderStashes() {
    const stashes = this.props.stashes.filter(s =>
      this.matchesFilter(s.message)
    )
    return (
      <div className="ref-panel-section" role="group">
        {this.renderSectionHeader(RefPanelSection.Stashes, stashes.length)}
        {this.isCollapsed(RefPanelSection.Stashes)
          ? null
          : stashes.map(stash => (
              <PanelRow
                key={stash.sha}
                rowKey={rowKey(RowKind.Stash, stash.sha)}
                className={classNames('ref-panel-item', {
                  selected: this.state.selectedIds.has(stash.sha),
                })}
                depth={1}
                selected={this.state.selectedIds.has(stash.sha)}
                onClick={this.onRowClick}
                onContextMenu={this.onRowContextMenu}
              >
                <Octicon className="ref-icon" symbol={octicons.archive} />
                <TooltippedContent
                  className="ref-label"
                  tagName="span"
                  tooltip={`${stash.name}: ${stash.message}`}
                >
                  {stash.message}
                </TooltippedContent>
              </PanelRow>
            ))}
      </div>
    )
  }

  public render() {
    const refs = this.allRefs
    const { soloRefs, hiddenRefs } = this.settings
    const filtered = soloRefs.length + hiddenRefs.length > 0
    return (
      <div
        className="ref-panel gk-theme"
        role="tabpanel"
        aria-labelledby="history-tab"
      >
        <div className="ref-panel-filter">
          <Octicon symbol={octicons.filter} />
          <input
            type="search"
            placeholder="Filter"
            aria-label="Filter branches, tags and stashes"
            value={this.state.filterText}
            onChange={this.onFilterChanged}
          />
        </div>
        {filtered ? (
          <div className="ref-panel-viewing">
            {soloRefs.length > 0
              ? `Soloing ${soloRefs.length}`
              : `Hiding ${hiddenRefs.length}`}
            <button onClick={this.onShowAll}>Show all</button>
          </div>
        ) : null}
        <div className="ref-panel-sections" role="tree">
          {this.renderLocal(refs)}
          {this.renderRemotes(refs)}
          {this.renderTags(refs)}
          {this.renderStashes()}
        </div>
      </div>
    )
  }
}
