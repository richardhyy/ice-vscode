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
  configKeys: {
    secureVariables: string[],
    requiredVariables: string[],
    optionalVariables: string[],
  };
  getCompletion: (messageTrail: ChatMessage[], configOverride: { [key: string]: string }, 
                  onStream: (partialText: string) => void, onCompletion: (finalText: string) => void) 
                  => Promise<string>;
  requestCancel: (requestID: string) => void;
}

function calculateProviderHash(providerCode: string, length: number): string {
  const hash = crypto.createHash('sha1');
  hash.update(providerCode);
  const fullHash = hash.digest('hex');
  const shortHash = fullHash.slice(0, length);
  return shortHash;
}

function generateUniqueRequestID(): string {
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
    'Gemini.js',
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

  private getProviderID(providerPath: string, code: string, isBuiltIn: boolean): string {
    return path.basename(providerPath, '.js') + '@' + (isBuiltIn ? 'built-in' : calculateProviderHash(code, 8));
  }

  private getProviderPath(providerID: string): string {
    if (providerID.endsWith('@built-in')) {
      return path.join(__dirname, 'providers', providerID.slice(0, -'@built-in'.length) + '.js');
    } else {
      return path.join(this.context.globalStorageUri.fsPath, 'providers', providerID.split('@')[0] + '.js');
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
      const providerID = this.getProviderID(providerPath, providerCode, isBuiltInProvider);

      if (this.providers[providerID]) {
        console.warn(`Provider already loaded: ${providerID}`);
        continue;
      }

      const providerConfig = await this.parseProviderConfig(providerCode);
      this.providers[providerID] = { config: providerConfig, child: undefined };
    }
  }

  private async promptForProviderConfig(providerID: string, variableName: string, defaultValue: string | null, password: boolean): Promise<string | undefined> {
    const providerEntry = this.providers[providerID];
    if (!providerEntry) {
      console.error(`Provider not found: ${providerID}`);
      return undefined;
    }

    return await vscode.window.showInputBox({ 
      prompt: `Enter value for ${variableName}\n${defaultValue ? `Default: ${defaultValue}` : ''}\n(Provider ID: ${providerID})`,
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

  public async readProviderConfig(providerID: string): Promise<ProviderConfig> {
    const providerEntry = this.providers[providerID];
    if (!providerEntry) {
      console.error(`Provider not found: ${providerID}`);
      throw new Error(`Provider not found: ${providerID}`);
    }

    let config: ProviderConfig = providerEntry.config;
    if (!config) {
      const providerPath = this.getProviderPath(providerID);
      if (fs.existsSync(providerPath)) {
        const providerCode = fs.readFileSync(providerPath, 'utf8');
        config = await this.parseProviderConfig(providerCode);
        this.providers[providerID].config = config;
      }
    }

    const keyPrefix = providerID.split('@')[0] + '.';

    // Load config values from the global state
    const globalState = this.context.globalState;
    
    for (const key in config.secureVariables) {
      const value = await this.context.secrets.get(keyPrefix + key);
      if (!value) {
        const inputValue = await this.promptForProviderConfig(providerID, key, config.secureVariables[key], true);
        if (!inputValue) {
          throw new Error(`Required secure variable ${key} not provided for provider ${providerID}`);
        }
        config.secureVariables[key] = inputValue;
        this.context.secrets.store(keyPrefix + key, inputValue);
      } else {
        config.secureVariables[key] = value;
      }
    }

    for (const key in config.requiredVariables) {
      const value = globalState.get(keyPrefix + key) as string | undefined;
      if (!value) {
        if (config.requiredVariables[key] !== null) { // Has a default value
          globalState.update(keyPrefix + key, config.requiredVariables[key]);
        } else {
          const inputValue = await this.promptForProviderConfig(providerID, key, config.requiredVariables[key], false);
          if (!inputValue) {
            throw new Error(`Required variable ${key} not provided for provider ${providerID}`);
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
      if (!value) {
        if (config.optionalVariables[key] !== null) { // Has a default value
          globalState.update(keyPrefix + key, config.optionalVariables[key]);
        }
      } else {
        config.optionalVariables[key] = value;
      }
    }

    return config;
  }

  private async initializeProvider(providerID: string, providerPath: string): Promise<void> {
    if (this.providers[providerID] && this.providers[providerID].child) {
      // Provider is already initialized or being initialized.
      console.warn(`Provider ${providerID} is already initialized or being initialized`);
      return;
    }

    console.log(`Initializing provider ${providerID} from ${providerPath}`);

    // Check if the provider script exists.
    if (!fs.existsSync(providerPath)) {
      console.error(`Provider script not found: ${providerPath}`);
      vscode.window.showErrorMessage(`Provider script not found: ${providerPath}`);
      return;
    }

    // Check variables
    const config = await this.readProviderConfig(providerID);
    this.providers[providerID].config = config;

    const child = child_process.fork(providerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        FLOWCHAT_PROVIDER_ID: providerID,
        FLOWCHAT_PROVIDER_CONFIG: JSON.stringify(config),
      },
    });
    child.stdout?.on('data', (data) => {
      console.log(`Provider ${providerID} stdout: ${data}`);
    });
    child.stderr?.on('data', (data) => {
      console.error(`Provider ${providerID} stderr: ${data}`);
      vscode.window.showErrorMessage(`Provider ${providerID} Error: ${data}`);
    });
    this.providers[providerID].child = child;

    // Set up communication with the child process.
    child.on('message', (message: any) => {
      if (message.type === 'stream') {
        const { requestID, partialText } = message;
        const request = this.pendingRequests.get(requestID);
        if (request) {
          request.onStream(partialText);
        }
      } else if (message.type === 'done') {
        const { requestID, finalText } = message;
        const request = this.pendingRequests.get(requestID);
        if (request) {
          request.onCompletion(finalText);
          this.pendingRequests.delete(requestID);
        }
      } else if (message.type === 'error') {
        const { requestID, error } = message;
        const request = this.pendingRequests.get(requestID);
        if (request) {
          request.onCompletion('');
          this.pendingRequests.delete(requestID);
          vscode.window.showErrorMessage(`Provider ${providerID} Error: ${error}`);
        }
      } else if (message.type === 'debug') {
        console.log(`Debug message from provider ${providerID}:`, message.content);
      }    
      // Handle other message types as needed.
    });

    child.on('error', (err) => {
      console.error(`Provider ${providerID} error:`, err);
      vscode.window.showErrorMessage(`Provider ${providerID} error: ${err}`);
    });

    child.on('exit', (code, signal) => {
      console.log(`Provider ${providerID} exited with code ${code} and signal ${signal}`);
      delete this.providers[providerID].child;
    });

    // Send an initialization message if needed, or perform provider-specific setup.
    child.send({ type: 'initialize', id: providerID });
  }

  public async getProviderByID(providerID: string): Promise<Provider | undefined> {
    if (!this.providers[providerID]) {
      console.warn(`Provider not found: ${providerID}`);
      return undefined;
    }

    let { config } = this.providers[providerID];

    // Return a Provider interface that uses the existing or newly initialized child process.
    return {
      id: providerID,
      info: config.info,
      configKeys: {
        secureVariables: Object.keys(config.secureVariables),
        requiredVariables: Object.keys(config.requiredVariables),
        optionalVariables: Object.keys(config.optionalVariables),
      },
      getCompletion: async (messageTrail: ChatMessage[], configOverride: { [key: string]: string },
                            onStream: (partialText: string) => void, onCompletion: (finalText: string) => void) => {        
        if (!this.providers[providerID].child) {
          // Provider is not initialized. Assume providerID is the path to the script.
          let providerPath: string;
          if (providerID.endsWith('@built-in')) {
            // Built-in provider
            providerPath = path.join(__dirname, 'providers', providerID.slice(0, -'@built-in'.length) + '.js');
          } else {
            providerPath = path.join(this.context.globalStorageUri.fsPath, 'providers', providerID.split('@')[0] + '.js');
          }
          await this.initializeProvider(providerID, providerPath);
        }

        const { child } = this.providers[providerID];

        if (!child) {
          throw new Error(`Provider ${providerID} failed to initialize`);
        }

        const requestID = generateUniqueRequestID(); // Implement a function to generate a unique request ID
      
        this.pendingRequests.set(requestID, { onStream, onCompletion });

        // Reload the config. This also prompts for missing variables.
        config = await this.readProviderConfig(providerID);

        // Merge the config with the override
        let mergedConfig = { ...config.secureVariables, ...config.requiredVariables, ...config.optionalVariables, ...configOverride };
      
        child.send({ type: 'getCompletion', requestID, messageTrail, config: mergedConfig });

        return requestID;
      },
      requestCancel: async (requestID: string) => {
        const { child } = this.providers[providerID];
        if (child) {
          child.send({ type: 'cancel', requestID });
        }
      }
    };
  }

  public async getProviderIDs(): Promise<string[]> {
    // List all provider IDs, including built-in providers and those from the providers directory.
    let providerIDs = this.builtInProviders.map(provider => path.basename(provider, '.js') + '@built-in');

    const providersDir = path.join(this.context.globalStorageUri.fsPath, 'providers');
    if (fs.existsSync(providersDir)) {
      const providerFiles = fs.readdirSync(providersDir).filter(file => file.endsWith('.js'));
      providerIDs = providerIDs.concat(providerFiles.map(file => {
        return path.basename(file, '.js') + '@' + calculateProviderHash(fs.readFileSync(path.join(providersDir, file), 'utf8'), 8);
      }));
    }

    return providerIDs;
  }

  public async openProviderConfig(providerID: string): Promise<void> {
    const providerEntry = this.providers[providerID];
    if (!providerEntry) {
      console.error(`Provider not found: ${providerID}`);
      return;
    }
  
    const config = await this.readProviderConfig(providerID);
  
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
        await this.openProviderScript(providerID);
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
            await this.context.secrets.store(providerID.split('@')[0] + '.' + key, newValue);
          } else if (key in config.requiredVariables) {
            config.requiredVariables[key] = newValue;
            await this.context.globalState.update(providerID.split('@')[0] + '.' + key, newValue);
          } else if (key in config.optionalVariables) {
            config.optionalVariables[key] = newValue;
            await this.context.globalState.update(providerID.split('@')[0] + '.' + key, newValue);
          }
        }
      }
    }
  }

  public async openProviderScript(providerID: string): Promise<void> {
    const providerPath = this.getProviderPath(providerID);
    if (fs.existsSync(providerPath)) {
      const doc = await vscode.workspace.openTextDocument(providerPath);
      await vscode.window.showTextDocument(doc);
    } else {
      vscode.window.showErrorMessage(`Provider script not found: ${providerPath}`);
    }
  }
}
