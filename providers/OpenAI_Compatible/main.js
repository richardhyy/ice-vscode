// ==ICEProvider==
// @name                OpenAI Compatible
// @version             1.2
// @description         ICE provider for OpenAI compatible API. This script is not affiliated with OpenAI.
// @author              Alan Richard
// @license             MIT
// @_needAttachmentPreprocessing  false
// @_attachmentFilter   { "Images": ["jpg", "jpeg", "png", "gif", "webp"], "Documents": ["txt", "md"], "Others": ["*"] }
// @variableSecure      APIKey
// @variableRequired    Preset=OpenAI
// @variableRequired    Model=gpt-4o-mini
// @variableRequired    MaxTokensToSample=4000
// @variableRequired    SystemPrompt=You are a helpful assistant. Current date: {{ DATE_TODAY }}
// @variableOptional    BaseURL
// @variableOptional    Temperature=0.7
// @variableOptional    LogitBias={}
// @variableOptional    AdditionalHeaders={}
// @variableOptional    ReasoningEffort
// @variableDynamic     Model
// @variableSuggest     Preset=OpenAI,Ollama,LM Studio,OpenRouter,Groq,DeepSeek,Together,Mistral,xAI,Fireworks,Perplexity,Custom
// @variableSuggest     ReasoningEffort=none,minimal,low,medium,high,xhigh
// @quickOption         Model
// @supportsTools       true
// ==/ICEProvider==

const https = require('https');
const http = require('http');
const fs = require('fs');
const isBinaryFileSync = require("isbinaryfile").isBinaryFileSync;

function debug(message) {
  process.send({
    type: 'debug',
    content: message
  });
}

/**
 * Well-known OpenAI-compatible services, keyed by the friendly `Preset` name the
 * user picks in the config. Each maps to that service's OpenAI-style base URL
 * (everything before `/chat/completions`), so users don't have to hand-assemble a
 * host and path. This table is the single source of truth for preset endpoints;
 * the header's `@variableSuggest Preset=...` list only mirrors these names for the
 * picker. `local` marks endpoints that run on the user's machine and need no key.
 */
const PRESETS = {
  'OpenAI':     { baseURL: 'https://api.openai.com/v1' },
  'Ollama':     { baseURL: 'http://localhost:11434/v1', local: true },
  'LM Studio':  { baseURL: 'http://localhost:1234/v1', local: true },
  'OpenRouter': { baseURL: 'https://openrouter.ai/api/v1' },
  'Groq':       { baseURL: 'https://api.groq.com/openai/v1' },
  'DeepSeek':   { baseURL: 'https://api.deepseek.com/v1' },
  'Together':   { baseURL: 'https://api.together.xyz/v1' },
  'Mistral':    { baseURL: 'https://api.mistral.ai/v1' },
  'xAI':        { baseURL: 'https://api.x.ai/v1' },
  'Fireworks':  { baseURL: 'https://api.fireworks.ai/inference/v1' },
  'Perplexity': { baseURL: 'https://api.perplexity.ai' },
};

const DEFAULT_PRESET = 'OpenAI';

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalises an OpenAI-style base URL: prepends https:// for a bare host and
 * guarantees a trailing slash so relative sub-paths (`chat/completions`,
 * `models`) resolve *under* it instead of replacing its last segment.
 */
function normalizeBaseURL(baseURL) {
  let base = baseURL.trim();
  if (!/:\/\//.test(base)) {
    base = `https://${base}`;
  }
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Resolves the chat + models endpoints from the config. A friendly `Preset`
 * (e.g. "Ollama", "OpenRouter") selects a known base URL so users don't have to
 * hand-assemble a host/path; an explicit `BaseURL` overrides the preset for
 * custom or self-hosted services. Legacy `APIHost`/`APIPath` configs (from earlier
 * versions, or pinned inline in a .chat file) are still honoured for backward compatibility.
 */
function resolveEndpoints(config) {
  // Legacy escape hatch: an explicit host/path (old configs, inline overrides)
  // applies only when no modern BaseURL is set.
  if (!hasText(config.BaseURL) && hasText(config.APIHost)) {
    const legacyBase = config.APIHost.includes('://') ? config.APIHost : `https://${config.APIHost}`;
    const chatPath = hasText(config.APIPath) ? config.APIPath : '/v1/chat/completions';
    let modelsPath = chatPath.replace(/chat\/completions\/?$/, 'models');
    if (modelsPath === chatPath) {
      modelsPath = '/v1/models';
    }
    return { chat: new URL(chatPath, legacyBase), models: new URL(modelsPath, legacyBase) };
  }

  const base = hasText(config.BaseURL)
    ? normalizeBaseURL(config.BaseURL)
    : normalizeBaseURL((PRESETS[config.Preset] || PRESETS[DEFAULT_PRESET]).baseURL);

  return { chat: new URL('chat/completions', base), models: new URL('models', base) };
}

/**
 * Builds request headers, attaching a Bearer token only when an API key is set —
 * local presets (Ollama, LM Studio) need none, so this avoids sending a bogus
 * `Authorization: Bearer undefined`. Any `AdditionalHeaders` are merged in last
 * so callers can override defaults (e.g. OpenRouter's ranking headers).
 */
function buildHeaders(config, base) {
  const headers = { ...base };
  if (hasText(config.APIKey)) {
    headers['Authorization'] = `Bearer ${config.APIKey}`;
  }
  return { ...headers, ...JSON.parse(config.AdditionalHeaders || '{}') };
}

/**
 * Pulls a human-readable message out of a parsed OpenAI-style error payload,
 * tolerating the common shapes: { error: { message } }, { error: "..." } and
 * { message }. Returns '' when none is present.
 */
function pluckErrorMessage(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return typeof parsed === 'string' ? parsed : '';
  }
  if (typeof parsed.error === 'string') {
    return parsed.error;
  }
  if (parsed.error && typeof parsed.error.message === 'string') {
    return parsed.error.message;
  }
  if (typeof parsed.message === 'string') {
    return parsed.message;
  }
  return '';
}

/**
 * Turns a non-2xx HTTP response body into a readable error string. The body is
 * normally a JSON error object, but some gateways double-encode the upstream
 * error inside `error.message`, so a message that itself looks like JSON is
 * unwrapped one extra level. Falls back to the raw body (clamped) or just the
 * status when nothing parses, so the failure is never swallowed.
 */
function extractErrorMessage(body, statusCode) {
  const prefix = `Request failed (HTTP ${statusCode})`;
  const raw = (body || '').trim();
  let message = '';
  try {
    message = pluckErrorMessage(JSON.parse(raw));
    const inner = message.trim();
    if (inner.startsWith('{') || inner.startsWith('[')) {
      try {
        message = pluckErrorMessage(JSON.parse(inner)) || message;
      } catch (e) {
        // Not actually nested JSON — keep the outer message.
      }
    }
  } catch (e) {
    message = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  }
  message = (message || '').trim();
  return message ? `${prefix}: ${message}` : prefix;
}

/**
 * Lists the models the configured endpoint advertises (GET /v1/models) and
 * reports them back to ICE as selectable options. Only the `Model` variable is
 * dynamic; anything else resolves to an empty list so the UI keeps its static
 * options. Failures are reported via `optionsError` so the caller can fall back.
 */
function handleListOptions(requestID, variableName, config) {
  if (variableName !== 'Model') {
    process.send({ type: 'options', requestID, variableName, options: [] });
    return;
  }

  const endpoint = resolveEndpoints(config).models;
  const transport = endpoint.protocol === 'http:' ? http : https;
  const options = {
    hostname: endpoint.hostname,
    port: endpoint.port || (endpoint.protocol === 'http:' ? 80 : 443),
    path: endpoint.pathname + endpoint.search,
    method: 'GET',
    headers: buildHeaders(config, {}),
  };

  const req = transport.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        process.send({ type: 'optionsError', requestID, variableName, error: `Model listing failed (HTTP ${res.statusCode})` });
        return;
      }
      try {
        const parsed = JSON.parse(body);
        const list = Array.isArray(parsed.data) ? parsed.data : [];
        const models = list
          .map((entry) => (entry && typeof entry.id === 'string' ? entry.id : null))
          .filter((id) => id)
          .sort((a, b) => a.localeCompare(b))
          .map((id) => ({ value: id }));
        process.send({ type: 'options', requestID, variableName, options: models });
      } catch (e) {
        process.send({ type: 'optionsError', requestID, variableName, error: `Could not parse model list: ${e.message}` });
      }
    });
  });
  req.on('error', (error) => {
    process.send({ type: 'optionsError', requestID, variableName, error: error.message });
  });
  req.end();
}

let requests = {};

process.on('message', (message) => {
  const requestID = message.requestID;
  if (message.type === 'getCompletion') {
    const messageTrail = message.messageTrail;
    const config = message.config;
    const tools = message.tools;

    const messages = messageTrail.map((message) => {
      // A tool-result node becomes an OpenAI `tool` message, keyed by the id of
      // the call it answers.
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: (message.customFields && message.customFields.toolCallID) || '',
          content: message.content || '',
        };
      }

      // An assistant turn that emitted tool calls carries them as `tool_calls`
      // (its text content may be empty, in which case send null).
      if (
        message.role === 'assistant' &&
        message.customFields &&
        Array.isArray(message.customFields.toolCalls) &&
        message.customFields.toolCalls.length > 0
      ) {
        return {
          role: 'assistant',
          content: message.content ? message.content : null,
          tool_calls: message.customFields.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}),
            },
          })),
        };
      }

      const processedMessage = {
        role: message.role,
        content: [
          {
            type: 'text',
            text: message.content
          }
        ]
      };

      if (message.attachments) {
        for (const attachment of message.attachments) {
          if (attachment.url.startsWith('data:')) {
            // Base64 encoded
            const mimeType = attachment.url.split(';')[0].split(':')[1];
            const base64Data = attachment.url.split(',')[1];

            if (mimeType.startsWith('image/')) {
              processedMessage.content.push({
                type: 'image_url',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64Data
                }
              });
            }
          } else {
            // URL
            const buffer = fs.readFileSync(attachment.url);
            
            // Check if the file is binary
            const isBinary = isBinaryFileSync(buffer);
            if (!isBinary) {
              processedMessage.content[0].text = `<${attachment.name}>\n${buffer.toString()}\n</${attachment.name}>\n${processedMessage.content[0].text}`;
            } else {
              // Check if the file is a supported image
              let extension = attachment.url.split('.').pop().toLowerCase();
              if (extension === 'jpg') {
                extension = 'jpeg';
              }

              if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) {
                const base64Data = buffer.toString('base64');
                processedMessage.content.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: `image/${extension}`,
                    data: base64Data
                  }
                });
              } else {
                processedMessage.content[0].text = `<${attachment.name}>\nUnsupported file type\n</${attachment.name}>\n${processedMessage.content[0].text}`;
                process.send({
                  type: 'warning',
                  requestID: requestID,
                  content: `Unsupported attachment: ${attachment.name}`
                });
              }
            }
          }
        }
      }

      return processedMessage;
    });

    messages.push({
      role: 'system',
      content: config.SystemPrompt,
    });

    const requestPayload = {
      model: config.Model,
      messages: messages,
      max_tokens: parseInt(config.MaxTokensToSample),
      stream: true,
      // Ask the API to append a final chunk with token usage (OpenAI spec).
      stream_options: { include_usage: true },
      temperature: parseFloat(config.Temperature || '0.7'),
      logit_bias: JSON.parse(config.LogitBias || '{}'),
    };

    // Optionally request reasoning/thinking output (only sent when configured,
    // since some models reject an explicit reasoning effort).
    if (config.ReasoningEffort) {
      requestPayload.reasoning_effort = config.ReasoningEffort;
    }

    // Offer the enabled tools to the model using the OpenAI function-tool schema.
    if (Array.isArray(tools) && tools.length > 0) {
      requestPayload.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      }));
    }

    const requestBody = JSON.stringify(requestPayload);

    debug(`Request body: ${requestBody}\n`);

    const endpoint = resolveEndpoints(config).chat;
    const transport = endpoint.protocol === 'http:' ? http : https;

    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'http:' ? 80 : 443),
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: buildHeaders(config, { 'Content-Type': 'application/json' }),
    };

    debug(`Request options: ${JSON.stringify(options)}\n`);

    // Optional response metadata (reported to ICE on completion when present).
    let capturedModel = null;
    let capturedUsage = null;
    // Streamed tool calls, keyed by their index; arguments arrive in fragments.
    const toolCallsAcc = {};

    // A request produces exactly one terminal outcome. `settled` guards against a
    // late completion overwriting a reported error (or a double `done` from the
    // response `end` and request `close` both firing).
    let settled = false;

    function reportError(errorMessage) {
      if (settled) {
        return;
      }
      settled = true;
      process.send({
        type: 'error',
        requestID: requestID,
        error: errorMessage,
      });
    }

    function handleEvent(data) {
      debug(`Received event data: ${JSON.stringify(data)}\n`);

      // Any chunk may carry the resolved model; the final usage chunk (requested
      // via stream_options.include_usage) carries token counts with empty choices.
      if (data.model) {
        capturedModel = data.model;
      }
      if (data.usage) {
        capturedUsage = data.usage;
      }

      if (data.object === 'error') {
        reportError((data.error && data.error.message) || 'Provider returned an error');
      } else if (data.choices) {
        if (data.choices.length === 0) {
          // A trailing usage-only chunk has empty choices — that's expected, not
          // an error. Only a genuinely empty first response is an error.
          if (data.usage) {
            return null;
          }
          debug('No response\n');
          reportError('No response');
        } else {
          const delta = data.choices[0].delta || {};

          // Accumulate streamed tool calls: the id and name arrive on the first
          // fragment of each call, its JSON arguments across subsequent ones.
          if (Array.isArray(delta.tool_calls)) {
            for (const toolCallDelta of delta.tool_calls) {
              const index = typeof toolCallDelta.index === 'number' ? toolCallDelta.index : 0;
              if (!toolCallsAcc[index]) {
                toolCallsAcc[index] = { id: '', name: '', arguments: '' };
              }
              if (toolCallDelta.id) {
                toolCallsAcc[index].id = toolCallDelta.id;
              }
              if (toolCallDelta.function) {
                if (toolCallDelta.function.name) {
                  toolCallsAcc[index].name = toolCallDelta.function.name;
                }
                if (typeof toolCallDelta.function.arguments === 'string') {
                  toolCallsAcc[index].arguments += toolCallDelta.function.arguments;
                }
              }
            }
          }

          // Reasoning/thinking is delivered under different keys depending on the
          // backend: reasoning_text (Copilot proxy), reasoning_content (DeepSeek),
          // or reasoning (OpenRouter). The answer itself comes via `content`.
          const reasoningChunk = (typeof delta.reasoning_text === 'string' && delta.reasoning_text)
            || (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
            || (typeof delta.reasoning === 'string' && delta.reasoning)
            || '';
          const contentChunk = delta.content || '';
          if (reasoningChunk || contentChunk) {
            process.send({
              type: 'stream',
              requestID: requestID,
              partialText: contentChunk,
              reasoningText: reasoningChunk,
            });
          }
          return contentChunk;
        }
      } else {
        debug(`Unsupported object: ${data.object}\n`);
        reportError(`Unsupported object: ${data.object}`);
      }

      return null;
    }

    let responseText = '';

    // Emits the completion, attaching the resolved model + normalized token usage
    // when the backend reported them (both optional).
    function sendDone() {
      if (settled) {
        return;
      }
      settled = true;
      const usage = capturedUsage
        ? {
            promptTokens: capturedUsage.prompt_tokens,
            completionTokens: capturedUsage.completion_tokens,
            totalTokens: capturedUsage.total_tokens,
          }
        : undefined;

      // Assemble accumulated tool calls, parsing each argument string into an
      // object (falling back to a raw wrapper if the model emitted invalid JSON).
      const toolCalls = Object.keys(toolCallsAcc)
        .map((key) => parseInt(key, 10))
        .sort((a, b) => a - b)
        .map((index) => {
          const accumulated = toolCallsAcc[index];
          let parsedArguments;
          try {
            parsedArguments = accumulated.arguments ? JSON.parse(accumulated.arguments) : {};
          } catch (e) {
            parsedArguments = { _raw: accumulated.arguments };
          }
          return { id: accumulated.id || ('call_' + index), name: accumulated.name, arguments: parsedArguments };
        })
        .filter((call) => call.name);

      process.send({
        type: 'done',
        requestID: requestID,
        finalText: responseText,
        model: capturedModel || config.Model,
        usage: usage,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }

    const req = transport.request(options, (res) => {
      debug(`Response status code: ${res.statusCode}\n`);
      debug(`Response headers: ${JSON.stringify(res.headers)}\n`);

      // A non-2xx response is a plain JSON error body, not an SSE stream. The SSE
      // parser below only understands `data:` lines, so without this branch the
      // error is silently dropped and the reply "completes" empty. Buffer the whole
      // body and surface it as an error instead.
      const isErrorResponse = res.statusCode < 200 || res.statusCode >= 300;

      let responseData = '';
      let errorBody = '';

      function onData(line) {
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6);
          if (dataStr !== '[DONE]') {
            const data = JSON.parse(dataStr);
            const partialText = handleEvent(data);
            if (partialText !== null) {
              responseText += partialText;
            }
          }
        }
      }

      res.on('data', (chunk) => {
        debug(`Received data: ${chunk}\n`);
        if (isErrorResponse) {
          errorBody += chunk;
          return;
        }
        responseData += chunk;
        const lines = responseData.split('\n');
        responseData = lines.pop();
        for (const line of lines) {
          onData(line);
        }
      });

      res.on('end', () => {
        debug('Response ended\n');
        if (isErrorResponse) {
          reportError(extractErrorMessage(errorBody, res.statusCode));
          return;
        }
        if (responseData) {
          onData(responseData);
        }
        sendDone();
      });
    });

    requests[requestID] = req;

    req.on('error', (error) => {
      debug(`Request error: ${error.message}\n`);
      reportError(error.message);
    });

    req.on('close', () => {
      debug('Request aborted\n');
      sendDone();

      if (requests[requestID]) {
        delete requests[requestID];
      }
    });

    req.write(requestBody);
    req.end();
    
  } else if (message.type === 'cancel') {
    if (requests[requestID]) {
      requests[requestID].destroy();
      delete requests[requestID];
    }
  } else if (message.type === 'listOptions') {
    handleListOptions(requestID, message.variableName, message.config || {});
  } else {
    debug(`Unknown message type: ${message.type}\n`);
  }
});
