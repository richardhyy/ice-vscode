// ==ICEProvider==
// @name                OpenAI Compatible
// @version             1.1
// @description         ICE provider for OpenAI compatible API. This script is not affiliated with OpenAI.
// @author              Alan Richard
// @license             MIT
// @_needAttachmentPreprocessing  false
// @_attachmentFilter   { "Images": ["jpg", "jpeg", "png", "gif", "webp"], "Documents": ["txt", "md"], "Others": ["*"] }
// @variableSecure      APIKey
// @variableRequired    APIHost=api.openai.com
// @variableRequired    APIPath=/v1/chat/completions
// @variableRequired    Model=gpt-3.5-turbo
// @variableRequired    MaxTokensToSample=4000
// @variableRequired    SystemPrompt=You are a helpful assistant. Current date: {{ DATE_TODAY }}
// @variableOptional    Temperature=0.7
// @variableOptional    LogitBias={}
// @variableOptional    AdditionalHeaders={}
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

    const requestBody = JSON.stringify({
      model: config.Model,
      messages: messages,
      max_tokens: parseInt(config.MaxTokensToSample),
      stream: true,
      temperature: parseFloat(config.Temperature || '0.7'),
      logit_bias: JSON.parse(config.LogitBias || '{}'),
    });

    debug(`Request body: ${requestBody}\n`);

    const hostname = config.APIHost;
    const path = config.APIPath;

    const options = {
      hostname: hostname,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.APIKey}`,
        ...JSON.parse(config.AdditionalHeaders || '{}'),
      },
    };

    debug(`Request options: ${JSON.stringify(options)}\n`);

    function handleEvent(data) {
      debug(`Received event data: ${JSON.stringify(data)}\n`);

      if (data.object === 'error') {
        process.send({
          type: 'error',
          requestID: requestID,
          error: data.error.message
        });
      } else if (data.choices) {
        if (data.choices.length === 0) {
          debug('No response\n');
          process.send({
            type: 'error',
            error: 'No response'
          });
        } else {
          const delta = data.choices[0].delta;
          process.send({
            type: 'stream',
            requestID: requestID,
            partialText: delta.content || ''
          });
          return delta.content || '';
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

    const req = https.request(options, (res) => {
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
        process.send({
          type: 'done',
          requestID: requestID,
          finalText: responseText
        });
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
      process.send({
        type: 'done',
        requestID: requestID,
        finalText: responseText
      });

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
