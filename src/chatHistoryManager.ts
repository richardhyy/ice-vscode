import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { UndoRedoManager } from './undoRedoManager';

export interface ChatMessage {
  id: number;
  role: string;
  content: string;
  provider: string;
  customFields?: Record<string, any>;
  parentID: number | null;
  timestamp: string;
}

export interface ChatConfig {
  [key: string]: any;
}

export interface ChatAction {
  action: string;
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
  private isWriting = false;
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

  public async editMessage(messageId: number, updates: Partial<ChatMessage>, flush: boolean = true): Promise<void> {
    const action: ChatAction = {
      action: 'Edit',
      id: messageId,
      ...updates,
      timestamp: new Date().toISOString(),
    };
    this.enqueueAction(action, flush);
  }

  public async deleteMessage(messageId: number, flush: boolean = true): Promise<void> {
    const action: ChatAction = {
      action: 'Delete',
      id: messageId,
      timestamp: new Date().toISOString(),
    };
    this.enqueueAction(action, flush);
  }

  public async updateConfig(config: ChatConfig, flush: boolean = true): Promise<void> {
    const action: ChatAction = {
      action: 'ConfigUpdate',
      config,
      timestamp: new Date().toISOString(),
    };
    this.enqueueAction(action, flush);
  }

  public async loadActionHistory(): Promise<ChatAction[]> {
    if (!fs.existsSync(this.chatFilePath)) {
      return [];
    }

    const fileContent = await fs.promises.readFile(this.chatFilePath, 'utf-8');
    const actions = yaml.load(fileContent) as ChatAction[];
    return actions || [];
  }

  public async flush(): Promise<void> {
    if (!this.isWriting && this.actionQueue.length > 0) {
      this.isWriting = true;
      const actionsToWrite = [...this.actionQueue];
      this.actionQueue = [];
      await this.writeActions(actionsToWrite);
      this.isWriting = false;
    }
  }

  public async undo(): Promise<ChatAction[] | undefined> {
    const action = this.undoRedoManager.undo();
    if (action) {
      await this.flush();

      const fileContent = await fs.promises.readFile(this.chatFilePath, 'utf-8');
      const actions = yaml.load(fileContent) as ChatAction[];

      if (deepEqual(actions[actions.length - 1], action)) {
        actions.pop();
        await fs.promises.writeFile(this.chatFilePath, yaml.dump(actions), 'utf-8');
      } else {
        console.error('Action mismatch');
        return undefined;
      }

      return actions;
    } else {
      return undefined;
    }
  }

  public async redo(): Promise<ChatAction | undefined> {
    const action = this.undoRedoManager.redo();
    if (action) {
      this.enqueueAction(action, true);
    }

    return action;
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

    if (flush && !this.isWriting) {
      this.flush();
    }

    this.undoRedoManager.pushAction(action);
  }

  private async writeActions(actions: ChatAction[]): Promise<void> {
    const yamlContent = yaml.dump(actions);
    await fs.promises.appendFile(this.chatFilePath, yamlContent, 'utf-8');
  }
}
