import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigurationValue } from './extension';

export class InstantChatManager {
  private internalInstantChatFolder: string;

  constructor(private context: vscode.ExtensionContext) {
    this.internalInstantChatFolder = path.join(this.context.globalStorageUri.fsPath, 'instantchat');
    if (!fs.existsSync(this.internalInstantChatFolder)) {
      fs.mkdirSync(this.internalInstantChatFolder, { recursive: true });
    }
  }

  public getInstantChatFolder(): string {
    const instantChatFolder = getConfigurationValue<string>('instantChatSessionFolder') || this.internalInstantChatFolder;
    if (!fs.existsSync(instantChatFolder)) {
      fs.mkdirSync(instantChatFolder, { recursive: true });
    }
    return instantChatFolder;
  }

  private generateNewChatFilePath(): string {
    // ./instantchat/<year>-<month>-<day>-<hour>-<minute>-<second>.chat
    const now = new Date();
    return path.join(
      this.getInstantChatFolder(),
      `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}.chat`
    );
  }

  private getLastChatFilePath(): string | undefined {
    const files = fs.readdirSync(this.getInstantChatFolder());
    if (files.length === 0) {
      return undefined;
    }
    files.sort();
    return path.join(this.getInstantChatFolder(), files[files.length - 1]);
  }

  public createNewInstantChat(): string {
    const chatFilePath = this.generateNewChatFilePath();
    fs.writeFileSync(chatFilePath, '');
    return chatFilePath;
  }

  public getLastInstantChat(): string | undefined {
    return this.getLastChatFilePath();
  }
}
