/**
 * One change between two versions of a file, as 0-based line ranges. An
 * empty original range is an insertion and an empty modified one a deletion.
 */
export interface ILineChange {
  readonly originalStart: number
  readonly originalLength: number
  readonly modifiedStart: number
  readonly modifiedLength: number
}

/** Give up on files that differ too much for an interactive line diff. */
const MaxEditDistance = 5000

/**
 * The changes between two lists of lines using Myers' O(ND) algorithm, with
 * the common prefix and suffix trimmed first since edits are usually local.
 * Returns null when the files are too different to diff cheaply.
 */
export function diffLines(
  original: ReadonlyArray<string>,
  modified: ReadonlyArray<string>
): ReadonlyArray<ILineChange> | null {
  let prefix = 0
  const minLength = Math.min(original.length, modified.length)
  while (prefix < minLength && original[prefix] === modified[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < minLength - prefix &&
    original[original.length - 1 - suffix] ===
      modified[modified.length - 1 - suffix]
  ) {
    suffix++
  }

  const a = original.slice(prefix, original.length - suffix)
  const b = modified.slice(prefix, modified.length - suffix)
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) {
    return []
  }
  if (n === 0 || m === 0) {
    return [
      {
        originalStart: prefix,
        originalLength: n,
        modifiedStart: prefix,
        modifiedLength: m,
      },
    ]
  }

  const max = Math.min(n + m, MaxEditDistance)
  const offset = max
  let v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  let found = false

  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    const next = v.slice()
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
      next[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
    v = next
  }
  if (!found) {
    return null
  }

  // Walk the trace backwards to recover which lines matched.
  const matches: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d]
    const k = x - y
    const prevK =
      k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])
        ? k + 1
        : k - 1
    const prevX = prev[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      matches.push([x, y])
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    matches.push([x, y])
  }
  matches.reverse()

  const changes: ILineChange[] = []
  let ai = 0
  let bi = 0
  for (const [ma, mb] of [...matches, [n, m] as [number, number]]) {
    if (ma > ai || mb > bi) {
      changes.push({
        originalStart: prefix + ai,
        originalLength: ma - ai,
        modifiedStart: prefix + bi,
        modifiedLength: mb - bi,
      })
    }
    ai = ma + 1
    bi = mb + 1
  }
  return changes
}

/** Split text into lines the way an editor counts them. */
export function splitLines(text: string): ReadonlyArray<string> {
  return text.split(/\r\n|\r|\n/)
}

/**
 * `original` with one change taken over from `modified`, e.g. to stage a
 * single hunk into the index or to revert it in the working copy.
 */
export function applyLineChange(
  original: ReadonlyArray<string>,
  modified: ReadonlyArray<string>,
  change: ILineChange
): ReadonlyArray<string> {
  return [
    ...original.slice(0, change.originalStart),
    ...modified.slice(
      change.modifiedStart,
      change.modifiedStart + change.modifiedLength
    ),
    ...original.slice(change.originalStart + change.originalLength),
  ]
}
