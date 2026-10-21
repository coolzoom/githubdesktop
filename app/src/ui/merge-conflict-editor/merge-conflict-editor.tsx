import * as React from 'react'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import { Repository } from '../../models/repository'
import { Dispatcher } from '../dispatcher'
import { ConflictMerge, MergeSide } from '../../lib/conflict-merge'
import {
  getConflictSideShas,
  loadConflictMerge,
  saveConflictResolution,
} from '../../lib/git/merge-tool'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TooltippedContent } from '../lib/tooltipped-content'

/** Matches `.merge-line` height in the stylesheet. */
const LineHeight = 20

export enum MergePane {
  A = 'a',
  B = 'b',
  Output = 'output',
}

interface IPaneLine {
  readonly number: number
  readonly text: string
  /** The conflict this line belongs to, or -1 */
  readonly conflict: number
  /** The side the line comes from; null for clean and ancestor lines */
  readonly side: MergeSide | null
  /** The line's index within its side of the conflict */
  readonly line: number
  readonly picked: boolean
  /** Whether this line carries the conflict's "take this side" checkbox */
  readonly hunkBox: boolean
  readonly hunkTaken: boolean
  /** "A" or "B" in the output gutter, once per run of picked lines */
  readonly label: string | null
  readonly placeholder: boolean
}

interface IPaneModel {
  readonly lines: ReadonlyArray<IPaneLine>
  /** The first line of every hunk, for scroll syncing and navigation */
  readonly hunkStarts: ReadonlyArray<number>
}

function buildPane(merge: ConflictMerge, pane: MergePane): IPaneModel {
  const lines: IPaneLine[] = []
  const hunkStarts: number[] = []
  const push = (line: Omit<IPaneLine, 'number'>) =>
    lines.push({ ...line, number: lines.length + 1 })
  const plain = {
    conflict: -1,
    side: null,
    line: -1,
    picked: false,
    hunkBox: false,
    hunkTaken: false,
    label: null,
    placeholder: false,
  }

  for (const hunk of merge.hunks) {
    hunkStarts.push(lines.length)
    if (pane !== MergePane.Output) {
      const side = pane === MergePane.A ? MergeSide.A : MergeSide.B
      const sideLines = hunk.lines(side)
      if (!hunk.isConflict) {
        sideLines.forEach(text => push({ ...plain, text }))
        continue
      }
      const middle = Math.floor((sideLines.length - 1) / 2)
      sideLines.forEach((text, i) =>
        push({
          text,
          conflict: hunk.conflictIndex,
          side,
          line: i,
          picked: hunk.isPicked(side, i),
          hunkBox: i === middle,
          hunkTaken: hunk.isSideTaken(side),
          label: null,
          placeholder: hunk.isPlaceholder(side),
        })
      )
      continue
    }

    if (!hunk.isConflict) {
      hunk.ok.forEach(text => push({ ...plain, text }))
      continue
    }
    if (hunk.showsBase) {
      const base = hunk.base.length > 0 ? hunk.base : ['']
      base.forEach(text =>
        push({
          ...plain,
          text,
          conflict: hunk.conflictIndex,
          placeholder: hunk.base.length === 0,
        })
      )
      continue
    }
    const { picks } = hunk
    picks.forEach((pick, i) => {
      let runStart = i
      while (runStart > 0 && picks[runStart - 1].side === pick.side) {
        runStart--
      }
      let runEnd = i
      while (
        runEnd < picks.length - 1 &&
        picks[runEnd + 1].side === pick.side
      ) {
        runEnd++
      }
      const isLabel = i === runStart + Math.floor((runEnd - runStart) / 2)
      push({
        text: hunk.lines(pick.side)[pick.line],
        conflict: hunk.conflictIndex,
        side: pick.side,
        line: pick.line,
        picked: true,
        hunkBox: false,
        hunkTaken: false,
        label: isLabel ? (pick.side === MergeSide.A ? 'A' : 'B') : null,
        placeholder: hunk.isPlaceholder(pick.side),
      })
    })
  }
  return { lines, hunkStarts }
}

interface IMergeLineProps {
  readonly pane: MergePane
  readonly index: number
  readonly line: IPaneLine
  readonly isCurrent: boolean
  readonly onToggleLine: (pane: MergePane, index: number) => void
  readonly onToggleHunk: (pane: MergePane, index: number) => void
}

class MergeLine extends React.PureComponent<IMergeLineProps> {
  private onToggleLine = () => {
    this.props.onToggleLine(this.props.pane, this.props.index)
  }

  private onToggleHunk = () => {
    this.props.onToggleHunk(this.props.pane, this.props.index)
  }

  private renderText() {
    const { line } = this.props
    return (
      <span className="merge-line-text">
        {line.placeholder ? '' : line.text.length === 0 ? ' ' : line.text}
      </span>
    )
  }

  public render() {
    const { line, pane, isCurrent } = this.props
    const inConflict = line.conflict >= 0
    const className = classNames('merge-line', {
      'conflict-a': inConflict && line.side === MergeSide.A,
      'conflict-b': inConflict && line.side === MergeSide.B,
      ancestor: inConflict && line.side === null,
      picked: line.picked,
      placeholder: line.placeholder,
      current: isCurrent && inConflict,
    })

    const hunkBox =
      line.hunkBox && line.side !== null ? (
        <input
          type="checkbox"
          checked={line.hunkTaken}
          onChange={this.onToggleHunk}
          aria-label={`Take all lines from ${line.side.toUpperCase()} in conflict ${
            line.conflict + 1
          }`}
        />
      ) : null

    if (!inConflict || line.side === null) {
      return (
        <div className={className}>
          <span className="merge-line-box" />
          <span className="merge-line-toggle" />
          <span className="merge-line-number">{line.number}</span>
          {this.renderText()}
        </div>
      )
    }

    const isOutput = pane === MergePane.Output
    const icon = isOutput
      ? octicons.dash
      : line.picked
      ? octicons.check
      : octicons.plus
    const label = isOutput
      ? 'Remove this line from the output'
      : line.picked
      ? "Don't take this line"
      : 'Take this line'

    return (
      <div className={className}>
        <span className="merge-line-box">{hunkBox}</span>
        <button
          type="button"
          className="merge-line-main"
          onClick={this.onToggleLine}
          aria-label={`${label}: ${line.text}`}
        >
          <span className="merge-line-toggle">
            {isOutput && line.label !== null ? (
              <span className="merge-side-label">{line.label}</span>
            ) : (
              <Octicon symbol={icon} />
            )}
          </span>
          <span className="merge-line-number">{line.number}</span>
          {this.renderText()}
        </button>
      </div>
    )
  }
}

interface IMergePaneViewProps {
  readonly pane: MergePane
  readonly model: IPaneModel
  readonly currentConflict: number
  readonly header: JSX.Element
  readonly onToggleLine: (pane: MergePane, index: number) => void
  readonly onToggleHunk: (pane: MergePane, index: number) => void
  readonly onScroll: (pane: MergePane, element: HTMLDivElement) => void
  readonly onActivate: (pane: MergePane) => void
  readonly onScrollerRef: (
    pane: MergePane,
    element: HTMLDivElement | null
  ) => void
}

class MergePaneView extends React.Component<IMergePaneViewProps> {
  private onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    this.props.onScroll(this.props.pane, event.currentTarget)
  }

  private onActivate = () => {
    this.props.onActivate(this.props.pane)
  }

  private onRef = (element: HTMLDivElement | null) => {
    this.props.onScrollerRef(this.props.pane, element)
  }

  public render() {
    const { pane, model, currentConflict } = this.props
    return (
      <section className={`merge-pane merge-pane-${pane}`}>
        <header className="merge-pane-header">{this.props.header}</header>
        <div
          className="merge-pane-scroller"
          ref={this.onRef}
          onScroll={this.onScroll}
          onMouseEnter={this.onActivate}
          onWheel={this.onActivate}
          onFocus={this.onActivate}
        >
          <div className="merge-pane-lines">
            {model.lines.map((line, index) => (
              <MergeLine
                key={index}
                pane={pane}
                index={index}
                line={line}
                isCurrent={line.conflict === currentConflict}
                onToggleLine={this.props.onToggleLine}
                onToggleHunk={this.props.onToggleHunk}
              />
            ))}
          </div>
        </div>
      </section>
    )
  }
}

interface IMergeConflictEditorProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  /** The conflicted file, relative to the repository root */
  readonly path: string
  /** The branch checked out (A), when known */
  readonly ourBranch?: string
  /** The branch being merged, rebased or cherry-picked (B), when known */
  readonly theirBranch?: string
  /** An id for the title, so a surrounding dialog can be labelled by it */
  readonly titleId?: string
  readonly onClose: () => void
}

interface IMergeConflictEditorState {
  readonly merge: ConflictMerge | null
  readonly loading: boolean
  readonly error: string | null
  /** Bumped after every pick so the panes rebuild */
  readonly version: number
  readonly currentConflict: number
  readonly ourSha: string | null
  readonly theirSha: string | null
  readonly askHowToSave: boolean
  readonly saving: boolean
}

/**
 * GitKraken's merge tool for one conflicted file: the current (A) and incoming
 * (B) versions side by side and the output below. Picking lines or whole
 * conflicts builds the output in pick order; Save writes it to the file.
 */
export class MergeConflictEditor extends React.Component<
  IMergeConflictEditorProps,
  IMergeConflictEditorState
> {
  private readonly scrollers = new Map<MergePane, HTMLDivElement>()
  private activePane: MergePane = MergePane.A
  private unmounted = false

  private getPanes = memoizeOne((merge: ConflictMerge, version: number) => ({
    [MergePane.A]: buildPane(merge, MergePane.A),
    [MergePane.B]: buildPane(merge, MergePane.B),
    [MergePane.Output]: buildPane(merge, MergePane.Output),
  }))

  public constructor(props: IMergeConflictEditorProps) {
    super(props)
    this.state = {
      merge: null,
      loading: true,
      error: null,
      version: 0,
      currentConflict: 0,
      ourSha: null,
      theirSha: null,
      askHowToSave: false,
      saving: false,
    }
  }

  public componentDidMount() {
    this.load()
  }

  public componentDidUpdate(prevProps: IMergeConflictEditorProps) {
    if (
      prevProps.path !== this.props.path ||
      prevProps.repository.id !== this.props.repository.id
    ) {
      this.load()
    }
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private async load() {
    const { repository, path } = this.props
    this.setState({ loading: true, error: null, merge: null })
    try {
      const [merge, shas] = await Promise.all([
        loadConflictMerge(repository, path),
        getConflictSideShas(repository),
      ])
      if (this.unmounted) {
        return
      }
      this.setState({
        merge,
        loading: false,
        error:
          merge === null
            ? 'This conflict has a deleted or binary side and can’t be merged line by line. Resolve it from the conflicts dialog instead.'
            : null,
        currentConflict: 0,
        ourSha: shas.ours,
        theirSha: shas.theirs,
        version: this.state.version + 1,
      })
      window.requestAnimationFrame(() => this.revealConflict(0))
    } catch (e) {
      if (!this.unmounted) {
        this.setState({ loading: false, error: `${e}` })
      }
    }
  }

  private get panes() {
    const { merge, version } = this.state
    return merge === null ? null : this.getPanes(merge, version)
  }

  private changed() {
    this.setState({ version: this.state.version + 1, askHowToSave: false })
  }

  private onToggleLine = (pane: MergePane, index: number) => {
    const { merge } = this.state
    const line = this.panes?.[pane].lines[index]
    if (merge === null || line === undefined || line.side === null) {
      return
    }
    if (pane === MergePane.Output || line.picked) {
      merge.unselect(line.conflict, line.side, line.line)
    } else {
      merge.select(line.conflict, line.side, line.line)
    }
    this.setState({ currentConflict: line.conflict })
    this.changed()
  }

  private onToggleHunk = (pane: MergePane, index: number) => {
    const { merge } = this.state
    const line = this.panes?.[pane].lines[index]
    if (merge === null || line === undefined || line.side === null) {
      return
    }
    merge.toggleSide(line.conflict, line.side)
    this.setState({ currentConflict: line.conflict })
    this.changed()
  }

  private onToggleAllA = () => this.toggleAll(MergeSide.A)
  private onToggleAllB = () => this.toggleAll(MergeSide.B)

  private toggleAll(side: MergeSide) {
    this.state.merge?.toggleAll(side)
    this.changed()
  }

  private onReset = () => {
    this.state.merge?.reset()
    this.changed()
  }

  private onPreviousConflict = () =>
    this.goToConflict(this.state.currentConflict - 1)

  private onNextConflict = () =>
    this.goToConflict(this.state.currentConflict + 1)

  private goToConflict(index: number) {
    const count = this.state.merge?.conflictCount ?? 0
    if (count === 0) {
      return
    }
    const wrapped = ((index % count) + count) % count
    this.setState({ currentConflict: wrapped })
    this.revealConflict(wrapped)
  }

  /** Bring a conflict to the middle of every pane. */
  private revealConflict(conflict: number) {
    const { merge } = this.state
    const panes = this.panes
    if (merge === null || panes === null || merge.conflictCount === 0) {
      return
    }
    const hunk = merge.hunks.indexOf(merge.conflicts[conflict])
    for (const [pane, scroller] of this.scrollers) {
      const start = panes[pane].hunkStarts[hunk] ?? 0
      scroller.scrollTop = Math.max(
        0,
        start * LineHeight - scroller.clientHeight / 2 + LineHeight * 2
      )
    }
  }

  private onScrollerRef = (pane: MergePane, element: HTMLDivElement | null) => {
    if (element === null) {
      this.scrollers.delete(pane)
    } else {
      this.scrollers.set(pane, element)
    }
  }

  private onActivatePane = (pane: MergePane) => {
    this.activePane = pane
  }

  /** Map a (fractional) line of one pane to the same place in another. */
  private mapLine(from: MergePane, line: number, to: MergePane) {
    const panes = this.panes
    if (panes === null) {
      return line
    }
    const fromStarts = panes[from].hunkStarts
    const toStarts = panes[to].hunkStarts
    for (let h = fromStarts.length - 1; h >= 0; h--) {
      if (line < fromStarts[h]) {
        continue
      }
      const fromEnd =
        h + 1 < fromStarts.length ? fromStarts[h + 1] : panes[from].lines.length
      const toEnd =
        h + 1 < toStarts.length ? toStarts[h + 1] : panes[to].lines.length
      const fromLength = fromEnd - fromStarts[h]
      const fraction =
        fromLength === 0 ? 0 : Math.min(1, (line - fromStarts[h]) / fromLength)
      return toStarts[h] + fraction * (toEnd - toStarts[h])
    }
    return line
  }

  /** The pane under the pointer drives the others, hunk by hunk. */
  private onPaneScroll = (pane: MergePane, element: HTMLDivElement) => {
    if (pane !== this.activePane) {
      return
    }
    const line = element.scrollTop / LineHeight
    for (const [other, scroller] of this.scrollers) {
      if (other !== pane) {
        scroller.scrollTop = this.mapLine(pane, line, other) * LineHeight
        scroller.scrollLeft = element.scrollLeft
      }
    }
  }

  private onSave = () => {
    const { merge } = this.state
    if (merge === null) {
      return
    }
    if (merge.unresolvedCount > 0) {
      this.setState({ askHowToSave: true })
      return
    }
    this.save(false)
  }

  private onSaveOutput = () => this.save(false)
  private onSaveWithMarkers = () => this.save(true)
  private onCancelSave = () => this.setState({ askHowToSave: false })

  private async save(withConflictMarkers: boolean) {
    const { merge } = this.state
    const { repository, dispatcher, path } = this.props
    if (merge === null) {
      return
    }
    this.setState({ saving: true })
    try {
      await saveConflictResolution(
        repository,
        path,
        merge.result(withConflictMarkers)
      )
      await dispatcher.refreshRepository(repository)
      this.props.onClose()
    } catch (e) {
      dispatcher.postError(e instanceof Error ? e : new Error(`${e}`))
      if (!this.unmounted) {
        this.setState({ saving: false })
      }
    }
  }

  private renderSideHeader(
    side: MergeSide,
    sha: string | null,
    branch: string | undefined,
    role: string,
    onToggle: () => void
  ) {
    const merge = this.state.merge
    const taken = merge?.isWholeSideTaken(side) ?? false
    const letter = side.toUpperCase()
    return (
      <>
        <TooltippedContent
          tagName="span"
          className="merge-take-all"
          tooltip={taken ? 'Untake all' : 'Take all'}
        >
          <input
            type="checkbox"
            checked={taken}
            disabled={merge === null || merge.conflictCount === 0}
            onChange={onToggle}
            aria-label={`Take all conflicts from ${letter}`}
          />
        </TooltippedContent>
        <span className={`merge-side-badge side-${side}`}>{letter}</span>
        <span className="merge-pane-title">
          {sha === null && branch === undefined ? (
            role
          ) : (
            <>
              Commit{' '}
              {sha !== null ? (
                <span className="merge-sha">{sha.slice(0, 6)}</span>
              ) : null}
              {branch !== undefined ? (
                <>
                  {' '}
                  on <span className="merge-branch">{branch}</span>
                </>
              ) : null}
            </>
          )}
        </span>
        <span className="merge-pane-role">{role}</span>
      </>
    )
  }

  private renderToolbar() {
    const { merge, currentConflict, saving } = this.state
    const count = merge?.conflictCount ?? 0
    return (
      <div className="merge-toolbar">
        <Octicon symbol={octicons.fileCode} />
        <span className="merge-file" id={this.props.titleId}>
          {this.props.path}
        </span>
        {merge !== null ? (
          <span className="merge-conflict-count">
            ({count === 1 ? '1 conflict' : `${count} conflicts`})
          </span>
        ) : null}
        {count > 0 ? (
          <span className="merge-nav">
            <button
              type="button"
              onClick={this.onPreviousConflict}
              aria-label="Previous conflict"
            >
              <Octicon symbol={octicons.chevronUp} />
            </button>
            <button
              type="button"
              onClick={this.onNextConflict}
              aria-label="Next conflict"
            >
              <Octicon symbol={octicons.chevronDown} />
            </button>
            <span>
              conflict {currentConflict + 1} of {count}
            </span>
          </span>
        ) : null}
        <span className="merge-toolbar-spacer" />
        <button
          type="button"
          className="merge-button"
          onClick={this.onReset}
          disabled={merge === null || !merge.hasPicks || saving}
        >
          <Octicon symbol={octicons.sync} /> Reset
        </button>
        <button
          type="button"
          className="merge-button primary"
          onClick={this.onSave}
          disabled={merge === null || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="merge-button icon"
          onClick={this.props.onClose}
          aria-label="Close merge tool"
        >
          <Octicon symbol={octicons.x} />
        </button>
      </div>
    )
  }

  private renderSavePrompt() {
    const { merge, askHowToSave } = this.state
    if (!askHowToSave || merge === null) {
      return null
    }
    const n = merge.unresolvedCount
    return (
      <div className="merge-save-prompt" role="alert">
        <Octicon symbol={octicons.alert} />
        <span>
          You have{' '}
          {n === 1 ? '1 unresolved conflict' : `${n} unresolved conflicts`}. How
          would you like to proceed?
        </span>
        <button
          type="button"
          className="merge-button"
          onClick={this.onSaveOutput}
        >
          Save Output
        </button>
        <button
          type="button"
          className="merge-button"
          onClick={this.onSaveWithMarkers}
        >
          Create Conflict Chunks
        </button>
        <button
          type="button"
          className="merge-button"
          onClick={this.onCancelSave}
        >
          Cancel
        </button>
      </div>
    )
  }

  private renderBody() {
    const { merge, loading, error, currentConflict, ourSha, theirSha } =
      this.state
    const panes = this.panes
    if (loading) {
      return <div className="merge-message">Loading conflict…</div>
    }
    if (error !== null || merge === null || panes === null) {
      return <div className="merge-message error">{error}</div>
    }

    const unresolved = merge.unresolvedCount
    const common = {
      currentConflict,
      onToggleLine: this.onToggleLine,
      onToggleHunk: this.onToggleHunk,
      onScroll: this.onPaneScroll,
      onActivate: this.onActivatePane,
      onScrollerRef: this.onScrollerRef,
    }
    return (
      <>
        {merge.conflictCount === 0 ? (
          <div className="merge-auto-resolved">
            <Octicon symbol={octicons.check} />
            Every change merges cleanly. Save to resolve this file.
          </div>
        ) : null}
        <div className="merge-sides">
          <MergePaneView
            {...common}
            pane={MergePane.A}
            model={panes[MergePane.A]}
            header={this.renderSideHeader(
              MergeSide.A,
              ourSha,
              this.props.ourBranch,
              'Current',
              this.onToggleAllA
            )}
          />
          <MergePaneView
            {...common}
            pane={MergePane.B}
            model={panes[MergePane.B]}
            header={this.renderSideHeader(
              MergeSide.B,
              theirSha,
              this.props.theirBranch,
              'Incoming',
              this.onToggleAllB
            )}
          />
        </div>
        <MergePaneView
          {...common}
          pane={MergePane.Output}
          model={panes[MergePane.Output]}
          header={
            <>
              <span className="merge-pane-title">Output</span>
              <span
                className={classNames('merge-pane-role', {
                  unresolved: unresolved > 0,
                })}
              >
                {unresolved === 0
                  ? 'All conflicts resolved'
                  : unresolved === 1
                  ? '1 unresolved conflict'
                  : `${unresolved} unresolved conflicts`}
              </span>
            </>
          }
        />
      </>
    )
  }

  public render() {
    return (
      <div className="merge-conflict-editor gk-theme">
        {this.renderToolbar()}
        {this.renderSavePrompt()}
        {this.renderBody()}
      </div>
    )
  }
}
