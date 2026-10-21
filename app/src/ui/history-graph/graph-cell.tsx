import * as React from 'react'
import { colorIndex, GraphRowType, IGraphEdge, IGraphRow } from './graph-model'

export const GraphRowHeight = 28

/** Lane metrics for the rich and compact graph modes. */
export interface IGraphMetrics {
  readonly columnWidth: number
  readonly padding: number
  readonly lineWidth: number
  readonly nodeSize: number
  readonly mergeNodeSize: number
}

export const RichMetrics: IGraphMetrics = {
  columnWidth: 22,
  padding: 8,
  lineWidth: 2,
  nodeSize: 22,
  mergeNodeSize: 12,
}

export const CompactMetrics: IGraphMetrics = {
  columnWidth: 12,
  padding: 4,
  lineWidth: 1,
  nodeSize: 10,
  mergeNodeSize: 8,
}

const Mid = GraphRowHeight / 2
const ArcRadius = 11

export function laneX(column: number, m: IGraphMetrics) {
  return m.padding + column * m.columnWidth + m.columnWidth / 2
}

/** The natural width of a graph with `columnCount` lanes. */
export function graphNaturalWidth(columnCount: number, m: IGraphMetrics) {
  return m.padding * 2 + columnCount * m.columnWidth
}

const laneColor = (column: number) => `var(--graph-color-${colorIndex(column)})`

interface IGraphCellProps {
  readonly row: IGraphRow
  readonly width: number
  readonly metrics: IGraphMetrics
  /** Whether a ref pill connects to this row's node */
  readonly hasRefs: boolean
  readonly isSelected: boolean
  readonly avatar: JSX.Element | null
  readonly nodeTitle: string
}

/** Draws one row of the commit graph: lane lines, edges and the node. */
export class GraphCell extends React.PureComponent<IGraphCellProps> {
  private renderEdge(key: string, column: number, edge: IGraphEdge, d: string) {
    const { lineWidth } = this.props.metrics
    return (
      <path
        key={key}
        d={d}
        fill="none"
        stroke={laneColor(column)}
        strokeWidth={lineWidth}
        strokeDasharray={edge.dashed ? (lineWidth > 1 ? 2 : 1) : undefined}
      />
    )
  }

  private renderEdges() {
    const { row, metrics: m } = this.props
    const nodeX = laneX(row.column, m)
    const paths: JSX.Element[] = []
    const r = Math.min(ArcRadius, m.columnWidth / 2 + 4)

    for (const [c, edges] of row.edges) {
      const x = laneX(c, m)
      if (edges.passThrough !== undefined) {
        paths.push(
          this.renderEdge(
            `p${c}`,
            c,
            edges.passThrough,
            `M ${x} 0 V ${GraphRowHeight}`
          )
        )
      }
      if (edges.ending !== undefined) {
        const d =
          c === row.column
            ? `M ${x} 0 V ${Mid}`
            : c > row.column
            ? `M ${x} 0 V ${Mid - r} A ${r} ${r} 0 0 1 ${
                x - r
              } ${Mid} H ${nodeX}`
            : `M ${x} 0 V ${Mid - r} A ${r} ${r} 0 0 0 ${
                x + r
              } ${Mid} H ${nodeX}`
        paths.push(this.renderEdge(`e${c}`, c, edges.ending, d))
      }
      if (edges.starting !== undefined) {
        const d =
          c === row.column
            ? `M ${x} ${Mid} V ${GraphRowHeight}`
            : c > row.column
            ? `M ${nodeX} ${Mid} H ${x - r} A ${r} ${r} 0 0 1 ${x} ${
                Mid + r
              } V ${GraphRowHeight}`
            : `M ${nodeX} ${Mid} H ${x + r} A ${r} ${r} 0 0 0 ${x} ${
                Mid + r
              } V ${GraphRowHeight}`
        paths.push(this.renderEdge(`s${c}`, c, edges.starting, d))
      }
    }
    return paths
  }

  private renderNode() {
    const { row, metrics: m, avatar, nodeTitle } = this.props
    const x = laneX(row.column, m)
    const color = laneColor(row.colorColumn)

    if (row.type === GraphRowType.Merge) {
      const size = m.mergeNodeSize
      return (
        <div
          className="graph-node merge-node"
          role="img"
          aria-label={nodeTitle}
          style={{
            left: x - size / 2,
            top: Mid - size / 2,
            width: size,
            height: size,
            background: color,
          }}
        />
      )
    }

    const size = m.nodeSize
    const style: React.CSSProperties = {
      left: x - size / 2,
      top: Mid - size / 2,
      width: size,
      height: size,
      borderColor: color,
    }

    if (row.type === GraphRowType.Stash) {
      return (
        <div
          className="graph-node stash-node"
          role="img"
          aria-label={nodeTitle}
          style={style}
        />
      )
    }

    if (row.type === GraphRowType.WorkDir) {
      return (
        <div
          className="graph-node wip-node"
          role="img"
          aria-label={nodeTitle}
          style={style}
        />
      )
    }

    const compact = m.nodeSize < 16
    return (
      <div
        className="graph-node commit-node"
        role="img"
        aria-label={nodeTitle}
        style={compact ? { ...style, background: color } : style}
      >
        {compact ? null : avatar}
      </div>
    )
  }

  public render() {
    const { row, width, metrics: m, hasRefs, isSelected } = this.props
    const nodeX = laneX(row.column, m)

    return (
      <div className="graph-cell" style={{ width }}>
        <div
          className="graph-lane-band"
          style={{
            left: nodeX,
            background: `var(--graph-color-${colorIndex(
              row.colorColumn
            )}-bg15)`,
          }}
        />
        <svg
          width={width}
          height={GraphRowHeight}
          className="graph-edges"
          aria-hidden="true"
        >
          {hasRefs ? (
            <line
              x1={0}
              y1={Mid}
              x2={nodeX}
              y2={Mid}
              stroke={laneColor(row.colorColumn)}
              strokeWidth={m.lineWidth}
              strokeOpacity={isSelected ? 1 : 0.25}
            />
          ) : null}
          {this.renderEdges()}
        </svg>
        {this.renderNode()}
      </div>
    )
  }
}
