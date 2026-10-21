import * as React from 'react'
import * as Path from 'path'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TooltippedContent } from '../lib/tooltipped-content'
import { getTerminalSession, TerminalSession } from './terminal-sessions'

const MinHeight = 80

interface ITerminalPanelProps {
  /** The working directory of the shell, one session per path */
  readonly path: string
  readonly height: number
  readonly onHeightChanged: (height: number) => void
  readonly onClose: () => void
}

/** VS Code's integrated terminal at the bottom of the repository view. */
export class TerminalPanel extends React.Component<ITerminalPanelProps> {
  private readonly containerRef = React.createRef<HTMLDivElement>()
  private resizeObserver: ResizeObserver | null = null
  private session: TerminalSession | null = null
  private dragStart: { y: number; height: number } | null = null

  public componentDidMount() {
    this.attach()
    const container = this.containerRef.current
    if (container !== null) {
      this.resizeObserver = new ResizeObserver(() => this.session?.layout())
      this.resizeObserver.observe(container)
    }
  }

  public componentDidUpdate(prevProps: ITerminalPanelProps) {
    if (prevProps.path !== this.props.path) {
      this.session?.detach()
      this.attach()
    }
  }

  public componentWillUnmount() {
    this.resizeObserver?.disconnect()
    this.session?.detach()
    this.stopDragging()
  }

  private attach() {
    const container = this.containerRef.current
    if (container === null) {
      return
    }
    this.session = getTerminalSession(this.props.path)
    this.session.attach(container)
    this.session.focus()
  }

  private onClear = () => {
    this.session?.clear()
    this.session?.focus()
  }

  private onRestart = () => {
    this.session?.restart()
    this.session?.focus()
  }

  private onHandleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    this.dragStart = { y: event.clientY, height: this.props.height }
    document.addEventListener('mousemove', this.onDrag)
    document.addEventListener('mouseup', this.stopDragging)
  }

  private onDrag = (event: MouseEvent) => {
    if (this.dragStart === null) {
      return
    }
    const parent = this.containerRef.current?.closest('.history-graph-center')
    const max = Math.max(MinHeight, (parent?.clientHeight ?? 600) - 80)
    const height = this.dragStart.height + this.dragStart.y - event.clientY
    this.props.onHeightChanged(Math.min(max, Math.max(MinHeight, height)))
  }

  private stopDragging = () => {
    this.dragStart = null
    document.removeEventListener('mousemove', this.onDrag)
    document.removeEventListener('mouseup', this.stopDragging)
  }

  private renderButton(
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

  public render() {
    return (
      <div className="terminal-panel" style={{ height: this.props.height }}>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className="terminal-panel-resize-handle"
          onMouseDown={this.onHandleMouseDown}
        />
        <div className="terminal-panel-header">
          <span className="terminal-panel-title">Terminal</span>
          <span className="terminal-panel-cwd">
            {Path.basename(this.props.path)}
          </span>
          <span className="terminal-panel-actions">
            {this.renderButton('Clear terminal', octicons.trash, this.onClear)}
            {this.renderButton('Restart shell', octicons.sync, this.onRestart)}
            {this.renderButton(
              'Hide terminal (Ctrl+`)',
              octicons.x,
              this.props.onClose
            )}
          </span>
        </div>
        <div className="terminal-panel-body" ref={this.containerRef} />
      </div>
    )
  }
}
