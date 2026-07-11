// ==ICEProvider==
// @name                Google Gemini
// @version             1.1
// @description         ICE provider for the Google Gemini API. Docs: https://ai.google.dev/gemini-api/docs/text-generation. This script is not affiliated with Google.
// @author              Alan Richard
// @license             MIT
// @_needAttachmentPreprocessing  false
// @_attachmentFilter   { "Images": ["jpg", "jpeg", "png", "gif", "webp"], "Documents": ["txt", "md"], "Others": ["*"] }
// @variableSecure      APIKey
// @variableRequired    Model=gemini-2.5-flash
// @variableRequired    MaxOutputTokens=2048
// @variableRequired    SystemPrompt=You are a helpful assistant. Current date: {{ DATE_TODAY }}
// @variableOptional    Temperature=1
// @variableOptional    TopP=0.95
// @variableOptional    TopK=
// @variableOptional    StopSequences=[]
// @variableOptional    SafetySettings=[]
// @variableSuggest     Model=gemini-2.5-flash,gemini-2.5-pro,gemini-2.5-flash-lite,gemini-2.0-flash
// @quickOption         Model
// ==/ICEProvider==

const https = require('https');
const fs = require('fs');
const isBinaryFileSync = require("isbinaryfile").isBinaryFileSync;

const GEMINI_HOSTNAME = 'generativelanguage.googleapis.com';

function debug(message) {
  process.send({
    type: 'debug',
    content: message
  });
}

/**
 * Pulls a human-readable message out of a parsed Gemini error payload, shaped
 * like { error: { code, message, status } }. Also tolerates { error: "..." } and
 * { message } for robustness. Returns '' when none is present.
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

    // Build Gemini `contents`. Roles alternate user/model; readable attachments
    // are inlined as text, images become inline_data parts.
    const contents = messageTrail.map((message) => {
      const parts = [{ text: message.content }];

      if (message.attachments) {
        for (const attachment of message.attachments) {
          if (attachment.url.startsWith('data:')) {
            // Base64 encoded
            const mimeType = attachment.url.split(';')[0].split(':')[1];
            const base64Data = attachment.url.split(',')[1];
            if (mimeType && mimeType.startsWith('image/')) {
              parts.push({ inlineData: { mimeType: mimeType, data: base64Data } });
            }
          } else {
            // URL / local path
            const buffer = fs.readFileSync(attachment.url);

            const isBinary = isBinaryFileSync(buffer);
            if (!isBinary) {
              parts[0].text = `<${attachment.name}>\n${buffer.toString()}\n</${attachment.name}>\n${parts[0].text}`;
            } else {
              let extension = attachment.url.split('.').pop().toLowerCase();
              if (extension === 'jpg') {
                extension = 'jpeg';
              }

              if (['jpeg', 'png', 'gif', 'webp'].includes(extension)) {
                parts.push({ inlineData: { mimeType: `image/${extension}`, data: buffer.toString('base64') } });
              } else {
                parts[0].text = `<${attachment.name}>\nUnsupported file type\n</${attachment.name}>\n${parts[0].text}`;
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

      return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: parts,
      };
    });

    const generationConfig = {
      temperature: parseFloat(config.Temperature || '1'),
      maxOutputTokens: parseInt(config.MaxOutputTokens),
      stopSequences: JSON.parse(config.StopSequences || '[]'),
    };
    // topP / topK are model-dependent, so only send them when explicitly set.
    if (config.TopP !== undefined && config.TopP !== '') {
      generationConfig.topP = parseFloat(config.TopP);
    }
    if (config.TopK !== undefined && config.TopK !== '') {
      generationConfig.topK = parseInt(config.TopK);
    }

    const requestPayload = {
      contents: contents,
      generationConfig: generationConfig,
    };
    if (config.SystemPrompt && config.SystemPrompt.trim()) {
      requestPayload.systemInstruction = { parts: [{ text: config.SystemPrompt }] };
    }
    const safetySettings = JSON.parse(config.SafetySettings || '[]');
    if (Array.isArray(safetySettings) && safetySettings.length > 0) {
      requestPayload.safetySettings = safetySettings;
    }

    const requestBody = JSON.stringify(requestPayload);

    debug(`Request body: ${requestBody}\n`);

    const options = {
      hostname: GEMINI_HOSTNAME,
      port: 443,
      // `alt=sse` switches the streaming endpoint to Server-Sent Events, so each
      // chunk arrives as a single `data:` line instead of a growing JSON array.
      path: `/v1beta/models/${config.Model}:streamGenerateContent?alt=sse`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The key travels in a header (not the URL) so it doesn't leak into logs.
        'x-goog-api-key': config.APIKey,
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

    // Returns the answer text found in an SSE chunk. Thought parts are streamed
    // separately as reasoning; model + usage metadata are captured along the way.
    function handleEvent(data) {
      debug(`Received event data: ${JSON.stringify(data)}\n`);

      if (data.modelVersion) {
        capturedModel = data.modelVersion;
      }
      if (data.usageMetadata) {
        capturedUsage = data.usageMetadata;
      }

      if (data.promptFeedback && data.promptFeedback.blockReason) {
        reportError(`Request blocked: ${data.promptFeedback.blockReason}`);
        return null;
      }

      let contentChunk = '';
      let reasoningChunk = '';
      if (Array.isArray(data.candidates) && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        const parts = (candidate.content && candidate.content.parts) || [];
        for (const part of parts) {
          if (typeof part.text === 'string') {
            if (part.thought === true) {
              reasoningChunk += part.text;
            } else {
              contentChunk += part.text;
            }
          }
        }
      }

      if (contentChunk || reasoningChunk) {
        process.send({
          type: 'stream',
          requestID: requestID,
          partialText: contentChunk,
          reasoningText: reasoningChunk,
        });
      }
      return contentChunk;
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
            promptTokens: capturedUsage.promptTokenCount,
            completionTokens: capturedUsage.candidatesTokenCount,
            totalTokens: capturedUsage.totalTokenCount,
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

      // A non-2xx response is a plain JSON error body, not an SSE stream. Buffer
      // the whole body and surface it as an error instead of silently completing.
      const isErrorResponse = res.statusCode < 200 || res.statusCode >= 300;

      let responseData = '';
      let errorBody = '';

      function onData(line) {
        if (!line.startsWith('data: ')) {
          return;
        }
        const dataStr = line.substring(6).trim();
        if (!dataStr || dataStr === '[DONE]') {
          return;
        }
        let data;
        try {
          data = JSON.parse(dataStr);
        } catch (e) {
          debug(`Skipping unparsable SSE line: ${dataStr}\n`);
          return;
        }
        const partialText = handleEvent(data);
        if (partialText !== null) {
          responseText += partialText;
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
