import { ChatAction } from "./chatHistoryManager";

/**
 * Tracks undo/redo history as a stack of action *groups*. A group is one logical
 * operation: a plain edit is a group of one action, while a compound operation
 * (pasting several messages, merging, deleting a selection) is a single group of
 * many actions. Undo/redo always operate on a whole group, so a single Ctrl+Z
 * reliably reverts an entire operation rather than one action at a time.
 */
export class UndoRedoManager {
  private undoStack: ChatAction[][] = [];
  private redoStack: ChatAction[][] = [];
  private currentGroup: ChatAction[] | null = null;

  /** Begins a transaction: subsequent actions accumulate into one group. */
  public beginGroup() {
    // Flush any dangling group defensively before starting a new one.
    this.endGroup();
    this.currentGroup = [];
  }

  /** Ends the current transaction, committing the accumulated group (if any). */
  public endGroup() {
    if (this.currentGroup) {
      if (this.currentGroup.length > 0) {
        this.undoStack.push(this.currentGroup);
        this.redoStack = [];
      }
      this.currentGroup = null;
    }
  }

  public pushAction(action: ChatAction) {
    if (this.currentGroup) {
      this.currentGroup.push(action);
    } else {
      this.undoStack.push([action]);
      this.redoStack = []; // A new action invalidates the redo history.
    }
  }

  /** Pops the most recent group for undoing. Actions are in application order. */
  public undo(): ChatAction[] | undefined {
    if (this.undoStack.length > 0) {
      const group = this.undoStack.pop()!;
      this.redoStack.push(group);
      return group;
    }
    return undefined;
  }

  /** Pops the most recent undone group for redoing. */
  public redo(): ChatAction[] | undefined {
    if (this.redoStack.length > 0) {
      const group = this.redoStack.pop()!;
      this.undoStack.push(group);
      return group;
    }
    return undefined;
  }
}
