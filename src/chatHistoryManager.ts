import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { UndoRedoManager } from './undoRedoManager';
import { ROLE_HEAD } from './constants';

export interface Attachment {
  id: number;
  name: string;
  url: string;  // Can be a local or remote URL, or a `data:` URL
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | '#config' | '#head' | string;
  content: string;
  attachments?: Attachment[];
  customFields?: Record<string, any>;
  parentID: number | null;
  timestamp: string;
}

export interface ChatAction {
  action: 'Add' | 'Edit' | 'Delete' | string;
  [key: string]: any;
}

function deepEqual(x: any, y: any): boolean {
  const ok = Object.keys, tx = typeof x, ty = typeof y;
  return x && y && tx === 'object' && tx === ty ? (
    ok(x).length === ok(y).length &&
      ok(x).every(key => deepEqual(x[key], y[key]))
  ) : (x === y);
}

export class ChatHistoryManager {
  private chatFilePath: string;
  private actionQueue: ChatAction[] = [];
  private flushChain: Promise<void> = Promise.resolve();
  private undoRedoManager = new UndoRedoManager();

  constructor(chatFilePath: string) {
    this.chatFilePath = chatFilePath;
  }

  public async addMessage(message: ChatMessage, flush: boolean = true): Promise<void> {
    const action: ChatAction = {
      action: 'Add',
      ...message,
    };
    this.enqueueAction(action, flush);
  }

  public async editMessage(messageID: number, updates: Partial<ChatMessage>, flush: boolean = true): Promise<void> {
    const action: ChatAction = {
      action: 'Edit',
      id: messageID,
      ...updates,
      timestamp: new Date().toISOString(),
    };
    this.enqueueAction(action, flush);
  }

  public async deleteMessage(messageID: number, flush: boolean = true): Promise<void> {
    const action: ChatAction = {
      action: 'Delete',
      id: messageID,
      timestamp: new Date().toISOString(),
    };
    this.enqueueAction(action, flush);
  }

  public async loadActionHistory(): Promise<ChatAction[]> {
    if (!fs.existsSync(this.chatFilePath)) {
      return [];
    }

    const fileContent = await fs.promises.readFile(this.chatFilePath, 'utf-8');
    let actions = (yaml.load(fileContent) as ChatAction[]) || [];

    // Check if the head exists, if not insert it
    if (actions.length === 0 || !actions[0].role || actions[0].role !== ROLE_HEAD) {
      actions = await this.insertHead(actions);
    }

    return actions;
  }

  /**
   * Drains the pending action queue to disk. Writes are serialized (so appends
   * never race) and the returned promise resolves only once everything queued so
   * far has been written — letting callers such as undo safely read the file next.
   */
  public flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.drainQueue());
    return this.flushChain;
  }

  private async drainQueue(): Promise<void> {
    while (this.actionQueue.length > 0) {
      const actionsToWrite = this.actionQueue;
      this.actionQueue = [];
      await this.writeActions(actionsToWrite);
    }
  }

  public async undo(): Promise<ChatAction[] | undefined> {
    const group = this.undoRedoManager.undo();
    if (group && group.length > 0) {
      await this.flush();

      const fileContent = await fs.promises.readFile(this.chatFilePath, 'utf-8');
      const actions = (yaml.load(fileContent) as ChatAction[]) || [];

      // A group's actions are the last N actions of the file, in application
      // order. Remove them from the tail (reverse order), verifying each match
      // so we never corrupt the file if something unexpected is there.
      for (let i = group.length - 1; i >= 0; i--) {
        if (actions.length > 0 && deepEqual(actions[actions.length - 1], group[i])) {
          actions.pop();
        } else {
          console.error('Undo action mismatch; aborting undo');
          return undefined;
        }
      }

      await fs.promises.writeFile(this.chatFilePath, yaml.dump(actions), 'utf-8');
      return actions;
    } else {
      return undefined;
    }
  }

  public async redo(): Promise<ChatAction[] | undefined> {
    const group = this.undoRedoManager.redo();
    if (group && group.length > 0) {
      // Re-apply the whole group as one unit (bypassing the undo/redo manager,
      // which already moved the group back onto the undo stack).
      await this.flush();
      this.actionQueue.push(...group);
      await this.flush();
      return group;
    }

    return undefined;
  }

  /** Begins an undo transaction so a compound operation reverts as one step. */
  public beginTransaction(): void {
    this.undoRedoManager.beginGroup();
  }

  /** Ends the current undo transaction. */
  public endTransaction(): void {
    this.undoRedoManager.endGroup();
  }

  private enqueueAction(action: ChatAction, flush: boolean = true) {
    const existingActionIndex = this.actionQueue.findIndex(
      (queuedAction) => queuedAction.id === action.id && queuedAction.action === action.action
    );

    if (existingActionIndex !== -1) {
      this.actionQueue[existingActionIndex] = action;
    } else {
      this.actionQueue.push(action);
    }

    this.undoRedoManager.pushAction(action);

    if (flush) {
      void this.flush();
    }
  }

  private async writeActions(actions: ChatAction[]): Promise<void> {
    const yamlContent = yaml.dump(actions);
    await fs.promises.appendFile(this.chatFilePath, yamlContent, 'utf-8');
  }

  private async insertHead(actions: ChatAction[]): Promise<ChatAction[]> {
    console.log('Inserting head to the chat history');

    const originalActions = [...actions];

    const fileCreationTime = fs.statSync(this.chatFilePath).birthtime.toISOString();

    const headAction: ChatAction = {
      action: 'Add',
      id: 1,
      role: ROLE_HEAD,
      content: JSON.stringify({
        version: '1.1',
        createdAt: fileCreationTime,
        comment: 'This is the head of the chat history file. Do not modify it.'
      }),
      parentID: null,
      timestamp: new Date().toISOString(),
    };

    // Insert the head action at the beginning
    actions.unshift(headAction);
    const headID = headAction.id;

    // Scan the rest of the actions to update the parentID if null
    for (let i = 1; i < actions.length; i++) {
      if (actions[i].id === headID) {
        console.error('Head ID is already taken by another action');
        return originalActions;
      }

      if (actions[i].parentID === null) {
        console.log(`Updating parentID of action ${actions[i].id} to ${headID} (head)`);
        actions[i].parentID = headID;
      }
    }

    if (actions.length > 1) {
      // Backup the original file
      const backupFilePath = this.chatFilePath + '.bak';
      await fs.promises.copyFile(this.chatFilePath, backupFilePath);
    }

    await fs.promises.writeFile(this.chatFilePath, yaml.dump(actions), 'utf-8');

    return actions;
  }
}
