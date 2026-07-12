import * as vscode from 'vscode';
import { ChatMessage } from './chatHistoryManager';
import { ROLE_ASSISTANT, ROLE_TOOL } from './constants';
import { ProviderCompletionMeta, ProviderOption, ProviderUsage, ToolCall, ToolDefinition } from './providerManager';

/** The subset of a provider config this provider reads. Values may be absent. */
type LMConfig = { [key: string]: string | null | undefined };

type StreamCallback = (partialText: string, reasoningText?: string) => void;
type CompletionCallback = (finalText: string, meta?: ProviderCompletionMeta) => void;

/**
 * In-process provider backed by VS Code's language model API (`vscode.lm`).
 *
 * Unlike the other ICE providers, this one does not run as a forked child
 * process: `vscode.lm` is only available in the extension host, so the request
 * is issued here directly. VS Code owns the authentication for these models
 * (e.g. a user's GitHub Copilot session), which is why the provider needs no API
 * key. `ProviderManager` routes a provider whose header declares
 * `@_runtime vscode-lm` to this class instead of the child-process path.
 */
export class VSCodeLMProvider {
  /** Active requests, keyed by the id returned from {@link getCompletion}. */
  private readonly pending = new Map<string, vscode.CancellationTokenSource>();

  private newRequestID(): string {
    return 'vscodelm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** True when VS Code exposes the language model API this provider depends on. */
  private isAvailable(): boolean {
    return !!vscode.lm && typeof vscode.lm.selectChatModels === 'function';
  }

  /**
   * Starts a completion and returns its request id immediately; text is delivered
   * through `onStream` and the single terminal outcome through `onCompletion`
   * (mirroring the child-process providers, so `ProviderManager` can treat both
   * paths identically).
   */
  public getCompletion(
    config: LMConfig,
    messageTrail: ChatMessage[],
    tools: ToolDefinition[],
    onStream: StreamCallback,
    onCompletion: CompletionCallback,
  ): string {
    const requestID = this.newRequestID();
    const cts = new vscode.CancellationTokenSource();
    this.pending.set(requestID, cts);

    // A request yields exactly one terminal outcome; `settled` guards against a
    // late error overwriting a completion (or vice versa).
    let settled = false;
    const settle = (finalText: string, meta?: ProviderCompletionMeta) => {
      if (settled) {
        return;
      }
      settled = true;
      this.pending.delete(requestID);
      cts.dispose();
      onCompletion(finalText, meta);
    };

    // Fire-and-forget: the streaming runs asynchronously and reports back through
    // the callbacks. Any unexpected rejection is surfaced as a recorded error.
    this.run(cts.token, config, messageTrail, tools, onStream, settle).catch((error) => {
      settle('', { error: describeError(error) });
    });

    return requestID;
  }

  /** Cancels an in-flight request; its partial text is kept as the reply. */
  public requestCancel(requestID: string): void {
    const cts = this.pending.get(requestID);
    if (cts) {
      cts.cancel();
    }
  }

  /**
   * Lists selectable values for a config variable. Only `Model` is dynamic: it
   * resolves to the language models VS Code currently offers. Anything else
   * returns an empty list so the UI keeps its static options.
   */
  public async listOptions(variableName: string, _config: LMConfig): Promise<ProviderOption[]> {
    if (variableName !== 'Model' || !this.isAvailable()) {
      return [];
    }

    let models: readonly vscode.LanguageModelChat[] = [];
    try {
      models = await vscode.lm.selectChatModels();
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const options: ProviderOption[] = [];
    for (const model of models) {
      if (!model || seen.has(model.id)) {
        continue;
      }
      seen.add(model.id);
      options.push({
        value: model.id,
        label: model.name,
        detail: describeModel(model),
      });
    }
    options.sort((a, b) => (a.label || a.value).localeCompare(b.label || b.value));
    return options;
  }

  private async run(
    token: vscode.CancellationToken,
    config: LMConfig,
    messageTrail: ChatMessage[],
    tools: ToolDefinition[],
    onStream: StreamCallback,
    settle: (finalText: string, meta?: ProviderCompletionMeta) => void,
  ): Promise<void> {
    if (!this.isAvailable()) {
      settle('', { error: 'This provider requires VS Code 1.95 or newer, which provides the language model API.' });
      return;
    }

    let model: vscode.LanguageModelChat;
    try {
      model = await resolveModel(config);
    } catch (error) {
      settle('', { error: describeError(error) });
      return;
    }

    const messages = buildMessages(config, messageTrail);
    const options = buildRequestOptions(config, tools);

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(messages, options, token);
    } catch (error) {
      if (isCancellation(error, token)) {
        settle('', { model: model.id });
      } else {
        settle('', { model: model.id, error: describeError(error) });
      }
      return;
    }

    let responseText = '';
    const toolCalls: ToolCall[] = [];
    try {
      for await (const part of response.stream) {
        if (token.isCancellationRequested) {
          break;
        }
        if (part instanceof vscode.LanguageModelTextPart) {
          if (part.value) {
            responseText += part.value;
            onStream(part.value);
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId || ('call_' + toolCalls.length),
            name: part.name,
            arguments: part.input && typeof part.input === 'object' ? part.input : {},
          });
        }
      }
    } catch (error) {
      if (!isCancellation(error, token)) {
        // Keep any text streamed before the failure (already accumulated on the
        // reply via onStream) and record the error in the completion metadata.
        settle('', { model: model.id, error: describeError(error) });
        return;
      }
      // A cancellation is a normal, partial completion, handled below.
    }

    const usage = await countUsage(model, messages, responseText);
    settle(responseText, {
      model: model.id,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
}

/**
 * Resolves which language model to use. An explicit `Model` (a model id, or a
 * family name as a fallback) is honored when still available; otherwise ICE picks
 * one for the user, preferring a Copilot model when several are offered.
 */
async function resolveModel(config: LMConfig): Promise<vscode.LanguageModelChat> {
  const wanted = (config.Model || '').trim();

  let models: vscode.LanguageModelChat[] = [];
  try {
    if (wanted) {
      models = await vscode.lm.selectChatModels({ id: wanted });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ family: wanted });
      }
    }
    if (models.length === 0) {
      models = await vscode.lm.selectChatModels();
    }
  } catch (error) {
    throw new Error(describeError(error));
  }

  if (models.length === 0) {
    throw new Error(
      'No language models are available in VS Code. Sign in to GitHub Copilot, or install an extension that provides language models, then try again.',
    );
  }

  if (wanted) {
    const exact = models.find((model) => model.id === wanted || model.family === wanted);
    if (exact) {
      return exact;
    }
  }
  return models.find((model) => model.vendor === 'copilot') || models[0];
}

/**
 * Translates ICE's conversation trail into VS Code chat messages. VS Code models
 * have no separate system role, so a system prompt is sent as a leading user
 * message. Assistant tool calls and `tool` result nodes are mapped to their
 * respective parts so multi-turn tool conversations round-trip correctly.
 */
function buildMessages(config: LMConfig, messageTrail: ChatMessage[]): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  const systemPrompt = (config.SystemPrompt || '').trim();
  if (systemPrompt) {
    messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
  }

  for (const message of messageTrail) {
    if (message.role === ROLE_ASSISTANT) {
      const calls = message.customFields && message.customFields.toolCalls;
      if (Array.isArray(calls) && calls.length > 0) {
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        if (message.content && message.content.trim()) {
          parts.push(new vscode.LanguageModelTextPart(message.content));
        }
        for (const call of calls) {
          const input = call && call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
          parts.push(new vscode.LanguageModelToolCallPart(String((call && call.id) || ''), String((call && call.name) || ''), input));
        }
        messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
      } else {
        messages.push(vscode.LanguageModelChatMessage.Assistant(message.content || ''));
      }
    } else if (message.role === ROLE_TOOL) {
      const callID = String((message.customFields && message.customFields.toolCallID) || '');
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(callID, [new vscode.LanguageModelTextPart(message.content || '')]),
        ]),
      );
    } else {
      // `user` and any other conversational role map to a user turn. Attachments
      // are already inlined into the content by ICE before this point.
      messages.push(vscode.LanguageModelChatMessage.User(message.content || ''));
    }
  }

  return messages;
}

/** Builds the request options: a consent justification, optional temperature, and any tools. */
function buildRequestOptions(config: LMConfig, tools: ToolDefinition[]): vscode.LanguageModelChatRequestOptions {
  const options: vscode.LanguageModelChatRequestOptions = {
    justification: 'ICE is sending your conversation to the language model you selected.',
  };

  const temperature = parseFloat(String(config.Temperature ?? ''));
  if (Number.isFinite(temperature)) {
    options.modelOptions = { temperature };
  }

  if (Array.isArray(tools) && tools.length > 0) {
    options.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    }));
    options.toolMode = vscode.LanguageModelChatToolMode.Auto;
  }

  return options;
}

/**
 * Best-effort token usage. The language model API does not report usage, so it is
 * estimated with the model's own tokenizer (`countTokens`). Any failure yields
 * no usage rather than blocking the completion.
 */
async function countUsage(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  responseText: string,
): Promise<ProviderUsage | undefined> {
  try {
    const promptCounts = await Promise.all(messages.map((message) => model.countTokens(message)));
    const promptTokens = promptCounts.reduce((total, count) => total + count, 0);
    const completionTokens = responseText ? await model.countTokens(responseText) : 0;
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  } catch {
    return undefined;
  }
}

/** A one-line, human-readable summary of a model for the option picker. */
function describeModel(model: vscode.LanguageModelChat): string {
  const parts = [model.vendor, model.family].filter((value) => !!value);
  if (typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0) {
    parts.push('up to ' + model.maxInputTokens.toLocaleString() + ' input tokens');
  }
  return parts.join(' \u00b7 ');
}

/** Recognises a cancellation, which ICE treats as a normal (partial) completion. */
function isCancellation(error: unknown, token: vscode.CancellationToken): boolean {
  if (token.isCancellationRequested) {
    return true;
  }
  if (error instanceof vscode.CancellationError) {
    return true;
  }
  const name = (error as { name?: string })?.name;
  const message = (error as { message?: string })?.message;
  return name === 'Canceled' || name === 'CancellationError' || message === 'Canceled';
}

/**
 * Turns an error into a readable message, mapping the common language model error
 * codes to guidance the user can act on and otherwise passing the message
 * through (VS Code's own messages, e.g. quota notices, are already user-facing).
 */
function describeError(error: unknown): string {
  if (error instanceof vscode.LanguageModelError) {
    const code = error.code || '';
    const detail = error.message || '';
    if (/NoPermission/i.test(code)) {
      return 'ICE needs your permission to use this language model. When VS Code asks, choose Allow, then try again.' + (detail ? ' (' + detail + ')' : '');
    }
    if (/Blocked/i.test(code)) {
      return 'The language model declined this request' + (detail ? ': ' + detail : '.');
    }
    if (/NotFound/i.test(code)) {
      return 'The selected language model is not available. Pick another model in the provider settings.' + (detail ? ' (' + detail + ')' : '');
    }
    return detail || 'The language model request failed.';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'The language model request failed.';
}
