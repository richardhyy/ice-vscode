// ==ICEProvider==
// @name                Zhipu GLM
// @version             1.0
// @description         ICE provider for ZHIPU AI. Docs: https://open.bigmodel.cn/. This script is not affiliated with ZHIPU AI.
// @author              Alan Richard
// @license             MIT
// @variableSecure      APIKey
// @variableRequired    Model=glm-4
// @variableRequired    MaxTokens=2048
// @variableRequired    SystemPrompt=You are a helpful AI assistant.
// @variableOptional    Temperature=0.95
// @variableOptional    TopP=0.7
// ==/ICEProvider==

const https = require('https');
const crypto = require('crypto');

function debug(message) {
  process.send({
    type: 'debug',
    content: message
  });
}

function base64UrlEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateToken(apiKey, expSeconds) {
  const [id, secret] = apiKey.split('.');

  const header = {
    alg: 'HS256',
    sign_type: 'SIGN',
  };

  const payload = {
    api_key: id,
    exp: Math.floor(Date.now() / 1000) + expSeconds,
    timestamp: Math.floor(Date.now() / 1000),
  };

  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload)));

  const signature = crypto.createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

let requests = {};

process.on('message', (message) => {
  const requestID = message.requestID;
  if (message.type === 'getCompletion') {
    const messageTrail = message.messageTrail;
    const config = message.config;

    const messages = messageTrail.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    messages.push({
      role: 'system',
      content: config.SystemPrompt,
    });

    const requestBody = JSON.stringify({
      model: config.Model,
      messages: messages,
      max_tokens: parseInt(config.MaxTokensToSample),
      stream: true,
      temperature: parseFloat(config.Temperature || '0.95'),
      top_p: parseFloat(config.TopP || '0.7'),
    });

    debug(`Request body: ${requestBody}\n`);

    const token = generateToken(config.APIKey, 3600);

    const options = {
      hostname: 'open.bigmodel.cn',
      port: 443,
      path: '/api/paas/v4/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
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
    
        const lines = responseData.split('\n');
        responseData = lines.pop(); // Keep the last line as it might be incomplete
    
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.substring(6);
            if (dataStr === '[DONE]') {
              continue;
            }
    
            try {
              const data = JSON.parse(dataStr);
              const event = data.choices[0].delta;
    
              if (event.content) {
                responseText += event.content;
                process.send({
                  type: 'stream',
                  requestID: requestID,
                  partialText: event.content
                });
              }
            } catch (error) {
              debug(`Error parsing event data: ${error.message}\n`);
            }
          }
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
