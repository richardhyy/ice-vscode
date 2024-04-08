// ==ICEProvider==
// @name                Google Gemini
// @version             1.0
// @description         ICE provider for Google Gemini. Docs: https://ai.google.dev/tutorials. This script is not affiliated with Google.
// @author              Alan Richard
// @license             MIT  
// @variableSecure      APIKey
// @variableRequired    Model=gemini-pro
// @variableRequired    MaxOutputTokens=2048
// @variableOptional    Temperature=0.9
// @variableOptional    TopP=1
// @variableOptional    TopK=1
// @variableOptional    StopSequences=[]
// @variableOptional    SafetySettings=[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_MEDIUM_AND_ABOVE"},{"category":"HARM_CATEGORY_HATE_SPEECH","threshold":"BLOCK_MEDIUM_AND_ABOVE"},{"category":"HARM_CATEGORY_SEXUALLY_EXPLICIT","threshold":"BLOCK_MEDIUM_AND_ABOVE"},{"category":"HARM_CATEGORY_DANGEROUS_CONTENT","threshold":"BLOCK_MEDIUM_AND_ABOVE"}]
// ==/ICEProvider==

const https = require('https');

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

    const contents = messageTrail.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{
        text: message.content
      }],
    }));

    const requestBody = JSON.stringify({
      contents: contents,
      generationConfig: {
        stopSequences: JSON.parse(config.StopSequences || '[]'),
        temperature: parseFloat(config.Temperature || '0.9'),
        maxOutputTokens: parseInt(config.MaxOutputTokens),
        topP: parseFloat(config.TopP || '1'),
        topK: parseInt(config.TopK || '1'),
      },
      safetySettings: JSON.parse(config.SafetySettings || '[]')
    });

    debug(`Request body: ${requestBody}\n`);

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/${config.Model}:streamGenerateContent?key=${config.APIKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    debug(`Request options: ${JSON.stringify(options)}\n`);

    let responseText = '';

    const req = https.request(options, (res) => {
      debug(`Response status code: ${res.statusCode}\n`);
      debug(`Response headers: ${JSON.stringify(res.headers)}\n`);

      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
        debug(`Received data: ${chunk}\n`);

        try {
          const data = JSON.parse(responseData);
          if (data.error) {
            process.send({
              type: 'error',
              requestID: requestID,
              error: data.error.message
            });
          }
          for (const item of data) {
            if (item.candidates && item.candidates.length > 0) {
              const candidate = item.candidates[0];
              const text = candidate.content.parts[0].text;
              process.send({
                type: 'stream',
                requestID: requestID,
                partialText: text
              });
              responseText += text;
            }
          }
          responseData = '';
        } catch (error) {
          // Incomplete JSON, wait for more data
        }
      });

      res.on('end', () => {
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