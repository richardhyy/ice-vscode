import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import { ChatMessage } from './chatHistoryManager';
import { BUILT_IN_SUFFIX } from './constants';

/**
 * Describes the selectable options a provider exposes for a config variable.
 * A variable may offer a list of `suggestions` (hints, not a hard constraint —
 * a custom value is always allowed), be `dynamic` (the provider can list options
 * at runtime, e.g. querying an API for available models), and/or be flagged as a
 * `quick` option surfaced in the composer's quick-tune bar. All fields are
 * optional and independently combinable.
 */
export interface ProviderOptionMeta {
  suggestions?: string[];
  dynamic?: boolean;
  quick?: boolean;
}

/** A single selectable option value, optionally with a friendlier label/detail. */
export interface ProviderOption {
  value: string;
  label?: string;
  detail?: string;
}

export interface ProviderConfig {
  info: { [key: string]: string };
  secureVariables: { [key: string]: string | null };
  requiredVariables: { [key: string]: string | null };
  optionalVariables: { [key: string]: string | null };
  /** Per-variable option metadata (suggested values, dynamic listing, quick-tune). */
  options: { [key: string]: ProviderOptionMeta };
}

/** Token usage a provider may report on completion (all fields optional). */
export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Metadata a provider may optionally attach to a completed response. Everything
 * here is optional: `model` and `usage` get first-class display, while `extra`
 * lets a provider store any additional fields it wants to surface later.
 */
export interface ProviderCompletionMeta {
  model?: string;
  usage?: ProviderUsage;
  extra?: Record<string, any>;
  /** Present when the request failed; recorded on the reply so the error persists. */
  error?: string;
}

export interface Provider {
  id: string;
  info: { [key: string]: string };
  configKeys: {
    secureVariables: string[],
    requiredVariables: string[],
    optionalVariables: string[],
  };
  /** Per-variable option metadata, surfaced to the webview for suggestion/quick UIs. */
  options: { [key: string]: ProviderOptionMeta };
  getCompletion: (messageTrail: ChatMessage[], configOverride: { [key: string]: string }, 
                  onStream: (partialText: string, reasoningText?: string) => void, onCompletion: (finalText: string, meta?: ProviderCompletionMeta) => void) 
                  => Promise<string>;
  /** Asks the provider to list selectable option values for a config variable. */
  listOptions: (variableName: string, configOverride?: { [key: string]: string }) => Promise<ProviderOption[]>;
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

const environmentVariableFunctions = new Map<string, () => string>([
  ['TIME_NOW', () => new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })],
  ['TIME_NOW_12H', () => new Date().toLocaleTimeString([], { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })],
  ['DATE_TODAY', () => new Date().toISOString().split('T')[0]],
  ['DATE_TODAY_SHORT', () => new Date().toLocaleDateString([], { month: '2-digit', day: '2-digit', year: '2-digit' })],
  ['DATE_TODAY_LONG', () => new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })],
]);

export class ProviderManager {
  private builtInProviders = [
    'OpenAI_Compatible.js',
    'Claude.js',
    'Gemini.js',
    'Poe.js',
    'Zhipu.js',
  ];
  private providers: {
    [key: string]:
    {
      config: any,
      child: child_process.ChildProcess | undefined,
    }
  } = {};
  private pendingRequests: Map<string, { onStream: (partialText: string, reasoningText?: string) => void, onCompletion: (finalText: string, meta?: ProviderCompletionMeta) => void }> = new Map();
  private pendingOptionRequests: Map<string, { resolve: (options: ProviderOption[]) => void, reject: (error: Error) => void }> = new Map();

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
    const headerStartIndex = code.indexOf('// ==ICEProvider==');
    const headerEndIndex = code.indexOf('// ==/ICEProvider==');
    if (headerStartIndex === -1 || headerEndIndex === -1) {
      return {
        info: {},
        secureVariables: {},
        requiredVariables: {},
        optionalVariables: {},
        options: {},
      };
    }

    let providerInfo: { [key: string]: string } = {};
    let secureVariables: { [key: string]: null } = {};  // There should not be default values for secure variables.
    let requiredVariables: { [key: string]: string | null } = {};
    let optionalVariables: { [key: string]: string | null } = {};
    let options: { [key: string]: ProviderOptionMeta } = {};

    /** Lazily fetches (creating if needed) the option metadata for a variable. */
    const optionMetaFor = (name: string): ProviderOptionMeta => {
      if (!options[name]) {
        options[name] = {};
      }
      return options[name];
    };
    
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
      } else if (variableType === 'variableSuggest') {
        // Suggested values (a hint, not a hard limit), comma-separated (blanks dropped).
        optionMetaFor(variableName.trim()).suggestions = (variableDefaultValue || '')
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
      } else if (variableType === 'variableDynamic') {
        // The provider can list options at runtime (e.g. available models).
        optionMetaFor(variableName.trim()).dynamic = true;
      } else if (variableType === 'quickOption') {
        // Surface this variable in the composer's quick-tune bar.
        optionMetaFor(variableName.trim()).quick = true;
      } else {
        providerInfo[variableType] = match[2] || '';
      }
    }
      
    return {
      info: providerInfo,
      secureVariables: secureVariables,
      requiredVariables: requiredVariables,
      optionalVariables: optionalVariables,
      options: options,
    };
  }

  private getProviderID(providerPath: string, code: string, isBuiltIn: boolean): string {
    return path.basename(providerPath, '.js') + (isBuiltIn ? BUILT_IN_SUFFIX : '@' + calculateProviderHash(code, 8));
  }

  private getProviderPath(providerID: string): string {
    if (providerID.endsWith(BUILT_IN_SUFFIX)) {
      return path.join(__dirname, 'providers', providerID.slice(0, -BUILT_IN_SUFFIX.length) + '.js');
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
      ignoreFocusOut: true,
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
        ICE_PROVIDER_ID: providerID,
        ICE_PROVIDER_CONFIG: JSON.stringify(config),
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
        const { requestID, partialText, reasoningText } = message;
        const request = this.pendingRequests.get(requestID);
        if (request) {
          request.onStream(partialText, reasoningText);
        }
      } else if (message.type === 'done') {
        const { requestID, finalText, model, usage, metadata } = message;
        const request = this.pendingRequests.get(requestID);
        if (request) {
          request.onCompletion(finalText, { model, usage, extra: metadata });
          this.pendingRequests.delete(requestID);
        }
      } else if (message.type === 'error') {
        const { requestID, error } = message;
        const request = this.pendingRequests.get(requestID);
        if (request) {
          // Surface the failure both ways: a transient notification *and* on the
          // reply itself (via the completion meta) so it is recorded in the chat
          // history instead of vanishing with the toast.
          request.onCompletion('', { error });
          this.pendingRequests.delete(requestID);
          vscode.window.showErrorMessage(`Provider ${providerID} Error: ${error}`);
        }
      } else if (message.type === 'options') {
        const { requestID, options } = message;
        const pending = this.pendingOptionRequests.get(requestID);
        if (pending) {
          this.pendingOptionRequests.delete(requestID);
          pending.resolve(Array.isArray(options) ? options : []);
        }
      } else if (message.type === 'optionsError') {
        const { requestID, error } = message;
        const pending = this.pendingOptionRequests.get(requestID);
        if (pending) {
          this.pendingOptionRequests.delete(requestID);
          pending.reject(new Error(error || 'Failed to list options'));
        }
      } else if (message.type === 'warning') {
        console.warn(`Warning message from provider ${providerID}:`, message.content);
        vscode.window.showWarningMessage(`Provider ${providerID} warning: ${message.content}`);
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
      options: config.options || {},
      getCompletion: async (messageTrail: ChatMessage[], configOverride: { [key: string]: string },
                            onStream: (partialText: string, reasoningText?: string) => void, onCompletion: (finalText: string, meta?: ProviderCompletionMeta) => void) => {        
        if (!this.providers[providerID].child) {
          // Provider is not initialized yet; resolve its script path and start it.
          await this.initializeProvider(providerID, this.getProviderPath(providerID));
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

        mergedConfig = this.fillSystemPromptWithEnvironmentVariables(mergedConfig);

        child.send({ type: 'getCompletion', requestID, messageTrail, config: mergedConfig });

        return requestID;
      },
      listOptions: async (variableName: string, configOverride: { [key: string]: string } = {}) => {
        if (!this.providers[providerID].child) {
          // Provider is not initialized yet; resolve its script path and start it.
          await this.initializeProvider(providerID, this.getProviderPath(providerID));
        }

        const { child } = this.providers[providerID];

        if (!child) {
          throw new Error(`Provider ${providerID} failed to initialize`);
        }

        // Reload the config (prompting for missing variables) so the provider has
        // what it needs to list options — e.g. an API key/host to query models.
        config = await this.readProviderConfig(providerID);
        const mergedConfig = { ...config.secureVariables, ...config.requiredVariables, ...config.optionalVariables, ...configOverride };

        const requestID = generateUniqueRequestID();
        return new Promise<ProviderOption[]>((resolve, reject) => {
          this.pendingOptionRequests.set(requestID, { resolve, reject });
          // Guard against a provider that never answers a listOptions request.
          const timer = setTimeout(() => {
            if (this.pendingOptionRequests.has(requestID)) {
              this.pendingOptionRequests.delete(requestID);
              reject(new Error(`Timed out listing options for ${variableName}`));
            }
          }, 20000);
          const settle = (fn: (arg: any) => void) => (arg: any) => {
            clearTimeout(timer);
            fn(arg);
          };
          this.pendingOptionRequests.set(requestID, {
            resolve: settle(resolve),
            reject: settle(reject),
          });
          child.send({ type: 'listOptions', requestID, variableName, config: mergedConfig });
        });
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
    let providerIDs = this.builtInProviders.map(provider => path.basename(provider, '.js') + BUILT_IN_SUFFIX);

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
    const optionsMeta = config.options || {};

    const hasOptions = (key: string): boolean => {
      const meta = optionsMeta[key];
      return !!meta && ((meta.suggestions && meta.suggestions.length > 0) || meta.dynamic === true);
    };
  
    const configEntries = [
      ...Object.entries(config.secureVariables),
      ...Object.entries(config.requiredVariables),
      ...Object.entries(config.optionalVariables),
    ];
  
    const quickPickItems: vscode.QuickPickItem[] = [
      ...configEntries.map(([key, value]) => ({
        label: key,
        description: key in config.secureVariables ? (value && value.length > 0 ? '*****' : 'Not set') : (value || ''),
        // A caret hints that this entry offers a list of values to pick from.
        detail: hasOptions(key) ? '$(chevron-down) Choose from a list' : undefined,
      })),
      { kind: vscode.QuickPickItemKind.Separator, label: '' },
      {
        label: 'Open Provider Script',
        description: 'Open the provider script for editing',
      },
    ];
  
    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: 'Select a config entry to edit or open the provider script',
      ignoreFocusOut: true,
    });
  
    if (selectedItem) {
      if (selectedItem.label === 'Open Provider Script') {
        await this.openProviderScript(providerID);
      } else {
        const [key, oldValue] = configEntries.find(([k]) => k === selectedItem.label)!;
        const isSecure = key in config.secureVariables;

        let newValue: string | undefined;
        if (!isSecure && hasOptions(key)) {
          // Offer a picked list (suggested values plus any the provider lists at
          // runtime), while still allowing a free-form custom value.
          newValue = await this.promptForOptionValue(providerID, key, oldValue || '', optionsMeta[key]);
        } else {
          newValue = await vscode.window.showInputBox({
            prompt: `Enter value for ${key}`,
            value: oldValue || '',
            password: isSecure,
            ignoreFocusOut: true,
          });
        }
  
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

  /**
   * Presents a QuickPick of selectable values for a config variable with
   * suggestions and/or dynamic listing. Suggested values are shown immediately;
   * for dynamic variables the provider is asked to list options (e.g. querying
   * available models), shown as they resolve. A "custom value" escape hatch is
   * always available. Returns the chosen value, or undefined if dismissed.
   */
  private async promptForOptionValue(providerID: string, key: string, currentValue: string, meta: ProviderOptionMeta): Promise<string | undefined> {
    const CUSTOM_LABEL = '$(edit) Enter a custom value\u2026';

    const buildItems = (values: ProviderOption[]): vscode.QuickPickItem[] => {
      const seen = new Set<string>();
      const items: vscode.QuickPickItem[] = [];
      for (const option of values) {
        if (!option || typeof option.value !== 'string' || seen.has(option.value)) {
          continue;
        }
        seen.add(option.value);
        items.push({
          label: option.value === currentValue ? `$(check) ${option.value}` : option.value,
          description: option.label,
          detail: option.detail,
        });
      }
      items.push({ kind: vscode.QuickPickItemKind.Separator, label: '' });
      items.push({ label: CUSTOM_LABEL, description: currentValue ? `Current: ${currentValue}` : undefined });
      return items;
    };

    const staticOptions: ProviderOption[] = (meta.suggestions || []).map((v) => ({ value: v }));

    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `Select ${key}`;
    quickPick.placeholder = currentValue ? `Current: ${currentValue}` : `Choose a value for ${key}`;
    quickPick.ignoreFocusOut = true;
    quickPick.matchOnDescription = true;
    quickPick.items = buildItems(staticOptions);

    if (meta.dynamic) {
      quickPick.busy = true;
      // Fetch runtime options in the background and merge them in when ready.
      (async () => {
        try {
          const provider = await this.getProviderByID(providerID);
          const dynamic = provider ? await provider.listOptions(key) : [];
          quickPick.items = buildItems([...dynamic, ...staticOptions]);
        } catch (e: any) {
          quickPick.items = buildItems(staticOptions);
          vscode.window.showWarningMessage(`Could not list ${key} options: ${e.message}`);
        } finally {
          quickPick.busy = false;
        }
      })();
    }

    const picked = await new Promise<vscode.QuickPickItem | undefined>((resolve) => {
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.show();
    });
    quickPick.hide();
    quickPick.dispose();

    if (!picked) {
      return undefined;
    }
    if (picked.label === CUSTOM_LABEL) {
      return await vscode.window.showInputBox({
        prompt: `Enter value for ${key}`,
        value: currentValue,
        ignoreFocusOut: true,
      });
    }
    // Strip the "$(check) " prefix from the currently-selected item's label.
    return picked.label.replace(/^\$\(check\)\s*/, '');
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

  private fillSystemPromptWithEnvironmentVariables(config: { [key: string]: string | null }): { [key: string]: string | null } {
    if (config['SystemPrompt']) {
      const systemPrompt = config['SystemPrompt']!;

      const filledSystemPrompt = systemPrompt.replace(/{{\s*([^\s]+)\s*}}/g, (match: any, variableName: string) => {
        const func = environmentVariableFunctions.get(variableName);
        if (func) {
          return func();
        } else {
          return match;
        }
      });
      return { ...config, 'SystemPrompt': filledSystemPrompt };
    }
    
    return config;
  }
}
