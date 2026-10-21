import { Emitter, Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { IRemote } from '../../models/remote'
import { getBranchTracking, IBranchTracking } from '../../lib/git/graph'

export interface IRemoteFormRequest {
  /** The remote being edited, null when adding one */
  readonly remote: IRemote | null
  /** Changes on every open so the form resets */
  readonly nonce: number
}

/** Per-repository view settings of the commit graph, persisted locally. */
export interface IGraphRepoSettings {
  readonly hiddenRefs: ReadonlyArray<string>
  readonly soloRefs: ReadonlyArray<string>
  readonly pinnedRef: string | null
  readonly collapsedSections: ReadonlyArray<string>
  readonly treeView: boolean
}

/** Column layout of the commit graph, shared by all repositories. */
export interface IGraphColumns {
  readonly refWidth: number
  readonly graphWidth: number
  readonly authorWidth: number
  readonly dateWidth: number
  readonly shaWidth: number
  readonly showAuthor: boolean
  readonly showDate: boolean
  readonly showSha: boolean
  readonly compact: boolean
  /** Width of the commit details panel right of the graph */
  readonly detailsWidth: number
}

export const DefaultGraphColumns: IGraphColumns = {
  refWidth: 190,
  /** 0 sizes the graph zone to fit its lanes */
  graphWidth: 0,
  authorWidth: 130,
  dateWidth: 140,
  shaWidth: 70,
  showAuthor: false,
  showDate: false,
  showSha: false,
  compact: false,
  detailsWidth: 340,
}

const DefaultRepoSettings: IGraphRepoSettings = {
  hiddenRefs: [],
  soloRefs: [],
  pinnedRef: null,
  collapsedSections: [],
  treeView: false,
}

const ColumnsKey = 'commit-graph-columns'
const repoKey = (repositoryId: number) => `commit-graph-repo-${repositoryId}`

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

/**
 * Shares the commit graph's UI-only state between the graph, the ref panel and
 * the details panel, which live in different parts of the repository view.
 */
class GraphViewStore {
  private readonly emitter = new Emitter()
  private readonly repoSettings = new Map<number, IGraphRepoSettings>()
  private columnsValue: IGraphColumns = readJSON(
    ColumnsKey,
    DefaultGraphColumns
  )
  private scrollRequest: { sha: string; nonce: number } | null = null
  private searchTexts = new Map<number, string>()
  private tracking = new Map<
    number,
    { key: string; value: ReadonlyMap<string, IBranchTracking> }
  >()
  private trackingInFlight = new Set<string>()
  private remoteForms = new Map<number, IRemoteFormRequest>()

  public onDidUpdate(fn: () => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  private emit() {
    this.emitter.emit('did-update', null)
  }

  public get columns(): IGraphColumns {
    return this.columnsValue
  }

  public updateColumns(update: Partial<IGraphColumns>) {
    this.columnsValue = { ...this.columnsValue, ...update }
    localStorage.setItem(ColumnsKey, JSON.stringify(this.columnsValue))
    this.emit()
  }

  public resetColumns() {
    this.updateColumns(DefaultGraphColumns)
  }

  public getSettings(repositoryId: number): IGraphRepoSettings {
    let settings = this.repoSettings.get(repositoryId)
    if (settings === undefined) {
      settings = readJSON(repoKey(repositoryId), DefaultRepoSettings)
      this.repoSettings.set(repositoryId, settings)
    }
    return settings
  }

  public updateSettings(
    repositoryId: number,
    update: Partial<IGraphRepoSettings>
  ) {
    const settings = { ...this.getSettings(repositoryId), ...update }
    this.repoSettings.set(repositoryId, settings)
    localStorage.setItem(repoKey(repositoryId), JSON.stringify(settings))
    this.emit()
  }

  public isHidden(repositoryId: number, ref: string) {
    return this.getSettings(repositoryId).hiddenRefs.includes(ref)
  }

  public isSolo(repositoryId: number, ref: string) {
    return this.getSettings(repositoryId).soloRefs.includes(ref)
  }

  public setHidden(
    repositoryId: number,
    refs: ReadonlyArray<string>,
    hidden: boolean
  ) {
    const current = new Set(this.getSettings(repositoryId).hiddenRefs)
    refs.forEach(r => (hidden ? current.add(r) : current.delete(r)))
    this.updateSettings(repositoryId, { hiddenRefs: [...current] })
  }

  public setSolo(
    repositoryId: number,
    refs: ReadonlyArray<string>,
    solo: boolean
  ) {
    const current = new Set(this.getSettings(repositoryId).soloRefs)
    refs.forEach(r => (solo ? current.add(r) : current.delete(r)))
    this.updateSettings(repositoryId, { soloRefs: [...current] })
  }

  public setPinned(repositoryId: number, ref: string | null) {
    this.updateSettings(repositoryId, { pinnedRef: ref })
  }

  public toggleSection(repositoryId: number, section: string) {
    const current = new Set(this.getSettings(repositoryId).collapsedSections)
    if (current.has(section)) {
      current.delete(section)
    } else {
      current.add(section)
    }
    this.updateSettings(repositoryId, { collapsedSections: [...current] })
  }

  public getSearchText(repositoryId: number) {
    return this.searchTexts.get(repositoryId) ?? ''
  }

  public setSearchText(repositoryId: number, text: string) {
    this.searchTexts.set(repositoryId, text)
    this.emit()
  }

  /** Ahead/behind counts of local branches, keyed by branch name. */
  public getTracking(
    repositoryId: number
  ): ReadonlyMap<string, IBranchTracking> {
    return this.tracking.get(repositoryId)?.value ?? new Map()
  }

  /**
   * Reload the ahead/behind counts when `key` (which changes whenever any
   * ref moves) differs from the last load.
   */
  public refreshTracking(repository: Repository, key: string) {
    const flightKey = `${repository.id}\n${key}`
    if (
      this.tracking.get(repository.id)?.key === key ||
      this.trackingInFlight.has(flightKey)
    ) {
      return
    }
    this.trackingInFlight.add(flightKey)
    getBranchTracking(repository)
      .then(value => {
        this.tracking.set(repository.id, { key, value })
        this.emit()
      })
      .catch(e => log.warn('Failed to load branch tracking', e))
      .finally(() => this.trackingInFlight.delete(flightKey))
  }

  /** Ask the graph to scroll a commit into view. */
  public requestScrollTo(sha: string) {
    this.scrollRequest = { sha, nonce: (this.scrollRequest?.nonce ?? 0) + 1 }
    this.emit()
  }

  public get pendingScroll() {
    return this.scrollRequest
  }

  /** The add / edit remote form shown above the graph, if any. */
  public getRemoteForm(repositoryId: number) {
    return this.remoteForms.get(repositoryId) ?? null
  }

  /** Open the remote form; pass a remote to edit it, null to add one. */
  public openRemoteForm(repositoryId: number, remote: IRemote | null) {
    const nonce = (this.remoteForms.get(repositoryId)?.nonce ?? 0) + 1
    this.remoteForms.set(repositoryId, { remote, nonce })
    this.emit()
  }

  public closeRemoteForm(repositoryId: number) {
    if (this.remoteForms.delete(repositoryId)) {
      this.emit()
    }
  }
}

export const graphViewStore = new GraphViewStore()
