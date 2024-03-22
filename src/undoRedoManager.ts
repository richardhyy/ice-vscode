import { ChatAction } from "./chatHistoryManager";

export class UndoRedoManager {
  private undoStack: ChatAction[] = [];
  private redoStack: ChatAction[] = [];

  public pushAction(action: ChatAction) {
    this.undoStack.push(action);
    this.redoStack = []; // Clear the redo stack when a new action is performed
  }

  public undo(): ChatAction | undefined {
    if (this.undoStack.length > 0) {
      const action = this.undoStack.pop();
      this.redoStack.push(action!);
      return action;
    }
    return undefined;
  }

  public redo(): ChatAction | undefined {
    if (this.redoStack.length > 0) {
      const action = this.redoStack.pop();
      this.undoStack.push(action!);
      return action;
    }
    return undefined;
  }
}
