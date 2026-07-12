import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

/** A single argument's spec, as written in a tool's `arguments` object. */
export interface ToolArgumentSpec {
  type?: string;
  description?: string;
  optional?: boolean;
  enum?: any[];
  range?: [number, number];
  items?: any;
}

/** Static identity of a tool script, parsed from its header without running it. */
export interface ToolIdentity {
  /** How the tool is referenced (a built-in id, or a path). */
  source: string;
  name: string;
  description: string;
  /** True for a dynamic source (one script exposing many tools, e.g. an MCP bridge). */
  dynamic: boolean;
  /** VS Code setting key a tool reads its configuration from (`@config`), if any. */
  configKey?: string;
}

/** A resolved tool definition, ready to offer to the model. */
export interface ResolvedTool {
  name: string;
  description?: string;
  inputSchema: any;
  readOnly: boolean;
  /** Optional grouping label a dynamic source can attach (e.g. an MCP server id). */
  sourceLabel?: string;
  /** Optional friendly short name for display (e.g. an MCP tool's title). */
  title?: string;
}

/** The outcome of executing a tool. */
export interface ToolExecResult {
  content: string;
  isError: boolean;
  /** True when the call was stopped (by the user or a timeout) instead of completing. */
  stopped?: boolean;
  /** True when the stop was caused by the no-response timeout. */
  timedOut?: boolean;
}

/**
 * Optional capabilities a caller wires into a running tool call. These are ICE
 * tool capabilities offered uniformly to every tool; the tool receives them as
 * its `context` (signal / progress / elicit) and MCP is just one consumer.
 */
export interface ToolExecuteOptions {
  /** Aborts the call; relayed to the tool as `context.signal`. */
  signal?: AbortSignal;
  /** No-response timeout in ms (progress resets it, an open elicitation suspends it). */
  timeoutMs?: number;
  /** Receives the tool's progress updates. */
  onProgress?: (progress: { progress?: number; total?: number; message?: string }) => void;
  /** Handles a tool's elicitation request, resolving with the user's response. */
  onElicit?: (request: { elicitationID: string; message: string; schema: any }) => Promise<{ action: string; content?: any }>;
}

interface PendingRequest {
  source: string;
  resolve?: (value: any) => void;
  reject?: (error: Error) => void;
  onResult?: (message: any) => void;
  onError?: (error: string) => void;
  onProgress?: (progress: any) => void;
  onElicit?: (message: any) => void;
}

/**
 * Runs ICE tools — self-describing JavaScript scripts (see tools/fetch_url) — in
 * forked child processes via the shared harness (tools/_host.js). This is ICE's
 * native tool substrate: a tool is a script you can open, read, and edit, exactly
 * like a provider. MCP is not special here; it is just a (future) dynamic-source
 * tool script that speaks the same interface.
 *
 * Built-in tools live in the bundled tools/ folder; a conversation can also point
 * at a script by path (e.g. next to the .chat file), so an experiment can carry
 * its own tools.
 */
export class ToolManager {
  private children = new Map<string, child_process.ChildProcess>();
  private pending = new Map<string, PendingRequest>();
  private counter = 0;

  constructor(private context: vscode.ExtensionContext) {}

  /** Folder holding the bundled built-in tools and the harness (tools/_host.js). */
  private get builtinDir(): string {
    return path.join(__dirname, 'tools');
  }

  /** Lists the built-in tools by statically parsing their headers (no execution). */
  public listBuiltInTools(): ToolIdentity[] {
    const out: ToolIdentity[] = [];
    if (!fs.existsSync(this.builtinDir)) {
      return out;
    }
    for (const entry of fs.readdirSync(this.builtinDir)) {
      if (entry.startsWith('_') || entry.startsWith('.')) {
        continue;
      }
      const main = path.join(this.builtinDir, entry, 'main.js');
      if (!fs.existsSync(main)) {
        continue;
      }
      const header = this.parseToolHeader(fs.readFileSync(main, 'utf8'));
      out.push({ source: entry, name: header.name || entry, description: header.description || '', dynamic: header.dynamic, configKey: header.configKey });
    }
    return out;
  }

  /**
   * Resolves the enabled tool definitions for a source, connecting/introspecting
   * as needed: a single tool yields one definition (schema from its `arguments`),
   * a dynamic source yields whatever its `listTools` returns.
   */
  public async resolveToolDefinitions(source: string, chatDir: string | undefined): Promise<ResolvedTool[]> {
    const sourcePath = this.resolveSourcePath(source, chatDir);
    if (!sourcePath) {
      throw new Error(`Tool source not found: ${source}`);
    }

    const definition: any = await this.send(sourcePath, { type: 'introspect' });

    if (definition.isSource) {
      const tools: any[] = await this.send(sourcePath, { type: 'listTools', config: this.configForSource(sourcePath) });
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // A dynamic source may hand back a ready-made JSON schema (e.g. MCP tools);
        // otherwise compile ICE's friendly `arguments` shape.
        inputSchema: tool.inputSchema || this.argumentsToSchema(tool.arguments),
        readOnly: Boolean(tool.readOnly),
        sourceLabel: tool.sourceLabel,
        title: tool.title,
      }));
    }

    const header = this.parseToolHeader(fs.readFileSync(sourcePath, 'utf8'));
    return [{
      name: header.name || definition.name || path.basename(path.dirname(sourcePath)),
      description: header.description || definition.description,
      inputSchema: this.argumentsToSchema(definition.arguments),
      readOnly: Boolean(definition.readOnly),
    }];
  }

  /**
   * Executes a tool. `name` is only meaningful for dynamic sources (which tool to
   * call); a single-tool script ignores it. Failures come back as error results
   * rather than throwing, so the caller can record them on a tool-result node.
   *
   * `options` wires this call's live capabilities: a cancellation `signal`, a
   * `timeoutMs` for a silent tool (progress resets it, an open elicitation
   * suspends it), and `onProgress` / `onElicit` callbacks. A stopped or timed-out
   * call resolves with `stopped: true` (never an error), so the UI can present it
   * as a user choice rather than a failure.
   */
  public execute(source: string, name: string | null, args: any, chatDir: string | undefined, options: ToolExecuteOptions = {}): Promise<ToolExecResult> {
    const sourcePath = this.resolveSourcePath(source, chatDir);
    if (!sourcePath) {
      return Promise.resolve({ content: `Tool source not found: ${source}`, isError: true });
    }

    let child: child_process.ChildProcess;
    try {
      child = this.getChild(sourcePath);
    } catch (error: any) {
      return Promise.resolve({ content: (error && error.message) || String(error), isError: true });
    }

    const requestID = 'tm-' + this.counter++;
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60000;

    return new Promise<ToolExecResult>((resolve) => {
      let settled = false;
      let elicitationsInFlight = 0;
      let timer: NodeJS.Timeout | undefined;

      const settle = (result: ToolExecResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.pending.delete(requestID);
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        resolve(result);
      };

      // (Re)arm the no-response timeout, unless an elicitation is open (the user
      // may be filling a form): a call is only "stuck" when nothing is happening.
      const armTimer = () => {
        if (settled) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (elicitationsInFlight > 0) {
          return;
        }
        timer = setTimeout(() => {
          try {
            child.send({ type: 'cancel', requestID });
          } catch {
            // ignore
          }
          settle({ content: `Tool call stopped: no response after ${Math.round(timeoutMs / 1000)}s.`, isError: false, stopped: true, timedOut: true });
        }, timeoutMs);
      };

      const onAbort = () => {
        try {
          child.send({ type: 'cancel', requestID });
        } catch {
          // ignore
        }
        settle({ content: 'Tool call stopped by the user.', isError: false, stopped: true });
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort);
      }

      this.pending.set(requestID, {
        source: sourcePath,
        onResult: (message) => settle({ content: message.content, isError: message.isError }),
        onError: (error) => settle({ content: error, isError: true }),
        onProgress: (progress) => {
          armTimer();
          if (options.onProgress) {
            try {
              options.onProgress(progress || {});
            } catch {
              // ignore
            }
          }
        },
        onElicit: (message) => {
          // Suspend the timeout while the user is being asked, then resume it.
          elicitationsInFlight++;
          armTimer();
          const finish = (action: string, content?: any) => {
            elicitationsInFlight = Math.max(0, elicitationsInFlight - 1);
            armTimer();
            try {
              child.send({ type: 'elicitResult', requestID, elicitationID: message.elicitationID, action, content });
            } catch {
              // ignore
            }
          };
          if (!options.onElicit) {
            finish('cancel');
            return;
          }
          const schema = this.looksLikeJsonSchema(message.fields) ? message.fields : this.argumentsToSchema(message.fields);
          Promise.resolve(options.onElicit({ elicitationID: message.elicitationID, message: message.message, schema }))
            .then((response) => finish((response && response.action) || 'cancel', response && response.content))
            .catch(() => finish('cancel'));
        },
      });

      armTimer();
      child.send({ type: 'execute', name, arguments: args, config: this.configForSource(sourcePath), requestID });
    });
  }

  /**
   * Resolves a tool's configuration from the VS Code setting it declares with
   * `@config` (e.g. the MCP tool reads `ice.mcpServers`). Tools without a
   * `@config` header get an empty object. This is how a tool receives its
   * environment without the core knowing anything tool-specific.
   */
  private configForSource(sourcePath: string): any {
    try {
      const header = this.parseToolHeader(fs.readFileSync(sourcePath, 'utf8'));
      if (header.configKey) {
        return vscode.workspace.getConfiguration().get(header.configKey) || {};
      }
    } catch {
      // Fall through to an empty config.
    }
    return {};
  }

  /** Resolves a source (built-in id, absolute path, or path relative to the chat). */
  private resolveSourcePath(source: string, chatDir?: string): string | undefined {
    if (!source) {
      return undefined;
    }
    // A bare id with no separators is a built-in tool.
    if (!source.includes('/') && !source.includes('\\')) {
      const builtin = path.join(this.builtinDir, source, 'main.js');
      return fs.existsSync(builtin) ? builtin : undefined;
    }
    if (path.isAbsolute(source)) {
      return fs.existsSync(source) ? source : undefined;
    }
    if (chatDir) {
      const relative = path.resolve(chatDir, source);
      return fs.existsSync(relative) ? relative : undefined;
    }
    return undefined;
  }

  /** Parses a tool's `==ICETool==` header for its static identity. */
  private parseToolHeader(code: string): { name?: string; description?: string; dynamic: boolean; configKey?: string } {
    const result: { name?: string; description?: string; dynamic: boolean; configKey?: string } = { dynamic: false };
    const start = code.indexOf('// ==ICETool==');
    const end = code.indexOf('// ==/ICETool==');
    if (start === -1 || end === -1) {
      return result;
    }
    const header = code.slice(start, end);
    const lineRegex = /^\/\/ @(\w+) +(.+?)\s*$/gm;
    let match;
    while ((match = lineRegex.exec(header)) !== null) {
      const key = match[1];
      const value = match[2].trim();
      if (key === 'name') {
        result.name = value;
      } else if (key === 'description') {
        result.description = value;
      } else if (key === 'dynamic') {
        result.dynamic = value === 'true';
      } else if (key === 'config') {
        result.configKey = value;
      }
    }
    return result;
  }

  /** Compiles a tool's friendly `arguments` object into a JSON schema. */
  private argumentsToSchema(argsSpec: { [name: string]: ToolArgumentSpec } | null | undefined): any {
    const properties: any = {};
    const required: string[] = [];
    for (const name in argsSpec || {}) {
      const spec = (argsSpec as any)[name] || {};
      const property: any = { type: spec.type || 'string' };
      if (spec.description) {
        property.description = spec.description;
      }
      if (Array.isArray(spec.enum)) {
        property.enum = spec.enum;
      }
      if (Array.isArray(spec.range) && spec.range.length === 2) {
        property.minimum = spec.range[0];
        property.maximum = spec.range[1];
      }
      if (spec.items) {
        property.items = spec.items;
      }
      properties[name] = property;
      if (!spec.optional) {
        required.push(name);
      }
    }
    return { type: 'object', properties, required };
  }

  /**
   * True when a value is already a JSON schema object (so it can be used as-is),
   * as opposed to ICE's friendly `arguments` map (which needs compiling). Used
   * for elicitation, where MCP hands back a ready schema but an ICE tool may pass
   * the same friendly shape it uses for its arguments.
   */
  private looksLikeJsonSchema(value: any): boolean {
    return Boolean(value && typeof value === 'object' && value.type === 'object' && value.properties && typeof value.properties === 'object');
  }

  private getChild(sourcePath: string): child_process.ChildProcess {
    const existing = this.children.get(sourcePath);
    if (existing && existing.connected) {
      return existing;
    }

    // Make node/npx findable for tools that spawn subprocesses, even when VS Code
    // was launched from the GUI.
    const augmentedPath = [path.dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', process.env.PATH || '']
      .filter(Boolean)
      .join(path.delimiter);

    const child = child_process.fork(path.join(this.builtinDir, '_host.js'), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ICE_TOOL_PATH: sourcePath, PATH: augmentedPath },
    });
    child.on('message', (message: any) => this.handleChildMessage(message));
    child.on('exit', () => {
      this.children.delete(sourcePath);
      this.rejectPendingForSource(sourcePath, new Error('Tool process exited'));
    });
    child.stderr?.on('data', (data) => console.error(`[tool ${path.basename(path.dirname(sourcePath))}] ${data}`));
    this.children.set(sourcePath, child);
    return child;
  }

  private handleChildMessage(message: any): void {
    if (!message || !message.requestID) {
      return;
    }
    const pending = this.pending.get(message.requestID);
    if (!pending) {
      return;
    }

    // Non-terminal messages steer an in-flight execute() without settling it.
    if (message.type === 'progress') {
      pending.onProgress?.(message.progress || {});
      return;
    }
    if (message.type === 'elicit') {
      pending.onElicit?.(message);
      return;
    }

    // Terminal messages: the request is done.
    this.pending.delete(message.requestID);
    if (message.type === 'definition') {
      pending.resolve?.(message);
    } else if (message.type === 'tools') {
      pending.resolve?.(message.tools);
    } else if (message.type === 'result') {
      if (pending.onResult) {
        pending.onResult(message);
      } else {
        pending.resolve?.({ content: message.content, isError: message.isError });
      }
    } else if (message.type === 'toolsError' || message.type === 'error') {
      if (pending.onError) {
        pending.onError(message.error || 'Tool error');
      } else {
        pending.reject?.(new Error(message.error || 'Tool error'));
      }
    }
  }

  private send<T = any>(sourcePath: string, message: any): Promise<T> {
    const child = this.getChild(sourcePath);
    const requestID = 'tm-' + this.counter++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestID)) {
          this.pending.delete(requestID);
          reject(new Error('Tool request timed out'));
        }
      }, 60000);
      this.pending.set(requestID, {
        source: sourcePath,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.send({ ...message, requestID });
    });
  }

  private rejectPendingForSource(sourcePath: string, error: Error): void {
    for (const [requestID, pending] of [...this.pending.entries()]) {
      if (pending.source === sourcePath) {
        this.pending.delete(requestID);
        if (pending.onError) {
          pending.onError(error.message);
        } else if (pending.reject) {
          pending.reject(error);
        }
      }
    }
  }

  /** Terminates all tool processes. Call on extension deactivation. */
  public dispose(): void {
    for (const child of this.children.values()) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    this.children.clear();
  }
}
