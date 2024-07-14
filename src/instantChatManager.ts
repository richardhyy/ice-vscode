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

  public createNewInstantChat(): string {
    const chatFilePath = this.generateNewChatFilePath();
    fs.writeFileSync(chatFilePath, '');
    return chatFilePath;
  }

  public getLastInstantChat(): string | undefined {
    return this.getLastChatFilePath();
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
    const files = fs.readdirSync(this.getInstantChatFolder())
                    .filter(file => file.endsWith('.chat') && !file.startsWith('.'));
    if (files.length === 0) {
      return undefined;
    }
    
    // Sort files based on their date-time values
    files
      .sort((a, b) => {
        const dateA = this.extractDateFromFilename(a);
        const dateB = this.extractDateFromFilename(b);
        return dateB.getTime() - dateA.getTime(); // Sort in descending order
      });
  
    return path.join(this.getInstantChatFolder(), files[0]); // Return the first (latest) file
  }

  private extractDateFromFilename(filename: string): Date {
    const [year, month, day, hour, minute, second] = filename.split('.')[0].split('-').map(Number);
    return new Date(year, month - 1, day, hour, minute, second);
  }
}
