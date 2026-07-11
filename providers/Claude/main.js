// ==ICEProvider==
// @name                Anthropic Claude
// @version             1.2
// @description         ICE provider for Claude by Anthropic, using the Messages API. Docs: https://platform.claude.com/docs. This script is not affiliated with Anthropic.
// @author              Alan Richard
// @license             MIT
// @_needAttachmentPreprocessing  false
// @_attachmentFilter   { "Images": ["jpg", "jpeg", "png", "gif", "webp"], "Documents": ["txt", "md"], "Others": ["*"] }
// @variableSecure      APIKey
// @variableRequired    APIHost=api.anthropic.com
// @variableRequired    APIPath=/v1/messages
// @variableRequired    Model=claude-sonnet-4-5
// @variableRequired    MaxTokensToSample=4000
// @variableRequired    SystemPrompt=You are a helpful assistant. Current date: {{ DATE_TODAY }}
// @variableOptional    Temperature=0.5
// @variableOptional    AdditionalHeaders={}
// @variableSuggest     Model=claude-sonnet-4-5,claude-opus-4-1,claude-haiku-4-5,claude-3-5-haiku-latest
// @quickOption         Model
// ==/ICEProvider==

const https = require('https');
const fs = require('fs');
const isBinaryFileSync = require("isbinaryfile").isBinaryFileSync;

function debug(message) {
  process.send({
    type: 'debug',
    content: message
  });
}

/**
 * Pulls a human-readable message out of a parsed Anthropic error payload, which
 * is shaped like { type: "error", error: { type, message } }. Also tolerates
 * { error: "..." } and { message } for robustness. Returns '' when none present.
 */
function pluckErrorMessage(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return typeof parsed === 'string' ? parsed : '';
  }
  if (parsed.error && typeof parsed.error.message === 'string') {
    return parsed.error.message;
  }
  if (typeof parsed.error === 'string') {
    return parsed.error;
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

    debug(`Received message trail: ${JSON.stringify(messageTrail)}\n`);
    debug(`Received config: ${JSON.stringify(config)}\n`);

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
                type: 'image',
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

    const requestBody = JSON.stringify({
      model: config.Model,
      messages: messages,
      max_tokens: parseInt(config.MaxTokensToSample),
      stream: true,
      system: config.SystemPrompt,
      temperature: parseFloat(config.Temperature || '0'),
    });

    debug(`Request body: ${requestBody}\n`);

    const options = {
      hostname: config.APIHost,
      port: 443,
      path: config.APIPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': config.APIKey,
        ...JSON.parse(config.AdditionalHeaders || '{}'),
      },
    };

    debug(`Request options: ${JSON.stringify(options)}\n`);

    // Optional response metadata (reported to ICE on completion when present).
    // Anthropic splits token counts across message_start (input) and
    // message_delta (output), and reports the resolved model in message_start.
    let capturedModel = null;
    let capturedInputTokens = null;
    let capturedOutputTokens = null;

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

    function handleEvent(event, data) {
      debug(`Received event: ${event}\n`);
      debug(`Received event data: ${JSON.stringify(data)}\n`);

      if (event === 'message_start') {
        if (data.message) {
          if (data.message.model) {
            capturedModel = data.message.model;
          }
          if (data.message.usage && typeof data.message.usage.input_tokens === 'number') {
            capturedInputTokens = data.message.usage.input_tokens;
          }
        }
        process.send({
          type: 'stream',
          requestID: requestID,
          partialText: ''
        });
      } else if (event === 'content_block_delta') {
        if (data.delta.type === 'text_delta') {
          process.send({
            type: 'stream',
            requestID: requestID,
            partialText: data.delta.text
          });
          return data.delta.text;
        }
      } else if (event === 'message_delta') {
        if (data.usage && typeof data.usage.output_tokens === 'number') {
          capturedOutputTokens = data.usage.output_tokens;
        }
      } else if (event === 'error') {
        reportError((data.error && data.error.message) || 'Provider returned an error');
      }

      return null;
    }

    let responseText = '';

    // Emits the completion with the optional model + normalized token usage.
    function sendDone() {
      if (settled) {
        return;
      }
      settled = true;
      const hasUsage = capturedInputTokens != null || capturedOutputTokens != null;
      const usage = hasUsage
        ? {
            promptTokens: capturedInputTokens != null ? capturedInputTokens : undefined,
            completionTokens: capturedOutputTokens != null ? capturedOutputTokens : undefined,
            totalTokens: (capturedInputTokens != null && capturedOutputTokens != null)
              ? capturedInputTokens + capturedOutputTokens
              : undefined,
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
      // parser below only understands `event:`/`data:` lines, so without this
      // branch the error would be silently dropped and the reply "completes" empty.
      const isErrorResponse = res.statusCode < 200 || res.statusCode >= 300;

      let responseData = '';
      let errorBody = '';

      res.on('data', (chunk) => {
        debug(`Received data: ${chunk}\n`);
        if (isErrorResponse) {
          errorBody += chunk;
          return;
        }
        responseData += chunk;

        const lines = responseData.split('\n');
        let event = null;
        let data = null;
        let jsonBlob = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            if (event !== null && data !== null) {
              responseData = '';
              const partialText = handleEvent(event, data);
              if (partialText !== null) {
                responseText += partialText;
              }
            }
            event = line.substring(7).trim();
            data = null;
          } else if (line.startsWith('data: ')) {
            try {
              data = JSON.parse(line.substring(6));
            } catch (error) {
              // There's a chance that the JSON is not complete yet
              jsonBlob += line.substring(6);
            }
          } else if (jsonBlob !== '') {
            try {
              data = JSON.parse(jsonBlob + line);
            } catch (error) {
              jsonBlob += line;
            }
          }
        }

        if (event !== null && data !== null) {
          debug(`Processing event: ${event}\n`);
          responseData = '';
          const partialText = handleEvent(event, data);
          if (partialText !== null) {
            responseText += partialText;
          }
        }
      });

      res.on('end', () => {
        debug('Response ended\n');
        if (isErrorResponse) {
          reportError(extractErrorMessage(errorBody, res.statusCode));
        } else {
          sendDone();
        }

        if (requests[requestID]) {
          delete requests[requestID];
        }
      });
    });

    requests[requestID] = req;

    req.on('error', (error) => {
      debug(`Request error: ${error.message}\n`);
      reportError(error.message);
      if (requests[requestID]) {
        delete requests[requestID];
      }
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
