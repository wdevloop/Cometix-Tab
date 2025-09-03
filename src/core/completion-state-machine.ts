import { CompletionState, StateChangeListener } from '../types';

export class CompletionStateMachine {
  private state: CompletionState = CompletionState.IDLE;
  private listeners: StateChangeListener[] = [];

  getState(): CompletionState {
    return this.state;
  }

  onChange(listener: StateChangeListener) {
    this.listeners.push(listener);
  }

  private setState(next: CompletionState) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    for (const l of this.listeners) l(prev, next);
  }

  beginGenerate() {
    this.setState(CompletionState.GENERATING);
  }

  showVisible() {
    this.setState(CompletionState.VISIBLE);
  }

  startEditing() {
    this.setState(CompletionState.EDITING);
  }

  backToIdle() {
    this.setState(CompletionState.IDLE);
  }
}


