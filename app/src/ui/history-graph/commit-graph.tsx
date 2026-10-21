import * as React from 'react'
import classNames from 'classnames'
import { Disposable } from 'event-kit'
import { Commit } from '../../models/commit'
import { GitHubRepository } from '../../models/github-repository'
import { Account } from '../../models/account'
import { IGraphStash } from '../../models/stash-entry'
import { Emoji } from '../../lib/emoji'
import { formatDate } from '../../lib/format-date'
import { getAvatarUsersForCommit } from '../../models/avatar'
import { showContextualMenu } from '../../lib/menu-item'
import { GraphCommitOrder, IBranchTracking } from '../../lib/git/graph'
import { List } from '../lib/list'
import { TooltippedContent } from '../lib/tooltipped-content'
import { TooltipDirection } from '../lib/tooltip'
import { Avatar } from '../lib/avatar'
import { RichText } from '../lib/rich-text'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import {
  colorIndex,
  GraphRefKind,
  GraphRowType,
  IGraph,
  IGraphRef,
  IGraphRefGroup,
  IGraphRow,
  WorkDirSha,
} from './graph-model'
import {
  CompactMetrics,
  GraphCell,
  graphNaturalWidth,
  GraphRowHeight,
  RichMetrics,
} from './graph-cell'
import {
  DefaultGraphColumns,
  graphViewStore,
  IGraphColumns,
} from './graph-view-store'

/** The commit message column never gets narrower than this when auto-sizing. */
const MinMessageWidth = 150

/** Load the next batch once the viewport is this many rows from the end. */
const LoadMoreThreshold = 30

const MinZoneWidths = {
  refWidth: 32,
  graphWidth: 56,
  authorWidth: 32,
  dateWidth: 50,
  shaWidth: 50,
}

type ResizableZone = keyof typeof MinZoneWidths

interface ICommitGraphProps {
  readonly graph: IGraph
  readonly commitLookup: Map<string, Commit>
  readonly stashes: ReadonlyMap<string, IGraphStash>
  readonly selectedShas: ReadonlyArray<string>
  readonly emoji: Map<string, Emoji>
  readonly accounts: ReadonlyArray<Account>
  readonly gitHubRepository: GitHubRepository | null
  readonly workDirChangeCount: number
  /** Ahead/behind counts of local branches, keyed by branch name */
  readonly tracking: ReadonlyMap<string, IBranchTracking>
  readonly commitOrder: GraphCommitOrder
  readonly onCommitOrderChanged: (order: GraphCommitOrder) => void
  readonly canPopStash: boolean
  readonly onStash: () => void
  readonly onPopStash: () => void
  readonly isTerminalVisible: boolean
  readonly onToggleTerminal: () => void
  /** The number of commits loaded, used to page in more history */
  readonly loadedCount: number
  readonly searchText: string
  readonly onSearchTextChanged: (text: string) => void
  readonly onSelectionChanged: (
    shas: ReadonlyArray<string>,
    isContiguous: boolean
  ) => void
  readonly onWorkDirSelected: () => void
  readonly onLoadMore: () => void
  readonly onRowContextMenu: (
    row: IGraphRow,
    event: React.MouseEvent<HTMLDivElement>
  ) => void
  readonly onRefContextMenu: (
    row: IGraphRow,
    group: IGraphRefGroup,
    event: React.MouseEvent<HTMLDivElement>
  ) => void
  readonly onRefDoubleClick: (row: IGraphRow, group: IGraphRefGroup) => void
}

interface ICommitGraphState {
  readonly columns: IGraphColumns
  readonly scrollToRow?: number
  readonly showSearch: boolean
  /** Measured width of the graph, 0 until first laid out */
  readonly width: number
}

function refIcon(ref: IGraphRef) {
  switch (ref.kind) {
    case GraphRefKind.Local:
      return octicons.deviceDesktop
    case GraphRefKind.Remote:
      return octicons.cloud
    case GraphRefKind.Tag:
      return octicons.tag
  }
}

interface IZoneResizeHandleProps {
  readonly zone: ResizableZone
  readonly onResizeStart: (zone: ResizableZone, event: React.MouseEvent) => void
  readonly onResizeReset: (zone: ResizableZone) => void
}

class ZoneResizeHandle extends React.PureComponent<IZoneResizeHandleProps> {
  private onMouseDown = (event: React.MouseEvent) => {
    this.props.onResizeStart(this.props.zone, event)
  }

  private onDoubleClick = () => {
    this.props.onResizeReset(this.props.zone)
  }

  public render() {
    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div
        className="zone-resize-handle"
        onMouseDown={this.onMouseDown}
        onDoubleClick={this.onDoubleClick}
      />
    )
  }
}

interface IRefPillProps {
  readonly row: IGraphRow
  readonly group: IGraphRefGroup
  readonly onDoubleClick: (row: IGraphRow, group: IGraphRefGroup) => void
  readonly onContextMenu: (
    row: IGraphRow,
    group: IGraphRefGroup,
    event: React.MouseEvent<HTMLDivElement>
  ) => void
  readonly children?: React.ReactNode
}

/** A branch/tag label in the graph's ref zone. */
class RefPill extends React.PureComponent<IRefPillProps> {
  private onDoubleClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    this.props.onDoubleClick(this.props.row, this.props.group)
  }

  private onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    this.props.onContextMenu(this.props.row, this.props.group, event)
  }

  public render() {
    const { group } = this.props
    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div
        className={classNames('ref-pill', {
          current: group.hasCurrent,
          pinned: group.isPinned,
        })}
        onDoubleClick={this.onDoubleClick}
        onContextMenu={this.onContextMenu}
      >
        {this.props.children}
      </div>
    )
  }
}

/** Collapse runs of newlines in a commit body into " | ", as GitKraken does. */
function flattenBody(body: string) {
  return body
    .trim()
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join(' | ')
}

/**
 * The center commit graph: every branch, remote branch, tag and stash, drawn
 * as lanes with ref pills on the left.
 */
export class CommitGraph extends React.Component<
  ICommitGraphProps,
  ICommitGraphState
> {
  private subscription: Disposable | null = null
  private lastScrollNonce = 0
  private lastLoadRequestCount = -1
  private searchInput: HTMLInputElement | null = null
  private resize: {
    zone: ResizableZone
    startX: number
    startWidth: number
  } | null = null

  private rootElement: HTMLDivElement | null = null
  private readonly resizeObserver = new ResizeObserver(entries => {
    const width = Math.round(entries[0]?.contentRect.width ?? 0)
    if (width !== this.state.width) {
      this.setState({ width })
    }
  })

  public constructor(props: ICommitGraphProps) {
    super(props)
    this.state = {
      columns: graphViewStore.columns,
      showSearch: props.searchText.length > 0,
      width: 0,
    }
  }

  public componentDidMount() {
    this.subscription = graphViewStore.onDidUpdate(this.onStoreUpdated)
    window.addEventListener('keydown', this.onWindowKeyDown)
    this.onStoreUpdated()
    if (this.rootElement !== null) {
      this.resizeObserver.observe(this.rootElement)
    }
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
    window.removeEventListener('keydown', this.onWindowKeyDown)
    this.stopResize()
    this.resizeObserver.disconnect()
  }

  public componentDidUpdate(prevProps: ICommitGraphProps) {
    if (prevProps.graph !== this.props.graph) {
      this.onStoreUpdated()
    }
  }

  private onStoreUpdated = () => {
    const pending = graphViewStore.pendingScroll
    let columns = this.state.columns
    let scrollToRow = this.state.scrollToRow
    if (pending !== null && pending.nonce !== this.lastScrollNonce) {
      const index = this.props.graph.rowIndexBySha.get(pending.sha)
      if (index !== undefined) {
        this.lastScrollNonce = pending.nonce
        scrollToRow = index
      }
    }
    if (graphViewStore.columns !== columns) {
      columns = graphViewStore.columns
    }
    if (
      columns !== this.state.columns ||
      scrollToRow !== this.state.scrollToRow
    ) {
      this.setState({ columns, scrollToRow })
    }
  }

  private onWindowKeyDown = (event: KeyboardEvent) => {
    const mod = __DARWIN__ ? event.metaKey : event.ctrlKey
    if (mod && !event.shiftKey && !event.altKey && event.key === 'f') {
      event.preventDefault()
      this.openSearch()
    }
  }

  private get metrics() {
    return this.state.columns.compact ? CompactMetrics : RichMetrics
  }

  private get graphWidth() {
    const { graphWidth } = this.state.columns
    if (graphWidth > 0) {
      return graphWidth
    }
    const natural = graphNaturalWidth(
      this.props.graph.columnCount,
      this.metrics
    )
    const { columns, width } = this.state
    const others =
      columns.refWidth +
      (columns.showAuthor ? columns.authorWidth : 0) +
      (columns.showDate ? columns.dateWidth : 0) +
      (columns.showSha ? columns.shaWidth : 0)
    const available =
      width > 0 ? width - others - MinMessageWidth : Number.POSITIVE_INFINITY
    return Math.max(MinZoneWidths.graphWidth, Math.min(natural, 400, available))
  }

  private zoneWidth(zone: ResizableZone) {
    return zone === 'graphWidth' ? this.graphWidth : this.state.columns[zone]
  }

  private onResizeStart = (zone: ResizableZone, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    this.resize = {
      zone,
      startX: event.clientX,
      startWidth: this.zoneWidth(zone),
    }
    document.addEventListener('mousemove', this.onResizeMove)
    document.addEventListener('mouseup', this.stopResize)
  }

  private onResizeMove = (event: MouseEvent) => {
    if (this.resize === null) {
      return
    }
    const { zone, startX, startWidth } = this.resize
    // Author, date and sha zones sit right of their handle.
    const sign = zone === 'refWidth' || zone === 'graphWidth' ? 1 : -1
    const width = Math.max(
      MinZoneWidths[zone],
      startWidth + sign * (event.clientX - startX)
    )
    graphViewStore.updateColumns({ [zone]: Math.round(width) })
  }

  private stopResize = () => {
    this.resize = null
    document.removeEventListener('mousemove', this.onResizeMove)
    document.removeEventListener('mouseup', this.stopResize)
  }

  private onResizeReset = (zone: ResizableZone) => {
    graphViewStore.updateColumns({ [zone]: DefaultGraphColumns[zone] })
  }

  private renderHandle(zone: ResizableZone) {
    return (
      <ZoneResizeHandle
        zone={zone}
        onResizeStart={this.onResizeStart}
        onResizeReset={this.onResizeReset}
      />
    )
  }

  private onSettingsClick = () => {
    const { columns } = this.state
    showContextualMenu([
      {
        label: 'Author',
        type: 'checkbox',
        checked: columns.showAuthor,
        action: () =>
          graphViewStore.updateColumns({ showAuthor: !columns.showAuthor }),
      },
      {
        label: 'Date / Time',
        type: 'checkbox',
        checked: columns.showDate,
        action: () =>
          graphViewStore.updateColumns({ showDate: !columns.showDate }),
      },
      {
        label: 'SHA',
        type: 'checkbox',
        checked: columns.showSha,
        action: () =>
          graphViewStore.updateColumns({ showSha: !columns.showSha }),
      },
      { type: 'separator' },
      {
        label: 'Sort by Date (--date-order)',
        type: 'checkbox',
        checked: this.props.commitOrder === GraphCommitOrder.Date,
        action: () => this.props.onCommitOrderChanged(GraphCommitOrder.Date),
      },
      {
        label: 'Sort by Topology (--topo-order)',
        type: 'checkbox',
        checked: this.props.commitOrder === GraphCommitOrder.Topo,
        action: () => this.props.onCommitOrderChanged(GraphCommitOrder.Topo),
      },
      { type: 'separator' },
      {
        label: 'Compact Graph',
        type: 'checkbox',
        checked: columns.compact,
        action: () =>
          graphViewStore.updateColumns({ compact: !columns.compact }),
      },
      { type: 'separator' },
      {
        label: 'Reset Columns',
        action: () => graphViewStore.resetColumns(),
      },
    ])
  }

  private onToggleCommitOrder = () => {
    this.props.onCommitOrderChanged(
      this.props.commitOrder === GraphCommitOrder.Date
        ? GraphCommitOrder.Topo
        : GraphCommitOrder.Date
    )
  }

  private renderCommitOrderButton() {
    const isTopo = this.props.commitOrder === GraphCommitOrder.Topo
    return (
      <TooltippedContent
        className="graph-order-toggle"
        tagName="span"
        tooltip={
          isTopo
            ? 'Sorted by topology (--topo-order). Click to sort by date.'
            : 'Sorted by date (--date-order). Click to sort by topology.'
        }
      >
        <button
          onClick={this.onToggleCommitOrder}
          aria-label={
            isTopo ? 'Sort commits by date' : 'Sort commits by topology'
          }
        >
          <Octicon symbol={isTopo ? octicons.gitBranch : octicons.clock} />
          {isTopo ? 'Topo' : 'Date'}
        </button>
      </TooltippedContent>
    )
  }

  private renderHeader() {
    const { columns } = this.state
    return (
      <div className="graph-header">
        <div className="zone ref-zone" style={{ width: columns.refWidth }}>
          BRANCH / TAG
          {this.renderHandle('refWidth')}
        </div>
        <div className="zone graph-zone" style={{ width: this.graphWidth }}>
          GRAPH
          {this.renderHandle('graphWidth')}
        </div>
        <div className="zone message-zone">COMMIT MESSAGE</div>
        {columns.showAuthor ? (
          <div
            className="zone author-zone"
            style={{ width: columns.authorWidth }}
          >
            {this.renderHandle('authorWidth')}
            AUTHOR
          </div>
        ) : null}
        {columns.showDate ? (
          <div className="zone date-zone" style={{ width: columns.dateWidth }}>
            {this.renderHandle('dateWidth')}
            DATE / TIME
          </div>
        ) : null}
        {columns.showSha ? (
          <div className="zone sha-zone" style={{ width: columns.shaWidth }}>
            {this.renderHandle('shaWidth')}
            SHA
          </div>
        ) : null}
        <button
          className="graph-settings-button"
          onClick={this.onSettingsClick}
          aria-label="Graph column settings"
        >
          <Octicon symbol={octicons.gear} />
        </button>
      </div>
    )
  }

  private renderTracking(group: IGraphRefGroup) {
    const local = group.refs.find(r => r.kind === GraphRefKind.Local)
    const tracking =
      local === undefined ? undefined : this.props.tracking.get(local.name)
    if (tracking === undefined) {
      return null
    }
    if (tracking.gone) {
      return (
        <TooltippedContent
          className="ref-tracking gone"
          tagName="span"
          tooltip="Upstream branch is gone"
        >
          <Octicon symbol={octicons.alert} />
        </TooltippedContent>
      )
    }
    if (tracking.ahead === 0 && tracking.behind === 0) {
      return null
    }
    return (
      <TooltippedContent
        className="ref-tracking"
        tagName="span"
        tooltip={`${tracking.ahead} ahead, ${tracking.behind} behind upstream`}
      >
        {tracking.behind > 0 ? (
          <span>
            {tracking.behind}
            <Octicon symbol={octicons.arrowDown} />
          </span>
        ) : null}
        {tracking.ahead > 0 ? (
          <span>
            {tracking.ahead}
            <Octicon symbol={octicons.arrowUp} />
          </span>
        ) : null}
      </TooltippedContent>
    )
  }

  private renderPill(row: IGraphRow, group: IGraphRefGroup) {
    const kinds = new Set(group.refs.map(r => r.kind))
    const title = group.refs.map(r => r.name).join('\n')
    return (
      <RefPill
        key={group.key}
        row={row}
        group={group}
        onDoubleClick={this.props.onRefDoubleClick}
        onContextMenu={this.props.onRefContextMenu}
      >
        {group.hasCurrent ? (
          <Octicon className="ref-current" symbol={octicons.check} />
        ) : null}
        <TooltippedContent className="ref-name" tagName="span" tooltip={title}>
          {group.name}
        </TooltippedContent>
        {this.renderTracking(group)}
        {group.isPinned ? <Octicon symbol={octicons.pin} /> : null}
        {[GraphRefKind.Local, GraphRefKind.Remote, GraphRefKind.Tag]
          .filter(k => kinds.has(k))
          .map(k => (
            <Octicon
              key={k}
              className="ref-kind"
              symbol={refIcon(group.refs.find(r => r.kind === k)!)}
            />
          ))}
      </RefPill>
    )
  }

  private renderRefZone(row: IGraphRow) {
    const { refGroups } = row
    const { refWidth } = this.state.columns
    if (row.type === GraphRowType.Stash) {
      const stash = this.props.stashes.get(row.sha)
      return (
        <div className="zone ref-zone" style={{ width: refWidth }}>
          <div className="ref-pill stash-pill">
            <Octicon className="ref-kind" symbol={octicons.archive} />
            <TooltippedContent
              className="ref-name"
              tagName="span"
              tooltip={stash?.message}
            >
              {stash?.name ?? 'stash'}
            </TooltippedContent>
          </div>
          <div className="ref-line" />
        </div>
      )
    }

    if (refGroups.length === 0) {
      return <div className="zone ref-zone" style={{ width: refWidth }} />
    }

    return (
      <div
        className={classNames('zone ref-zone', {
          'has-more': refGroups.length > 1,
        })}
        style={{ width: refWidth }}
      >
        {this.renderPill(row, refGroups[0])}
        {refGroups.length > 1 ? (
          <span className="ref-more">+{refGroups.length - 1}</span>
        ) : null}
        <div className="ref-line" />
        {refGroups.length > 1 ? (
          <div className="ref-all">
            {refGroups.map(g => this.renderPill(row, g))}
          </div>
        ) : null}
      </div>
    )
  }

  /** Every branch and tag at a commit, shown when hovering its row. */
  private renderRefsTooltip(row: IGraphRow, commit: Commit) {
    const refs = row.refGroups.flatMap(g => g.refs)
    if (refs.length === 0) {
      return undefined
    }
    const branches = refs.filter(r => r.kind !== GraphRefKind.Tag)
    const tags = refs.filter(r => r.kind === GraphRefKind.Tag)
    const renderRef = (ref: IGraphRef) => (
      <li key={ref.id} className={classNames({ current: ref.isCurrent })}>
        <Octicon symbol={ref.isCurrent ? octicons.check : refIcon(ref)} />
        <span className="ref-tooltip-name">{ref.name}</span>
      </li>
    )
    return (
      <div className="commit-refs-tooltip">
        <div className="ref-tooltip-commit">
          <span className="ref-tooltip-sha">{commit.sha.slice(0, 7)}</span>
          {commit.summary}
        </div>
        {branches.length > 0 ? (
          <>
            <div className="ref-tooltip-heading">
              {branches.length === 1 ? 'Branch' : 'Branches'}
            </div>
            <ul>{branches.map(renderRef)}</ul>
          </>
        ) : null}
        {tags.length > 0 ? (
          <>
            <div className="ref-tooltip-heading">
              {tags.length === 1 ? 'Tag' : 'Tags'}
            </div>
            <ul>{tags.map(renderRef)}</ul>
          </>
        ) : null}
      </div>
    )
  }

  private renderAvatar(commit: Commit) {
    const users = getAvatarUsersForCommit(this.props.gitHubRepository, commit)
    if (users.length === 0) {
      return null
    }
    return (
      <Avatar
        user={users[0]}
        title={null}
        size={18}
        accounts={this.props.accounts}
      />
    )
  }

  private renderWorkDirRow(row: IGraphRow, isSelected: boolean) {
    const { columns } = this.state
    const count = this.props.workDirChangeCount
    return (
      <div
        className={classNames(
          'graph-row wip-row',
          `lane-${colorIndex(row.colorColumn)}`
        )}
      >
        <div className="zone ref-zone" style={{ width: columns.refWidth }} />
        <div className="zone graph-zone" style={{ width: this.graphWidth }}>
          <GraphCell
            row={row}
            width={this.graphWidth}
            metrics={this.metrics}
            hasRefs={false}
            isSelected={isSelected}
            avatar={null}
            nodeTitle="Work in progress"
          />
        </div>
        <div className="zone message-zone">
          <span className="wip-label">// WIP</span>
          <span className="wip-stats">
            <Octicon symbol={octicons.pencil} /> {count}
          </span>
        </div>
      </div>
    )
  }

  private renderRow = (index: number) => {
    const row = this.props.graph.rows[index]
    if (row === undefined) {
      return null
    }
    const isSelected = this.props.selectedShas.includes(row.sha)

    if (row.type === GraphRowType.WorkDir) {
      return this.renderWorkDirRow(row, isSelected)
    }

    const commit = this.props.commitLookup.get(row.sha)
    if (commit === undefined) {
      return null
    }

    const { columns } = this.state
    const body = flattenBody(commit.body)
    const stash = this.props.stashes.get(row.sha)
    const summary = stash?.message ?? commit.summary
    const hasRefs = row.refGroups.length > 0 || row.type === GraphRowType.Stash
    const refsTooltip = this.renderRefsTooltip(row, commit)
    const date = formatDate(commit.author.date, {
      dateStyle: 'short',
      timeStyle: 'short',
    })

    return (
      <div
        className={classNames(
          'graph-row',
          `lane-${colorIndex(row.colorColumn)}`,
          {
            'stash-row': row.type === GraphRowType.Stash,
            'merge-row': row.type === GraphRowType.Merge,
            'head-row': row.isHead,
          }
        )}
      >
        {this.renderRefZone(row)}
        <div className="zone graph-zone" style={{ width: this.graphWidth }}>
          <TooltippedContent
            tagName="div"
            className="graph-zone-hover"
            tooltip={refsTooltip}
            tooltipClassName="commit-refs-tooltip-container"
            direction={TooltipDirection.EAST}
          >
            <GraphCell
              row={row}
              width={this.graphWidth}
              metrics={this.metrics}
              hasRefs={hasRefs}
              isSelected={isSelected}
              avatar={this.renderAvatar(commit)}
              nodeTitle={`${commit.author.name} <${commit.author.email}>`}
            />
          </TooltippedContent>
        </div>
        <TooltippedContent
          tagName="div"
          className="zone message-zone"
          tooltip={refsTooltip}
          tooltipClassName="commit-refs-tooltip-container"
          direction={TooltipDirection.SOUTH}
        >
          <RichText
            className="message-summary"
            emoji={this.props.emoji}
            text={summary}
            renderUrlsAsLinks={false}
          />
          {body.length > 0 ? (
            <span className="message-body">{body}</span>
          ) : null}
        </TooltippedContent>
        {columns.showAuthor ? (
          <div
            className="zone author-zone"
            style={{ width: columns.authorWidth }}
          >
            {commit.author.name}
          </div>
        ) : null}
        {columns.showDate ? (
          <div className="zone date-zone" style={{ width: columns.dateWidth }}>
            {date}
          </div>
        ) : null}
        {columns.showSha ? (
          <div className="zone sha-zone" style={{ width: columns.shaWidth }}>
            {commit.sha.slice(0, 6)}
          </div>
        ) : null}
      </div>
    )
  }

  private get selectedRows() {
    const { rowIndexBySha } = this.props.graph
    const rows: number[] = []
    for (const sha of this.props.selectedShas) {
      const index = rowIndexBySha.get(sha)
      if (index !== undefined) {
        rows.push(index)
      }
    }
    return rows
  }

  /** Whether the selected commits form one first-parent chain. */
  private isContiguous(shas: ReadonlyArray<string>) {
    for (let i = 0; i < shas.length - 1; i++) {
      const commit = this.props.commitLookup.get(shas[i])
      if (commit === undefined || commit.parentSHAs[0] !== shas[i + 1]) {
        return false
      }
    }
    return true
  }

  private onSelectionChanged = (rows: ReadonlyArray<number>) => {
    const { graph } = this.props
    const sorted = rows.toSorted((a, b) => a - b)
    const selected = sorted.map(r => graph.rows[r]).filter(r => r !== undefined)

    if (selected.length === 1 && selected[0].sha === WorkDirSha) {
      this.props.onWorkDirSelected()
      return
    }

    const shas = selected.filter(r => r.sha !== WorkDirSha).map(r => r.sha)
    if (shas.length > 0) {
      this.props.onSelectionChanged(shas, this.isContiguous(shas))
    }
  }

  private onSelectedRowChanged = (row: number) => {
    this.onSelectionChanged([row])
  }

  private onRowContextMenu = (
    index: number,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    const row = this.props.graph.rows[index]
    if (row !== undefined) {
      this.props.onRowContextMenu(row, event)
    }
  }

  private onScroll = (scrollTop: number, clientHeight: number) => {
    const lastVisible = Math.ceil((scrollTop + clientHeight) / GraphRowHeight)
    const { loadedCount, graph } = this.props
    if (
      graph.rows.length - lastVisible <= LoadMoreThreshold &&
      this.lastLoadRequestCount !== loadedCount
    ) {
      this.lastLoadRequestCount = loadedCount
      this.props.onLoadMore()
    }
  }

  private onSearchChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.props.onSearchTextChanged(event.currentTarget.value)
  }

  private onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      this.closeSearch()
    }
  }

  private closeSearch = () => {
    this.props.onSearchTextChanged('')
    this.setState({ showSearch: false })
  }

  private onRootRef = (element: HTMLDivElement | null) => {
    this.rootElement = element
  }

  private onSearchRef = (input: HTMLInputElement | null) => {
    this.searchInput = input
  }

  private openSearch = () => {
    this.setState({ showSearch: true }, () => {
      this.searchInput?.focus()
      this.searchInput?.select()
    })
  }

  private renderToolbarActions() {
    return (
      <div className="graph-header-actions">
        <TooltippedContent tagName="span" tooltip="Stash all changes">
          <button
            type="button"
            disabled={this.props.workDirChangeCount === 0}
            onClick={this.props.onStash}
            aria-label="Stash all changes"
          >
            <Octicon symbol={octicons.archive} />
          </button>
        </TooltippedContent>
        <TooltippedContent
          tagName="span"
          tooltip="Pop the latest stash (its changes come back unstaged)"
        >
          <button
            type="button"
            disabled={!this.props.canPopStash}
            onClick={this.props.onPopStash}
            aria-label="Pop the latest stash"
          >
            <Octicon symbol={octicons.unfold} />
          </button>
        </TooltippedContent>
        <TooltippedContent
          tagName="span"
          tooltip={`${
            this.props.isTerminalVisible ? 'Hide' : 'Show'
          } terminal (Ctrl+\`)`}
        >
          <button
            type="button"
            className={this.props.isTerminalVisible ? 'active' : undefined}
            onClick={this.props.onToggleTerminal}
            aria-label="Toggle terminal"
            aria-pressed={this.props.isTerminalVisible}
          >
            <Octicon symbol={octicons.terminal} />
          </button>
        </TooltippedContent>
        {this.renderCommitOrderButton()}
      </div>
    )
  }

  private renderSearch() {
    if (!this.state.showSearch && this.props.searchText.length === 0) {
      return (
        <div className="graph-toolbar">
          <button
            type="button"
            className="graph-search-button"
            onClick={this.openSearch}
          >
            <Octicon symbol={octicons.search} />
            Search commits
            <kbd>{__DARWIN__ ? '\u2318F' : 'Ctrl+F'}</kbd>
          </button>
          {this.renderToolbarActions()}
        </div>
      )
    }
    const count = this.props.graph.rows.length
    return (
      <div className="graph-toolbar graph-search">
        <Octicon symbol={octicons.search} />
        <input
          ref={this.onSearchRef}
          type="search"
          placeholder="Search commits (message, author, sha)"
          value={this.props.searchText}
          onChange={this.onSearchChanged}
          onKeyDown={this.onSearchKeyDown}
          autoFocus={true}
        />
        {this.props.searchText.length > 0 ? (
          <span className="graph-search-count">{count} matches</span>
        ) : null}
        <button onClick={this.closeSearch} aria-label="Close search">
          <Octicon symbol={octicons.x} />
        </button>
        {this.renderToolbarActions()}
      </div>
    )
  }

  public render() {
    const { graph } = this.props
    return (
      <div
        ref={this.onRootRef}
        className={classNames('commit-graph', {
          compact: this.state.columns.compact,
        })}
      >
        {this.renderSearch()}
        {this.renderHeader()}
        <div className="graph-rows">
          {graph.rows.length === 0 ? (
            <div className="graph-empty">No commits</div>
          ) : (
            <List
              ariaLabel="Commit graph"
              rowCount={graph.rows.length}
              rowHeight={GraphRowHeight}
              rowRenderer={this.renderRow}
              selectedRows={this.selectedRows}
              selectionMode="multi"
              onSelectionChanged={this.onSelectionChanged}
              onSelectedRowChanged={this.onSelectedRowChanged}
              onRowContextMenu={this.onRowContextMenu}
              onScroll={this.onScroll}
              scrollToRow={this.state.scrollToRow}
              invalidationProps={{
                graph,
                columns: this.state.columns,
                width: this.state.width,
                selected: this.props.selectedShas,
                commitLookup: this.props.commitLookup,
                workDir: this.props.workDirChangeCount,
                tracking: this.props.tracking,
              }}
            />
          )}
        </div>
      </div>
    )
  }
}
