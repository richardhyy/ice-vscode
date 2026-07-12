import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import { ChatMessage } from './chatHistoryManager';
import { BUILT_IN_SUFFIX } from './constants';
import { VSCodeLMProvider } from './vscodeLmProvider';

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
  /** One-line help explaining the variable, shown in the config menu (@variableHelp). */
  help?: string;
  /**
   * Coupled edits: when this variable is *set* (to a non-empty value) in the
   * config menu, these other variables are set too (@variableImplies). Lets a
   * provider keep related settings coherent, e.g. typing a custom Base URL
   * implies switching the endpoint Preset to "Custom" so it actually takes effect.
   */
  implies?: { key: string; value: string }[];
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
 * A tool offered to the model. `name` is the model-facing identifier (a unique,
 * sanitized reference that maps back to a specific MCP server + tool); the
 * provider translates these into its own API's tool/function schema.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON schema describing the tool's parameters. */
  inputSchema: any;
}

/** A tool call the model emitted, reported back by a provider on completion. */
export interface ToolCall {
  /** Provider-issued id, used to match the eventual tool result back to the call. */
  id: string;
  /** The model-facing tool name (matches a ToolDefinition.name). */
  name: string;
  /** Parsed argument object (or `{ _raw }` when the model emitted invalid JSON). */
  arguments: any;
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
  /** Tool calls the model emitted this turn (empty/absent when it produced text). */
  toolCalls?: ToolCall[];
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
  getCompletion: (messageTrail: ChatMessage[], configOverride: { [key: string]: string }, tools: ToolDefinition[],
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
    'VSCode_LM.js',
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
  private pendingRequests: Map<string, { onStream: (partialText: string, reasoningText?: string) => void, onCompletion: (finalText: string, meta?: ProviderCompletionMeta) => void }> = new Map();
  private pendingOptionRequests: Map<string, { resolve: (options: ProviderOption[]) => void, reject: (error: Error) => void }> = new Map();

  /**
   * Handler for providers that run in the extension host instead of a forked
   * child process (declared via `@_runtime vscode-lm`). Kept as a single shared
   * instance so it can track in-flight requests for cancellation.
   */
  private readonly vscodeLm = new VSCodeLMProvider();

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
    // Free-form help text and coupled-edit hints are parsed separately: their
    // payload can contain '=' (URLs, target=value), which the generic key=value
    // regex above would mis-split.
    const helpLineRegex = /^\/\/ @variableHelp +(\S+) +(.+)$/;
    const impliesLineRegex = /^\/\/ @variableImplies +(\S+) +(\S+?)=(.*)$/;

    for (const line of lines) {
      const helpMatch = helpLineRegex.exec(line);
      if (helpMatch) {
        optionMetaFor(helpMatch[1].trim()).help = helpMatch[2].trim();
        continue;
      }

      const impliesMatch = impliesLineRegex.exec(line);
      if (impliesMatch) {
        const meta = optionMetaFor(impliesMatch[1].trim());
        (meta.implies || (meta.implies = [])).push({ key: impliesMatch[2].trim(), value: impliesMatch[3].trim() });
        continue;
      }

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

  /**
   * Resolves a provider's non-secret configuration defaults — the provider's
   * header defaults overlaid with any non-secret values the user has set in global
   * state — without prompting for anything and without ever reading secrets.
   *
   * Used to snapshot a provider's configuration into a conversation the moment it
   * is adopted, so the conversation carries its own values and is never silently
   * changed later when a global default is edited. Secrets are deliberately
   * excluded: they stay in secret storage and are looked up by provider id at
   * send time, never pinned into a chat file.
   */
  public async getNonSecretDefaults(providerID: string): Promise<{ [key: string]: string }> {
    const providerEntry = this.providers[providerID];
    if (!providerEntry) {
      return {};
    }

    let config: ProviderConfig = providerEntry.config;
    if (!config) {
      const providerPath = this.getProviderPath(providerID);
      if (!fs.existsSync(providerPath)) {
        return {};
      }
      config = await this.parseProviderConfig(fs.readFileSync(providerPath, 'utf8'));
      providerEntry.config = config;
    }

    const keyPrefix = providerID.split('@')[0] + '.';
    const globalState = this.context.globalState;
    const defaults: { [key: string]: string } = {};

    // Only required + optional variables are snapshotted. Each resolves to the
    // user's global value if set, otherwise the provider's header default.
    const collect = (vars: { [key: string]: string | null }) => {
      for (const key in vars) {
        const stored = globalState.get(keyPrefix + key) as string | undefined;
        const value = stored !== undefined && stored !== null ? stored : vars[key];
        if (value !== undefined && value !== null && value !== '') {
          defaults[key] = value;
        }
      }
    };
    collect(config.requiredVariables);
    collect(config.optionalVariables);

    return defaults;
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
        const { requestID, finalText, model, usage, metadata, toolCalls } = message;
        const request = this.pendingRequests.get(requestID);
        if (request) {
          request.onCompletion(finalText, { model, usage, extra: metadata, toolCalls });
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

    // Some providers run in the extension host rather than a forked child
    // process. They declare this in their header (`@_runtime <name>`), which is
    // parsed into `config.info._runtime`. The VS Code language model provider
    // uses this because `vscode.lm` is only available in the extension host.
    if (config && config.info && config.info['_runtime'] === 'vscode-lm') {
      return this.buildVSCodeLMProvider(providerID, config);
    }

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
      getCompletion: async (messageTrail: ChatMessage[], configOverride: { [key: string]: string }, tools: ToolDefinition[],
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

        child.send({ type: 'getCompletion', requestID, messageTrail, config: mergedConfig, tools: tools || [] });

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

  /**
   * Builds a Provider for an in-process runtime backed by VS Code's language
   * model API. Configuration is resolved exactly like the child-process path
   * (stored values overlaid with inline overrides, with built-in system-prompt
   * variables filled), then handed to the shared {@link VSCodeLMProvider}. This
   * provider declares no secrets, so no key is ever requested.
   */
  private buildVSCodeLMProvider(providerID: string, config: ProviderConfig): Provider {
    return {
      id: providerID,
      info: config.info,
      configKeys: {
        secureVariables: Object.keys(config.secureVariables),
        requiredVariables: Object.keys(config.requiredVariables),
        optionalVariables: Object.keys(config.optionalVariables),
      },
      options: config.options || {},
      getCompletion: async (messageTrail: ChatMessage[], configOverride: { [key: string]: string }, tools: ToolDefinition[],
                            onStream: (partialText: string, reasoningText?: string) => void, onCompletion: (finalText: string, meta?: ProviderCompletionMeta) => void) => {
        const resolved = await this.readProviderConfig(providerID);
        let mergedConfig: { [key: string]: string | null } = {
          ...resolved.requiredVariables,
          ...resolved.optionalVariables,
          ...configOverride,
        };
        mergedConfig = this.fillSystemPromptWithEnvironmentVariables(mergedConfig);
        return this.vscodeLm.getCompletion(mergedConfig, messageTrail, tools || [], onStream, onCompletion);
      },
      listOptions: async (variableName: string, configOverride: { [key: string]: string } = {}) => {
        const resolved = await this.readProviderConfig(providerID);
        const mergedConfig = { ...resolved.requiredVariables, ...resolved.optionalVariables, ...configOverride };
        return this.vscodeLm.listOptions(variableName, mergedConfig);
      },
      requestCancel: (requestID: string) => {
        this.vscodeLm.requestCancel(requestID);
      },
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

  /**
   * Opens the provider configuration menu: a persistent QuickPick of the provider's
   * settings, grouped by kind (credentials / model & behaviour / advanced). Editing
   * a value keeps the menu open so several settings can be tuned in one pass, and
   * each row shows its current value plus a one-line explanation (from @variableHelp).
   *
   * These edits change the provider's *global* defaults (used for new conversations),
   * not the currently-open chat; the caller offers to sync any changes into the
   * current conversation afterwards. Returns the non-secret settings that changed
   * (key -> new value) so that offer can be made; secrets are stored but never returned.
   */
  public async openProviderConfig(providerID: string): Promise<{ [key: string]: string }> {
    const providerEntry = this.providers[providerID];
    if (!providerEntry) {
      console.error(`Provider not found: ${providerID}`);
      return {};
    }

    // Read the provider's declared config *without* prompting for missing values:
    // browsing settings shouldn't force an API-key entry. Non-secret values come
    // from global state (falling back to header defaults); secrets are only probed
    // for presence, never revealed.
    let config: ProviderConfig = providerEntry.config;
    if (!config) {
      const providerPath = this.getProviderPath(providerID);
      if (!fs.existsSync(providerPath)) {
        return {};
      }
      config = await this.parseProviderConfig(fs.readFileSync(providerPath, 'utf8'));
      providerEntry.config = config;
    }

    const prefix = providerID.split('@')[0] + '.';
    const globalState = this.context.globalState;
    const secrets = this.context.secrets;
    const optionsMeta = config.options || {};
    const changed: { [key: string]: string } = {};

    const hasOptions = (key: string): boolean => {
      const meta = optionsMeta[key];
      return !!meta && ((!!meta.suggestions && meta.suggestions.length > 0) || meta.dynamic === true);
    };

    // Current non-secret value: the user's global setting, else the header default.
    const currentValue = (key: string): string => {
      const stored = globalState.get(prefix + key) as string | undefined;
      if (stored !== undefined && stored !== null) {
        return String(stored);
      }
      const fallback = key in config.requiredVariables ? config.requiredVariables[key]
        : key in config.optionalVariables ? config.optionalVariables[key] : null;
      return fallback == null ? '' : String(fallback);
    };

    const secureKeys = Object.keys(config.secureVariables);
    const requiredKeys = Object.keys(config.requiredVariables);
    const optionalKeys = Object.keys(config.optionalVariables);
    const OPEN_SCRIPT = '__openScript';

    // Persists an edit to global state / secret storage and records non-secret
    // changes (plus any coupled edits declared via @variableImplies) so the
    // caller can offer to sync them into the current conversation.
    const applyEdit = async (key: string, value: string) => {
      if (key in config.secureVariables) {
        await secrets.store(prefix + key, value); // Secrets stay in secret storage; never reported.
        return;
      }
      await globalState.update(prefix + key, value);
      changed[key] = value;

      const implies = optionsMeta[key] && optionsMeta[key].implies;
      if (implies && value.trim().length > 0) {
        for (const rule of implies) {
          if (currentValue(rule.key) !== rule.value) {
            await globalState.update(prefix + rule.key, rule.value);
            changed[rule.key] = rule.value;
          }
        }
      }
    };

    type ConfigItem = vscode.QuickPickItem & { _key?: string; _action?: string };

    // Rebuilds the grouped item list, reflecting the latest stored values.
    const buildItems = async (): Promise<ConfigItem[]> => {
      const secureSet: { [key: string]: boolean } = {};
      await Promise.all(secureKeys.map(async (key) => { secureSet[key] = !!(await secrets.get(prefix + key)); }));

      const rowFor = (key: string): ConfigItem => {
        const isSecure = key in config.secureVariables;
        let description: string;
        if (isSecure) {
          description = secureSet[key] ? '••••••••' : 'Not set';
        } else {
          const value = currentValue(key);
          if (value.trim().length === 0) {
            description = 'Not set';
          } else {
            const oneLine = value.replace(/\s+/g, ' ').trim();
            description = oneLine.length > 60 ? oneLine.slice(0, 57) + '…' : oneLine;
          }
        }
        const help = optionsMeta[key] && optionsMeta[key].help;
        let detail: string | undefined;
        if (hasOptions(key)) {
          detail = '$(chevron-down) ' + (help || 'Choose from a list');
        } else if (help) {
          detail = help;
        }
        return { label: key, description, detail, _key: key };
      };

      const items: ConfigItem[] = [];
      const group = (label: string, keys: string[]) => {
        if (keys.length === 0) {
          return;
        }
        items.push({ kind: vscode.QuickPickItemKind.Separator, label });
        for (const key of keys) {
          items.push(rowFor(key));
        }
      };
      group('Credentials', secureKeys);
      group('Model & behaviour', requiredKeys);
      group('Advanced', optionalKeys);
      items.push({ kind: vscode.QuickPickItemKind.Separator, label: '' });
      items.push({ label: '$(go-to-file) Open Provider Script', description: 'Edit the raw provider code', _action: OPEN_SCRIPT });
      return items;
    };

    const quickPick = vscode.window.createQuickPick<ConfigItem>();
    quickPick.title = `Configure ${config.info['name'] || providerID}`;
    quickPick.placeholder = 'Edit a setting. Changes apply to new conversations';
    quickPick.ignoreFocusOut = true;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.items = await buildItems();

    let editing = false;       // true while a sub-editor is up, so its induced hide doesn't close the menu
    let openScriptAfter = false;
    let activeKey: string | null = null;

    await new Promise<void>((resolve) => {
      quickPick.onDidHide(() => {
        if (!editing) {
          resolve();
        }
      });

      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (!selected) {
          return;
        }
        if (selected._action === OPEN_SCRIPT) {
          openScriptAfter = true;
          resolve();
          return;
        }
        const key = selected._key;
        if (!key) {
          return; // separator or non-editable row
        }

        activeKey = key;
        const isSecure = key in config.secureVariables;

        editing = true;
        quickPick.hide(); // VS Code shows one input at a time; hide so the sub-editor is clean

        let newValue: string | undefined;
        if (!isSecure && hasOptions(key)) {
          // Offer a picked list (suggested values plus any the provider lists at
          // runtime), while still allowing a free-form custom value.
          newValue = await this.promptForOptionValue(providerID, key, currentValue(key), optionsMeta[key]);
        } else {
          newValue = await vscode.window.showInputBox({
            title: `Configure ${config.info['name'] || providerID}`,
            prompt: `Enter value for ${key}`,
            value: isSecure ? '' : currentValue(key),
            password: isSecure,
            ignoreFocusOut: true,
          });
        }

        if (newValue !== undefined) {
          await applyEdit(key, newValue);
        }

        // Return to the menu with the just-edited row still focused.
        quickPick.items = await buildItems();
        const restored = quickPick.items.find((item) => item._key === activeKey);
        if (restored) {
          quickPick.activeItems = [restored];
        }
        editing = false;
        quickPick.show();
      });

      quickPick.show();
    });

    quickPick.dispose();

    if (openScriptAfter) {
      await this.openProviderScript(providerID);
    }

    return changed;
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
