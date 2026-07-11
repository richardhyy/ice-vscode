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

    const messages = messageTrail.map((message) => {
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
        process.send({
          type: 'error',
          requestID: requestID,
          error: data.error.message
        });
      } else if (data.choices) {
        if (data.choices.length === 0) {
          // A trailing usage-only chunk has empty choices — that's expected, not
          // an error. Only a genuinely empty first response is an error.
          if (data.usage) {
            return null;
          }
          debug('No response\n');
          process.send({
            type: 'error',
            error: 'No response'
          });
        } else {
          const delta = data.choices[0].delta || {};
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
        process.send({
          type: 'error',
          requestID: requestID,
          error: `Unsupported object: ${data.object}`
        });
      }

      return null;
    }

    let responseText = '';

    // Emits the completion, attaching the resolved model + normalized token usage
    // when the backend reported them (both optional).
    function sendDone() {
      const usage = capturedUsage
        ? {
            promptTokens: capturedUsage.prompt_tokens,
            completionTokens: capturedUsage.completion_tokens,
            totalTokens: capturedUsage.total_tokens,
          }
        : undefined;
      process.send({
        type: 'done',
        requestID: requestID,
        finalText: responseText,
        model: capturedModel || config.Model,
        usage: usage,
      });
    }

    const req = transport.request(options, (res) => {
      debug(`Response status code: ${res.statusCode}\n`);
      debug(`Response headers: ${JSON.stringify(res.headers)}\n`);

      let responseData = '';

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
        responseData += chunk;
        debug(`Received data: ${chunk}\n`);
        const lines = responseData.split('\n');
        responseData = lines.pop();
        for (const line of lines) {
          onData(line);
        }
      });

      res.on('end', () => {
        if (responseData) {
          onData(responseData);
        }
        debug('Response ended\n');
        sendDone();
      });
    });

    requests[requestID] = req;

    req.on('error', (error) => {
      debug(`Request error: ${error.message}\n`);
      process.send({
        type: 'error',
        requestID: requestID,
        error: error.message
      });
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
