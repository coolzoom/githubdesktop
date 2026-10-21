import * as React from 'react'
import * as Path from 'path'
import classNames from 'classnames'
import { Disposable } from 'event-kit'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { IMenuItem, showContextualMenu } from '../../lib/menu-item'
import { writeClipboardText } from '../main-process-proxy'
import { IEditorTab, RepositoryEditors } from './editor-store'

interface ITabButtonProps {
  readonly tab: IEditorTab
  readonly isActive: boolean
  readonly isDirty: boolean
  /** Shown next to the name to tell files with the same name apart */
  readonly folder: string | null
  readonly onActivate: (path: string) => void
  readonly onPin: (path: string) => void
  readonly onClose: (path: string) => void
  readonly onContextMenu: (path: string) => void
}

class TabButton extends React.PureComponent<ITabButtonProps> {
  private onClick = () => this.props.onActivate(this.props.tab.path)
  private onDoubleClick = () => this.props.onPin(this.props.tab.path)

  private onAuxClick = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      this.props.onClose(this.props.tab.path)
    }
  }

  private onClose = (e: React.MouseEvent) => {
    e.stopPropagation()
    this.props.onClose(this.props.tab.path)
  }

  private onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    this.props.onContextMenu(this.props.tab.path)
  }

  public render() {
    const { tab, isActive, isDirty, folder } = this.props
    return (
      <div
        className={classNames('editor-tab', {
          active: isActive,
          preview: tab.isPreview,
          dirty: isDirty,
        })}
        role="tab"
        aria-selected={isActive}
      >
        <button
          type="button"
          className="editor-tab-label"
          onClick={this.onClick}
          onDoubleClick={this.onDoubleClick}
          onAuxClick={this.onAuxClick}
          onContextMenu={this.onContextMenu}
        >
          <Octicon
            symbol={tab.view === 'changes' ? octicons.diff : octicons.file}
          />
          <span className="name">{Path.basename(tab.path)}</span>
          {folder !== null && <span className="folder">{folder}</span>}
        </button>
        <button
          type="button"
          className="editor-tab-close"
          onClick={this.onClose}
          aria-label={`Close ${Path.basename(tab.path)}`}
        >
          <span className="dirty-dot" />
          <Octicon symbol={octicons.x} />
        </button>
      </div>
    )
  }
}

interface IEditorTabsProps {
  readonly editors: RepositoryEditors
  readonly externalEditorLabel?: string
  readonly onOpenInExternalEditor: (path: string) => void
}

/** VS Code's editor tabs, after a tab for the commit graph. */
export class EditorTabs extends React.Component<IEditorTabsProps> {
  private subscription: Disposable | null = null

  public componentDidMount() {
    this.subscribe()
  }

  public componentDidUpdate(prevProps: IEditorTabsProps) {
    if (prevProps.editors !== this.props.editors) {
      this.subscribe()
    }
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
  }

  private subscribe() {
    this.subscription?.dispose()
    this.subscription = this.props.editors.onDidChange(() => this.forceUpdate())
  }

  private onShowGraph = () => this.props.editors.activate(null)
  private onActivate = (path: string) => this.props.editors.activate(path)
  private onPin = (path: string) => this.props.editors.pin(path)
  private onClose = (path: string) => this.props.editors.close([path])

  private onContextMenu = (path: string) => {
    const { editors } = this.props
    const others = editors.tabs.map(t => t.path).filter(p => p !== path)
    const fullPath = Path.join(editors.repository.path, path)
    const items: IMenuItem[] = [
      { label: 'Close', action: () => editors.close([path]) },
      {
        label: __DARWIN__ ? 'Close Others' : 'Close others',
        enabled: others.length > 0,
        action: () => editors.close(others),
      },
      {
        label: __DARWIN__ ? 'Close All' : 'Close all',
        action: () => editors.close(editors.tabs.map(t => t.path)),
      },
      { type: 'separator' },
      {
        label: __DARWIN__ ? 'Keep Open' : 'Keep open',
        enabled: editors.tabs.find(t => t.path === path)?.isPreview === true,
        action: () => editors.pin(path),
      },
      {
        label: this.props.externalEditorLabel
          ? `Open in ${this.props.externalEditorLabel}`
          : __DARWIN__
          ? 'Open in External Editor'
          : 'Open in external editor',
        action: () => this.props.onOpenInExternalEditor(path),
      },
      { type: 'separator' },
      {
        label: __DARWIN__ ? 'Copy Path' : 'Copy path',
        action: () => writeClipboardText(fullPath),
      },
      {
        label: __DARWIN__ ? 'Copy Relative Path' : 'Copy relative path',
        action: () => writeClipboardText(path),
      },
    ]
    showContextualMenu(items)
  }

  public render() {
    const { editors } = this.props
    const { tabs, activePath } = editors
    const nameCounts = new Map<string, number>()
    for (const tab of tabs) {
      const name = Path.basename(tab.path)
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
    return (
      <div className="editor-tabs" role="tablist">
        <div
          className={classNames('editor-tab graph-tab', {
            active: activePath === null,
          })}
          role="tab"
          aria-selected={activePath === null}
        >
          <button
            type="button"
            className="editor-tab-label"
            onClick={this.onShowGraph}
          >
            <Octicon symbol={octicons.gitCommit} />
            <span className="name">Graph</span>
          </button>
        </div>
        {tabs.map(tab => (
          <TabButton
            key={tab.path}
            tab={tab}
            isActive={tab.path === activePath}
            isDirty={editors.getDocument(tab.path)?.isDirty === true}
            folder={
              (nameCounts.get(Path.basename(tab.path)) ?? 0) > 1
                ? Path.dirname(tab.path)
                : null
            }
            onActivate={this.onActivate}
            onPin={this.onPin}
            onClose={this.onClose}
            onContextMenu={this.onContextMenu}
          />
        ))}
      </div>
    )
  }
}
