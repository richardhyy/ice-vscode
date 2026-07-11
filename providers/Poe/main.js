// ==ICEProvider==
// @name                Poe
// @version             2.0
// @description         Chat with hundreds of models and bots on Poe through its OpenAI-compatible API. Create an API key at https://poe.com/api/keys. Docs: https://creator.poe.com/docs/external-applications/openai-compatible-api. This script is not affiliated with Quora or Poe.
// @author              Alan Richard
// @license             MIT
// @_needAttachmentPreprocessing  false
// @_attachmentFilter   { "Images": ["jpg", "jpeg", "png", "gif", "webp"], "Documents": ["txt", "md"], "Others": ["*"] }
// @variableSecure      APIKey
// @variableRequired    Model=GPT-5
// @variableRequired    MaxTokensToSample=4000
// @variableRequired    SystemPrompt=You are a helpful assistant. Current date: {{ DATE_TODAY }}
// @variableOptional    Temperature=0.7
// @variableOptional    AdditionalHeaders={}
// @variableSuggest     Model=GPT-5,GPT-4o,Claude-Sonnet-4.5,Claude-Opus-4.1,Gemini-2.5-Pro,Gemini-2.5-Flash,Llama-3.1-405B
// @quickOption         Model
// ==/ICEProvider==

const https = require('https');
const fs = require('fs');
const isBinaryFileSync = require("isbinaryfile").isBinaryFileSync;

// Poe exposes a single OpenAI-compatible Chat Completions endpoint. The `Model`
// value is a Poe bot name (e.g. GPT-5, Claude-Sonnet-4.5, Gemini-2.5-Pro).
const POE_HOSTNAME = 'api.poe.com';
const POE_PATH = '/v1/chat/completions';

function debug(message) {
  process.send({
    type: 'debug',
    content: message
  });
}

/**
 * Pulls a human-readable message out of a parsed OpenAI-style error payload,
 * tolerating { error: { message } }, { error: "..." } and { message }. Poe uses
 * this shape too. Returns '' when none is present.
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
 * normally a JSON error object; falls back to the raw body (clamped) or just the
 * status when nothing parses, so the failure is never swallowed.
 */
function extractErrorMessage(body, statusCode) {
  const prefix = `Request failed (HTTP ${statusCode})`;
  const raw = (body || '').trim();
  let message = '';
  try {
    message = pluckErrorMessage(JSON.parse(raw));
  } catch (e) {
    message = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  }
  message = (message || '').trim();
  return message ? `${prefix}: ${message}` : prefix;
}

let requests = {};

process.on('message', (message) => {
  const requestID = message.requestID;
  if (message.type === 'getCompletion') {
    const messageTrail = message.messageTrail;
    const config = message.config;

    const messages = messageTrail.map((message) => {
      const processedMessage = {
        role: message.role === 'assistant' ? 'assistant' : 'user',
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
            if (mimeType && mimeType.startsWith('image/')) {
              processedMessage.content.push({
                type: 'image_url',
                image_url: { url: attachment.url }
              });
            }
          } else {
            // URL / local path
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

              if (['jpeg', 'png', 'gif', 'webp'].includes(extension)) {
                const base64Data = buffer.toString('base64');
                processedMessage.content.push({
                  type: 'image_url',
                  image_url: { url: `data:image/${extension};base64,${base64Data}` }
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

    // Poe honours a `system` message from the API (its UI-specific system prompts
    // are skipped), so surface the configured prompt as the leading turn.
    if (config.SystemPrompt && config.SystemPrompt.trim()) {
      messages.unshift({
        role: 'system',
        content: config.SystemPrompt,
      });
    }

    const requestPayload = {
      model: config.Model,
      messages: messages,
      max_tokens: parseInt(config.MaxTokensToSample),
      stream: true,
      // Ask the API to append a final chunk with token usage (OpenAI spec).
      stream_options: { include_usage: true },
      temperature: parseFloat(config.Temperature || '0.7'),
    };

    const requestBody = JSON.stringify(requestPayload);

    debug(`Request body: ${requestBody}\n`);

    const options = {
      hostname: POE_HOSTNAME,
      port: 443,
      path: POE_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.APIKey}`,
        ...JSON.parse(config.AdditionalHeaders || '{}'),
      },
    };

    debug(`Request options: ${JSON.stringify(options)}\n`);

    // Optional response metadata (reported to ICE on completion when present).
    let capturedModel = null;
    let capturedUsage = null;

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
          // A trailing usage-only chunk has empty choices — that's expected.
          return null;
        }
        const delta = data.choices[0].delta || {};
        // Some bots stream their thinking under a separate reasoning key; the
        // answer itself always comes via `content`.
        const reasoningChunk = (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
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
      process.send({
        type: 'done',
        requestID: requestID,
        finalText: responseText,
        model: capturedModel || config.Model,
        usage: usage,
      });
    }

    const req = https.request(options, (res) => {
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
  } else {
    debug(`Unknown message type: ${message.type}\n`);
  }
});
