/**
 * The model behind the merge conflict editor: a line-based three-way merge of
 * a conflicted file's index stages and the picks the user makes per conflict,
 * following GitKraken's merge tool.
 */

/**
 * A run of a three-way merge. Clean runs carry the merged lines (`ok`) and
 * each side's own lines there; conflicts carry both sides and the ancestor.
 */
export interface IDiff3Chunk {
  readonly isConflict: boolean
  readonly a: ReadonlyArray<string>
  readonly base: ReadonlyArray<string>
  readonly b: ReadonlyArray<string>
  readonly ok: ReadonlyArray<string>
}

interface ILineHunk {
  readonly o: number
  readonly oLength: number
  readonly x: number
  readonly xLength: number
}

/** Above this many edits a diff reports the remaining middle as one block. */
const MaxEdits = 4000

/** The blocks where `o` and `x` differ, in order. */
export function diffLines(
  o: ReadonlyArray<string>,
  x: ReadonlyArray<string>
): ReadonlyArray<ILineHunk> {
  const ids = new Map<string, number>()
  const id = (s: string) => {
    let value = ids.get(s)
    if (value === undefined) {
      value = ids.size
      ids.set(s, value)
    }
    return value
  }
  const a = o.map(id)
  const b = x.map(id)

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const matches: Array<[number, number]> = []
  for (let i = 0; i < prefix; i++) {
    matches.push([i, i])
  }
  myers(
    a.slice(prefix, a.length - suffix),
    b.slice(prefix, b.length - suffix),
    prefix,
    prefix,
    matches
  )
  for (let i = suffix; i > 0; i--) {
    matches.push([a.length - i, b.length - i])
  }

  const hunks: ILineHunk[] = []
  let ai = 0
  let bi = 0
  for (const [ma, mb] of [...matches, [a.length, b.length]]) {
    if (ma > ai || mb > bi) {
      hunks.push({ o: ai, oLength: ma - ai, x: bi, xLength: mb - bi })
    }
    ai = ma + 1
    bi = mb + 1
  }
  return hunks
}

/** Appends the matched index pairs of the shortest edit script. */
function myers(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
  aOffset: number,
  bOffset: number,
  matches: Array<[number, number]>
) {
  const n = a.length
  const m = b.length
  const max = n + m
  if (n === 0 || m === 0) {
    return
  }
  const offset = max + 1
  const v = new Array<number>(2 * max + 3).fill(0)
  const trace: number[][] = []
  let found = -1
  for (let d = 0; d <= Math.min(max, MaxEdits) && found < 0; d++) {
    trace.push(v.slice(offset - d, offset - d + 2 * d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) {
    return
  }

  const pairs: Array<[number, number]> = []
  let px = n
  let py = m
  for (let d = found; d > 0; d--) {
    const previous = trace[d]
    const at = (k: number) => previous[k + d]
    const k0 = px - py
    const prevK =
      k0 === -d || (k0 !== d && at(k0 - 1) < at(k0 + 1)) ? k0 + 1 : k0 - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    const startX = prevK === k0 + 1 ? prevX : prevX + 1
    const startY = startX - k0
    while (px > startX && py > startY) {
      px--
      py--
      pairs.push([px, py])
    }
    px = prevX
    py = prevY
  }
  while (px > 0 && py > 0) {
    px--
    py--
    pairs.push([px, py])
  }
  for (let i = pairs.length - 1; i >= 0; i--) {
    matches.push([pairs[i][0] + aOffset, pairs[i][1] + bOffset])
  }
}

interface IConflictRange {
  readonly a: number
  readonly aLength: number
  readonly o: number
  readonly oLength: number
  readonly b: number
  readonly bLength: number
}

/**
 * Merge `a` and `b` against their ancestor `o`. Overlapping or adjacent
 * changes conflict unless both sides made the same change.
 */
export function merge3(
  a: ReadonlyArray<string>,
  o: ReadonlyArray<string>,
  b: ReadonlyArray<string>
): ReadonlyArray<IDiff3Chunk> {
  const hunks = [
    ...diffLines(o, a).map(h => ({ ...h, side: 0 })),
    ...diffLines(o, b).map(h => ({ ...h, side: 2 })),
  ].sort((p, q) => p.o - q.o)

  // side: 0 = A, 1 = ancestor, 2 = B, -1 = conflict
  const regions: Array<{
    side: number
    start: number
    length: number
    conflict?: IConflictRange
  }> = []
  let common = 0
  const copyCommon = (to: number) => {
    if (to > common) {
      regions.push({ side: 1, start: common, length: to - common })
    }
    common = to
  }
  const shift = [0, 0, 0]
  for (let i = 0; i < hunks.length; i++) {
    const first = i
    const start = hunks[i].o
    let end = start + hunks[i].oLength
    while (i < hunks.length - 1 && hunks[i + 1].o <= end) {
      end = Math.max(end, hunks[i + 1].o + hunks[i + 1].oLength)
      i++
    }
    copyCommon(start)
    if (first === i) {
      const h = hunks[i]
      if (h.xLength > 0) {
        regions.push({ side: h.side, start: h.x, length: h.xLength })
      }
      shift[h.side] += h.xLength - h.oLength
    } else {
      const group = hunks.slice(first, i + 1)
      const range = (side: number): [number, number] => {
        const own = group.filter(h => h.side === side)
        if (own.length === 0) {
          return [start + shift[side], end + shift[side]]
        }
        const lo =
          Math.min(...own.map(h => h.x)) +
          (start - Math.min(...own.map(h => h.o)))
        const hi =
          Math.max(...own.map(h => h.x + h.xLength)) +
          (end - Math.max(...own.map(h => h.o + h.oLength)))
        return [lo, hi]
      }
      const ra = range(0)
      const rb = range(2)
      shift[0] = ra[1] - end
      shift[2] = rb[1] - end
      regions.push({
        side: -1,
        start: 0,
        length: 0,
        conflict: {
          a: ra[0],
          aLength: ra[1] - ra[0],
          o: start,
          oLength: end - start,
          b: rb[0],
          bLength: rb[1] - rb[0],
        },
      })
    }
    common = end
  }
  copyCommon(o.length)

  const chunks: Array<{ chunk: IDiff3Chunk; a: number; b: number }> = []
  let ok: string[] = []
  const flush = () => {
    if (ok.length > 0) {
      chunks.push({
        chunk: { isConflict: false, a: [], base: [], b: [], ok },
        a: -1,
        b: -1,
      })
    }
    ok = []
  }
  for (const region of regions) {
    const c = region.conflict
    if (c === undefined) {
      const source = region.side === 0 ? a : region.side === 2 ? b : o
      ok.push(...source.slice(region.start, region.start + region.length))
      continue
    }
    const sideA = a.slice(c.a, c.a + c.aLength)
    const sideB = b.slice(c.b, c.b + c.bLength)
    if (
      sideA.length === sideB.length &&
      sideA.every((line, i) => line === sideB[i])
    ) {
      ok.push(...sideA)
      continue
    }
    flush()
    chunks.push({
      chunk: {
        isConflict: true,
        a: sideA,
        base: o.slice(c.o, c.o + c.oLength),
        b: sideB,
        ok: [],
      },
      a: c.a,
      b: c.b,
    })
  }
  flush()

  // Clean runs also carry each side's own lines between the conflicts, so
  // every pane can show its whole file.
  const result: IDiff3Chunk[] = []
  let aPos = 0
  let bPos = 0
  for (let i = 0; i < chunks.length; i++) {
    const { chunk, a: ca, b: cb } = chunks[i]
    if (chunk.isConflict) {
      result.push(chunk)
      aPos = ca + chunk.a.length
      bPos = cb + chunk.b.length
      continue
    }
    const next = chunks.slice(i + 1).find(x => x.chunk.isConflict)
    const aEnd = next === undefined ? a.length : next.a
    const bEnd = next === undefined ? b.length : next.b
    result.push({ ...chunk, a: a.slice(aPos, aEnd), b: b.slice(bPos, bEnd) })
    aPos = aEnd
    bPos = bEnd
  }
  return result
}

export enum MergeSide {
  A = 'a',
  B = 'b',
}

export interface IMergePick {
  readonly side: MergeSide
  readonly line: number
}

/**
 * One run of the merged file. A conflict's output is the lines picked so far,
 * in the order they were picked.
 */
export class MergeHunk {
  public readonly isConflict: boolean
  public readonly conflictIndex: number
  public readonly a: ReadonlyArray<string>
  public readonly b: ReadonlyArray<string>
  public readonly base: ReadonlyArray<string>
  public readonly ok: ReadonlyArray<string>
  /** The side had no lines; it shows one blank line so it can be picked */
  public readonly aIsEmpty: boolean
  public readonly bIsEmpty: boolean
  public picks: ReadonlyArray<IMergePick> = []

  public constructor(chunk: IDiff3Chunk, conflictIndex: number) {
    this.isConflict = chunk.isConflict
    this.conflictIndex = conflictIndex
    this.base = chunk.base
    this.ok = chunk.ok
    this.aIsEmpty = chunk.isConflict && chunk.a.length === 0
    this.bIsEmpty = chunk.isConflict && chunk.b.length === 0
    this.a = this.aIsEmpty ? [''] : chunk.a
    this.b = this.bIsEmpty ? [''] : chunk.b
  }

  /** An untouched conflict shows (and saves) the ancestor's lines. */
  public get showsBase() {
    return this.isConflict && this.picks.length === 0
  }

  public lines(side: MergeSide) {
    return side === MergeSide.A ? this.a : this.b
  }

  public isPlaceholder(side: MergeSide) {
    return side === MergeSide.A ? this.aIsEmpty : this.bIsEmpty
  }

  public isPicked(side: MergeSide, line: number) {
    return this.picks.some(p => p.side === side && p.line === line)
  }

  public isSideTaken(side: MergeSide) {
    return this.lines(side).every((_, i) => this.isPicked(side, i))
  }

  /** The lines this run shows in the output pane. */
  public get outputLines(): ReadonlyArray<string> {
    if (!this.isConflict) {
      return this.ok
    }
    if (this.showsBase) {
      return this.base
    }
    return this.picks.map(p => this.lines(p.side)[p.line])
  }
}

export const ConflictMarkerA = '<<<<<<<'
export const ConflictMarkerSplit = '======='
export const ConflictMarkerB = '>>>>>>>'

/**
 * One conflicted file in the merge conflict editor: pick lines or whole sides
 * per conflict; the output keeps the pick order.
 */
export class ConflictMerge {
  public static fromTexts(
    ancestor: string | null,
    a: string,
    b: string,
    lineEnding?: string
  ) {
    const bom = a.startsWith('\uFEFF') ? '\uFEFF' : ''
    const strip = (s: string) => (s.startsWith('\uFEFF') ? s.slice(1) : s)
    return new ConflictMerge(
      merge3(
        splitLines(strip(a)),
        ancestor === null ? [] : splitLines(strip(ancestor)),
        splitLines(strip(b))
      ),
      lineEnding ?? detectLineEnding(a),
      bom
    )
  }

  public readonly hunks: ReadonlyArray<MergeHunk>
  public readonly conflicts: ReadonlyArray<MergeHunk>

  public constructor(
    chunks: ReadonlyArray<IDiff3Chunk>,
    public readonly lineEnding = '\n',
    public readonly bom = ''
  ) {
    let conflicts = 0
    this.hunks = chunks.map(
      c => new MergeHunk(c, c.isConflict ? conflicts++ : -1)
    )
    this.conflicts = this.hunks.filter(h => h.isConflict)
  }

  public get conflictCount() {
    return this.conflicts.length
  }

  public get unresolvedCount() {
    return this.conflicts.filter(c => c.picks.length === 0).length
  }

  public get hasPicks() {
    return this.conflicts.some(c => c.picks.length > 0)
  }

  /** Add one line to a conflict's output, after the lines already picked. */
  public select(conflict: number, side: MergeSide, line: number) {
    const hunk = this.conflicts[conflict]
    if (!hunk.isPicked(side, line)) {
      hunk.picks = [...hunk.picks, { side, line }]
    }
  }

  public unselect(conflict: number, side: MergeSide, line: number) {
    const hunk = this.conflicts[conflict]
    hunk.picks = hunk.picks.filter(p => !(p.side === side && p.line === line))
  }

  /** The hunk checkbox: the side's lines move to the end of the output. */
  public takeSide(conflict: number, side: MergeSide) {
    const hunk = this.conflicts[conflict]
    hunk.picks = [
      ...hunk.picks.filter(p => p.side !== side),
      ...hunk.lines(side).map((_, line) => ({ side, line })),
    ]
  }

  public untakeSide(conflict: number, side: MergeSide) {
    const hunk = this.conflicts[conflict]
    hunk.picks = hunk.picks.filter(p => p.side !== side)
  }

  public toggleSide(conflict: number, side: MergeSide) {
    if (this.conflicts[conflict].isSideTaken(side)) {
      this.untakeSide(conflict, side)
    } else {
      this.takeSide(conflict, side)
    }
  }

  public isWholeSideTaken(side: MergeSide) {
    return (
      this.conflictCount > 0 && this.conflicts.every(c => c.isSideTaken(side))
    )
  }

  /** The pane header checkbox: take every conflict's side, or none. */
  public toggleAll(side: MergeSide) {
    const take = !this.isWholeSideTaken(side)
    this.conflicts.forEach((_, i) =>
      take ? this.takeSide(i, side) : this.untakeSide(i, side)
    )
  }

  public reset() {
    for (const c of this.conflicts) {
      c.picks = []
    }
  }

  /**
   * The file to write. Untouched conflicts keep the ancestor, or become
   * conflict markers with both sides when `withConflictMarkers` is set.
   */
  public result(withConflictMarkers = false) {
    const lines: string[] = []
    for (const h of this.hunks) {
      if (!h.isConflict) {
        lines.push(...h.ok)
      } else if (h.picks.length > 0) {
        for (const p of h.picks) {
          if (!h.isPlaceholder(p.side)) {
            lines.push(h.lines(p.side)[p.line])
          }
        }
      } else if (!withConflictMarkers) {
        lines.push(...h.base)
      } else {
        lines.push(ConflictMarkerA)
        if (!h.aIsEmpty) {
          lines.push(...h.a)
        }
        lines.push(ConflictMarkerSplit)
        if (!h.bIsEmpty) {
          lines.push(...h.b)
        }
        lines.push(ConflictMarkerB)
      }
    }
    return this.bom + lines.join(this.lineEnding)
  }
}

/** A trailing newline leaves a final empty line, so joining restores it. */
export function splitLines(text: string): ReadonlyArray<string> {
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function detectLineEnding(text: string) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}
