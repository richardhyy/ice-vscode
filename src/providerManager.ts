import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import { ChatMessage } from './chatHistoryManager';

export interface ProviderConfig {
  info: { [key: string]: string };
  secureVariables: { [key: string]: string | null };
  requiredVariables: { [key: string]: string | null };
  optionalVariables: { [key: string]: string | null };
}

export interface Provider {
  id: string;
  info: { [key: string]: string };
  getCompletion: (messageTrail: ChatMessage[], onStream: (partialText: string) => void, onCompletion: (finalText: string) => void) => Promise<string>;
  requestCancel: (requestId: string) => void;
}

function calculateProviderHash(providerCode: string, length: number): string {
  const hash = crypto.createHash('sha1');
  hash.update(providerCode);
  const fullHash = hash.digest('hex');
  const shortHash = fullHash.slice(0, length);
  return shortHash;
}

function generateUniqueRequestId(): string {
  return Math.random().toString(36).substring(2, 15);
}

const noticeForCustomProviders = `
Notice: Custom providers may execute arbitrary code and access your system.
Only use providers from trusted sources, and review the code before running.

Put your custom provider scripts (.js) in this directory.
`.trim();

export class ProviderManager {
  private builtInProviders = [
    'OpenAI_Compatible.js',
    'Claude.js',
    'Poe.js',
  ];
  private providers: {
    [key: string]:
    {
      config: any,
      child: child_process.ChildProcess | undefined,
    }
  } = {};
  private pendingRequests: Map<string, { onStream: (partialText: string) => void, onCompletion: (finalText: string) => void }> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    // Create custom provider directory if it doesn't exist
    const customProvidersDir = path.join(this.context.globalStorageUri.fsPath, 'providers');
    if (!fs.existsSync(customProvidersDir)) {
      // Recursively create the directory
      fs.mkdirSync(customProvidersDir, { recursive: true });
      vscode.window.showInformationMessage('Custom chat provider directory created at ' + customProvidersDir);

      const noticeFile = path.join(customProvidersDir, 'README.txt');
      fs.writeFileSync(noticeFile, noticeForCustomProviders);
    }
  }

  private async parseProviderConfig(code: string): Promise<ProviderConfig> {
    const headerStartIndex = code.indexOf('// ==FlowChatProvider==');
    const headerEndIndex = code.indexOf('// ==/FlowChatProvider==');
    if (headerStartIndex === -1 || headerEndIndex === -1) {
      return {
        info: {},
        secureVariables: {},
        requiredVariables: {},
        optionalVariables: {},
      };
    }

    let providerInfo: { [key: string]: string } = {};
    let secureVariables: { [key: string]: null } = {};  // There should not be default values for secure variables.
    let requiredVariables: { [key: string]: string | null } = {};
    let optionalVariables: { [key: string]: string | null } = {};
    
    const header = code.slice(headerStartIndex, headerEndIndex);
    const lines = header.split('\n');
    const variableLineRegex = /^\/\/ @(\w+) +([^=]+?)(?:=(.+))?$/;

    for (const line of lines) {
      const match = variableLineRegex.exec(line);
      if (!match) {
        continue;
      }
    
      // Extracted parts from the regex match
      const variableType = match[1];
      const variableName = match[2];
      let variableDefaultValue = match[3] || null; // Default to null if no value is present
    
      // Check if the default value includes the end-of-line comment marker and remove it
      if (variableDefaultValue && variableDefaultValue.endsWith('//')) {
        variableDefaultValue = variableDefaultValue.slice(0, -2).trim();
      }
    
      // Assign to the appropriate object based on the type
      if (variableType === 'variableSecure') {
        secureVariables[variableName] = null;
      } else if (variableType === 'variableRequired') {
        requiredVariables[variableName] = variableDefaultValue;
      } else if (variableType === 'variableOptional') {
        optionalVariables[variableName] = variableDefaultValue;
      } else {
        providerInfo[variableType] = match[2] || '';
      }
    }
      
    return {
      info: providerInfo,
      secureVariables: secureVariables,
      requiredVariables: requiredVariables,
      optionalVariables: optionalVariables,
    };
  }

  private getProviderId(providerPath: string, code: string, isBuiltIn: boolean): string {
    return path.basename(providerPath, '.js') + '@' + (isBuiltIn ? 'built-in' : calculateProviderHash(code, 8));
  }

  private getProviderPath(providerId: string): string {
    if (providerId.endsWith('@built-in')) {
      return path.join(__dirname, 'providers', providerId.slice(0, -'@built-in'.length) + '.js');
    } else {
      return path.join(this.context.globalStorageUri.fsPath, 'providers', providerId.split('@')[0] + '.js');
    }
  }

  private async loadProvidersFromDirectory(providersDir: string): Promise<void> {
    console.log('Loading providers from', providersDir);

    if (!fs.existsSync(providersDir)) {
      return;
    }

    const isBuiltInProvider = providersDir.startsWith(__dirname);
    const providerFiles = fs.readdirSync(providersDir);
    for (const file of providerFiles) {
      if (!file.endsWith('.js')) {
        continue;
      }

      const providerPath = path.join(providersDir, file);
      const providerCode = fs.readFileSync(providerPath, 'utf8');
      const providerId = this.getProviderId(providerPath, providerCode, isBuiltInProvider);

      if (this.providers[providerId]) {
        console.warn(`Provider already loaded: ${providerId}`);
        continue;
      }

      const providerConfig = await this.parseProviderConfig(providerCode);
      this.providers[providerId] = { config: providerConfig, child: undefined };
    }
  }

  private async promptForProviderConfig(providerId: string, variableName: string, defaultValue: string | null, password: boolean): Promise<string | undefined> {
    const providerEntry = this.providers[providerId];
    if (!providerEntry) {
      console.error(`Provider not found: ${providerId}`);
      return undefined;
    }

    return await vscode.window.showInputBox({ 
      prompt: `Enter value for ${variableName}\n${defaultValue ? `Default: ${defaultValue}` : ''}\n(Provider ID: ${providerId})`,
      value: defaultValue || '',
      password: password,
    });
  }

  public async loadProviders(): Promise<void> {
    // Load built-in providers
    await this.loadProvidersFromDirectory(path.join(__dirname, 'providers'));
    // Load user providers
    await this.loadProvidersFromDirectory(path.join(this.context.globalStorageUri.fsPath, 'providers'));

    console.log('Providers:', this.providers);
  }

  public async readProviderConfig(providerId: string): Promise<ProviderConfig> {
    const providerEntry = this.providers[providerId];
    if (!providerEntry) {
      console.error(`Provider not found: ${providerId}`);
      throw new Error(`Provider not found: ${providerId}`);
    }

    let config: ProviderConfig = providerEntry.config;
    if (!config) {
      const providerPath = this.getProviderPath(providerId);
      if (fs.existsSync(providerPath)) {
        const providerCode = fs.readFileSync(providerPath, 'utf8');
        config = await this.parseProviderConfig(providerCode);
        this.providers[providerId].config = config;
      }
    }

    const keyPrefix = providerId.split('@')[0] + '.';

    // Load config values from the global state
    const globalState = this.context.globalState;
    
    for (const key in config.secureVariables) {
      const value = await this.context.secrets.get(keyPrefix + key);
      if (value === undefined) {
        const inputValue = await this.promptForProviderConfig(providerId, key, config.secureVariables[key], true);
        if (inputValue === undefined) {
          throw new Error(`Required secure variable ${key} not provided for provider ${providerId}`);
        }
        config.secureVariables[key] = inputValue;
        this.context.secrets.store(keyPrefix + key, inputValue);
      } else {
        config.secureVariables[key] = value;
      }
    }

    for (const key in config.requiredVariables) {
      const value = globalState.get(keyPrefix + key) as string | undefined;
      if (value === undefined) {
        if (config.requiredVariables[key] !== null) { // Has a default value
          globalState.update(keyPrefix + key, config.requiredVariables[key]);
        } else {
          const inputValue = await this.promptForProviderConfig(providerId, key, config.requiredVariables[key], false);
          if (inputValue === undefined) {
            throw new Error(`Required variable ${key} not provided for provider ${providerId}`);
          }
          config.requiredVariables[key] = inputValue;
          globalState.update(keyPrefix + key, inputValue);
        }
      } else {
        config.requiredVariables[key] = value;
      }
    }

    for (const key in config.optionalVariables) {
      const value = globalState.get(keyPrefix + key) as string | undefined;
      if (value === undefined) {
        if (config.optionalVariables[key] !== null) { // Has a default value
          globalState.update(keyPrefix + key, config.optionalVariables[key]);
        } else {
          const inputValue = await this.promptForProviderConfig(providerId, key, config.optionalVariables[key], false);
          if (inputValue !== undefined) {
            config.optionalVariables[key] = inputValue;
            globalState.update(keyPrefix + key, inputValue);
          }
        }
      } else {
        config.optionalVariables[key] = value;
      }
    }

    return config;
  }

  private async initializeProvider(providerId: string, providerPath: string): Promise<void> {
    if (this.providers[providerId] && this.providers[providerId].child) {
      // Provider is already initialized or being initialized.
      console.warn(`Provider ${providerId} is already initialized or being initialized`);
      return;
    }

    console.log(`Initializing provider ${providerId} from ${providerPath}`);

    // Check if the provider script exists.
    if (!fs.existsSync(providerPath)) {
      console.error(`Provider script not found: ${providerPath}`);
      vscode.window.showErrorMessage(`Provider script not found: ${providerPath}`);
      return;
    }

    // Check variables
    const config = await this.readProviderConfig(providerId);
    this.providers[providerId].config = config;

    const child = child_process.fork(providerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        FLOWCHAT_PROVIDER_ID: providerId,
        FLOWCHAT_PROVIDER_CONFIG: JSON.stringify(config),
      },
    });
    child.stdout?.on('data', (data) => {
      console.log(`Provider ${providerId} stdout: ${data}`);
    });
    child.stderr?.on('data', (data) => {
      console.error(`Provider ${providerId} stderr: ${data}`);
      vscode.window.showErrorMessage(`Provider ${providerId} Error: ${data}`);
    });
    this.providers[providerId].child = child;

    // Set up communication with the child process.
    child.on('message', (message: any) => {
      if (message.type === 'stream') {
        const { requestId, partialText } = message;
        const request = this.pendingRequests.get(requestId);
        if (request) {
          request.onStream(partialText);
        }
      } else if (message.type === 'done') {
        const { requestId, finalText } = message;
        const request = this.pendingRequests.get(requestId);
        if (request) {
          request.onCompletion(finalText);
          this.pendingRequests.delete(requestId);
        }
      } else if (message.type === 'error') {
        const { requestId, error } = message;
        const request = this.pendingRequests.get(requestId);
        if (request) {
          request.onCompletion('');
          this.pendingRequests.delete(requestId);
          vscode.window.showErrorMessage(`Provider ${providerId} Error: ${error}`);
        }
      } else if (message.type === 'debug') {
        console.log(`Debug message from provider ${providerId}:`, message.content);
      }    
      // Handle other message types as needed.
    });

    child.on('error', (err) => {
      console.error(`Provider ${providerId} error:`, err);
      vscode.window.showErrorMessage(`Provider ${providerId} error: ${err}`);
    });

    child.on('exit', (code, signal) => {
      console.log(`Provider ${providerId} exited with code ${code} and signal ${signal}`);
      delete this.providers[providerId].child;
    });

    // Send an initialization message if needed, or perform provider-specific setup.
    child.send({ type: 'initialize', id: providerId });
  }

  public async getProviderById(providerId: string): Promise<Provider | undefined> {
    if (!this.providers[providerId]) {
      console.warn(`Provider not found: ${providerId}`);
      return undefined;
    }

    const { config } = this.providers[providerId];

    // Return a Provider interface that uses the existing or newly initialized child process.
    return {
      id: providerId,
      info: config.info,
      getCompletion: async (messageTrail: ChatMessage[], onStream: (partialText: string) => void, onCompletion: (finalText: string) => void) => {        
        if (!this.providers[providerId].child) {
          // Provider is not initialized. Assume providerId is the path to the script.
          let providerPath: string;
          if (providerId.endsWith('@built-in')) {
            // Built-in provider
            providerPath = path.join(__dirname, 'providers', providerId.slice(0, -'@built-in'.length) + '.js');
          } else {
            providerPath = path.join(this.context.globalStorageUri.fsPath, 'providers', providerId.split('@')[0] + '.js');
          }
          await this.initializeProvider(providerId, providerPath);
        }

        const { child } = this.providers[providerId];

        if (!child) {
          throw new Error(`Provider ${providerId} failed to initialize`);
        }

        const requestId = generateUniqueRequestId(); // Implement a function to generate a unique request ID
      
        this.pendingRequests.set(requestId, { onStream, onCompletion });
      
        child.send({ type: 'getCompletion', requestId, messageTrail, config });

        return requestId;
      },
      requestCancel: async (requestId: string) => {
        const { child } = this.providers[providerId];
        if (child) {
          child.send({ type: 'cancel', requestId });
        }
      }
    };
  }

  public async getProviderIds(): Promise<string[]> {
    // List all provider IDs, including built-in providers and those from the providers directory.
    let providerIds = this.builtInProviders.map(provider => path.basename(provider, '.js') + '@built-in');

    const providersDir = path.join(this.context.globalStorageUri.fsPath, 'providers');
    if (fs.existsSync(providersDir)) {
      const providerFiles = fs.readdirSync(providersDir).filter(file => file.endsWith('.js'));
      providerIds = providerIds.concat(providerFiles.map(file => {
        return path.basename(file, '.js') + '@' + calculateProviderHash(fs.readFileSync(path.join(providersDir, file), 'utf8'), 8);
      }));
    }

    return providerIds;
  }

  public async openProviderConfig(providerId: string): Promise<void> {
    const providerEntry = this.providers[providerId];
    if (!providerEntry) {
      console.error(`Provider not found: ${providerId}`);
      return;
    }
  
    const config = await this.readProviderConfig(providerId);
  
    const configEntries = [
      ...Object.entries(config.secureVariables),
      ...Object.entries(config.requiredVariables),
      ...Object.entries(config.optionalVariables),
    ];
  
    const quickPickItems: vscode.QuickPickItem[] = [
      ...configEntries.map(([key, value]) => ({
        label: key,
        description: key in config.secureVariables ? (value && value.length > 0 ? '*****' : 'Not set') : (value || ''),
      })),
      { kind: vscode.QuickPickItemKind.Separator, label: '' },
      {
        label: 'Open Provider Script',
        description: 'Open the provider script for editing',
      },
    ];
  
    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: 'Select a config entry to edit or open the provider script',
    });
  
    if (selectedItem) {
      if (selectedItem.label === 'Open Provider Script') {
        await this.openProviderScript(providerId);
      } else {
        const [key, oldValue] = configEntries.find(([k]) => k === selectedItem.label)!;
        const isSecure = key in config.secureVariables;
  
        const newValue = await vscode.window.showInputBox({
          prompt: `Enter value for ${key}`,
          value: oldValue || '',
          password: isSecure,
        });
  
        if (newValue !== undefined) {
          if (isSecure) {
            config.secureVariables[key] = newValue;
            await this.context.secrets.store(providerId.split('@')[0] + '.' + key, newValue);
          } else if (key in config.requiredVariables) {
            config.requiredVariables[key] = newValue;
            await this.context.globalState.update(providerId.split('@')[0] + '.' + key, newValue);
          } else if (key in config.optionalVariables) {
            config.optionalVariables[key] = newValue;
            await this.context.globalState.update(providerId.split('@')[0] + '.' + key, newValue);
          }
        }
      }
    }
  }

  public async openProviderScript(providerId: string): Promise<void> {
    const providerPath = this.getProviderPath(providerId);
    if (fs.existsSync(providerPath)) {
      const doc = await vscode.workspace.openTextDocument(providerPath);
      await vscode.window.showTextDocument(doc);
    } else {
      vscode.window.showErrorMessage(`Provider script not found: ${providerPath}`);
    }
  }
}
