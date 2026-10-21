import * as React from 'react'
import classNames from 'classnames'
import { ConflictState, IMultiCommitOperationState } from '../../lib/app-state'
import { MultiCommitOperationStepKind } from '../../models/multi-commit-operation'
import {
  ConflictedFileStatus,
  isConflictWithMarkers,
  WorkingDirectoryStatus,
} from '../../models/status'
import { getUnmergedFiles, hasUnresolvedConflicts } from '../../lib/status'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TooltippedContent } from '../lib/tooltipped-content'

export interface IConflictInfo {
  readonly operation: string
  readonly ourBranch?: string
  readonly theirBranch?: string
  readonly files: ReadonlyArray<IConflictFile>
}

export interface IConflictFile {
  readonly path: string
  readonly resolved: boolean
  /** Text conflicts open in the merge tool; others need the dialog */
  readonly canMerge: boolean
}

/** What is conflicted right now, or null outside a conflicted operation. */
export function getConflictInfo(
  conflictState: ConflictState | null,
  operationState: IMultiCommitOperationState | null,
  workingDirectory: WorkingDirectoryStatus
): IConflictInfo | null {
  if (conflictState === null) {
    return null
  }
  const files = getUnmergedFiles(workingDirectory)
  if (files.length === 0) {
    return null
  }

  let ourBranch: string | undefined
  let theirBranch: string | undefined
  const step = operationState?.step
  if (
    step !== undefined &&
    (step.kind === MultiCommitOperationStepKind.ShowConflicts ||
      step.kind === MultiCommitOperationStepKind.HideConflicts)
  ) {
    ourBranch = step.conflictState.ourBranch
    theirBranch = step.conflictState.theirBranch
  } else if (conflictState.kind === 'merge') {
    ourBranch = conflictState.currentBranch
  } else if (conflictState.kind === 'rebase') {
    ourBranch = conflictState.baseBranch
    theirBranch = conflictState.targetBranch
  } else {
    ourBranch = conflictState.targetBranchName
  }

  const operation =
    operationState?.operationDetail.kind ??
    (conflictState.kind === 'merge'
      ? 'Merge'
      : conflictState.kind === 'rebase'
      ? 'Rebase'
      : 'Cherry-pick')

  return {
    operation,
    ourBranch,
    theirBranch,
    files: files.map(f => {
      const status = f.status as ConflictedFileStatus
      return {
        path: f.path,
        resolved: !hasUnresolvedConflicts(
          status,
          conflictState.manualResolutions.get(f.path)
        ),
        canMerge: isConflictWithMarkers(status),
      }
    }),
  }
}

interface IConflictFileChipProps {
  readonly file: IConflictFile
  readonly isOpen: boolean
  readonly onOpen: (path: string) => void
}

class ConflictFileChip extends React.PureComponent<IConflictFileChipProps> {
  private onClick = () => this.props.onOpen(this.props.file.path)

  public render() {
    const { file, isOpen } = this.props
    const name = file.path.split('/').pop() ?? file.path
    return (
      <TooltippedContent
        tagName="span"
        tooltip={
          file.canMerge
            ? `${file.path} — open in the merge tool`
            : `${file.path} — deleted or binary, resolve it in the conflicts dialog`
        }
      >
        <button
          className={classNames('conflict-file', {
            resolved: file.resolved,
            open: isOpen,
          })}
          onClick={this.onClick}
        >
          <Octicon symbol={file.resolved ? octicons.check : octicons.alert} />
          {name}
        </button>
      </TooltippedContent>
    )
  }
}

interface IConflictBarProps {
  readonly info: IConflictInfo
  readonly openPath: string | null
  readonly onOpenFile: (path: string) => void
  readonly onShowDialog: () => void
}

/**
 * GitKraken's conflict prompt above the graph: what is being merged and the
 * conflicted files, each opening in the merge tool.
 */
export class ConflictBar extends React.Component<IConflictBarProps> {
  public render() {
    const { info, openPath } = this.props
    const remaining = info.files.filter(f => !f.resolved).length
    const verb =
      info.operation === 'Rebase'
        ? 'onto'
        : info.operation === 'Merge'
        ? 'into'
        : 'onto'
    return (
      <div className={classNames('conflict-bar', { done: remaining === 0 })}>
        <div className="conflict-bar-summary">
          <Octicon symbol={remaining === 0 ? octicons.check : octicons.alert} />
          <span className="conflict-bar-title">
            {remaining === 0
              ? 'All conflicts resolved'
              : `${info.operation} conflicts detected`}
          </span>
          {info.theirBranch !== undefined || info.ourBranch !== undefined ? (
            <span className="conflict-bar-branches">
              {info.operation}{' '}
              {info.theirBranch !== undefined ? (
                <strong>{info.theirBranch}</strong>
              ) : null}
              {info.ourBranch !== undefined ? (
                <>
                  {' '}
                  {verb} <strong>{info.ourBranch}</strong>
                </>
              ) : null}
            </span>
          ) : null}
          <span className="conflict-bar-count">
            {remaining === 0
              ? `${info.files.length} resolved`
              : `${remaining} of ${info.files.length} files conflicted`}
          </span>
          <span className="conflict-bar-spacer" />
          <button
            className="conflict-bar-action"
            onClick={this.props.onShowDialog}
          >
            {remaining === 0
              ? `Continue ${info.operation.toLowerCase()}…`
              : 'Continue / Abort…'}
          </button>
        </div>
        <div className="conflict-bar-files">
          {info.files.map(file => (
            <ConflictFileChip
              key={file.path}
              file={file}
              isOpen={file.path === openPath}
              onOpen={this.props.onOpenFile}
            />
          ))}
        </div>
      </div>
    )
  }
}
