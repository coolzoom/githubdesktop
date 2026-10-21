import * as React from 'react'
import { Repository } from '../../models/repository'
import { Dispatcher } from '../dispatcher'
import { Dialog } from '../dialog'
import { MergeConflictEditor } from './merge-conflict-editor'

interface IMergeConflictEditorDialogProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly path: string
  readonly ourBranch?: string
  readonly theirBranch?: string
  readonly onDismissed: () => void
}

const TitleId = 'merge-conflict-editor-title'

/** The merge conflict editor as a window-sized dialog over the app. */
export class MergeConflictEditorDialog extends React.Component<IMergeConflictEditorDialogProps> {
  public render() {
    return (
      <Dialog
        id="merge-conflict-editor-dialog"
        titleId={TitleId}
        onDismissed={this.props.onDismissed}
      >
        <MergeConflictEditor
          repository={this.props.repository}
          dispatcher={this.props.dispatcher}
          path={this.props.path}
          ourBranch={this.props.ourBranch}
          theirBranch={this.props.theirBranch}
          titleId={TitleId}
          onClose={this.props.onDismissed}
        />
      </Dialog>
    )
  }
}
