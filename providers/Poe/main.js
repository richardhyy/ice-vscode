// ==ICEProvider==
// @name                Poe
// @version             1.0
// @description         Chat with bots on Poe. Please go to [Developers](https://poe.com/developers). For testing and development purposes only. This script is not affiliated with Quora and Poe.
// @author              Alan Richard
// @license             MIT
// @variableSecure      APIKey
// @variableRequired    Model=GPT-3.5-Turbo
// @variableRequired    SystemPrompt=You are a helpful assistant. Current date: {{ DATE_TODAY }}
// @variableOptional    Temperature=0.7
// @variableOptional    LogitBias={}
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

    const query = messageTrail.map((message) => ({
      role: message.role === 'assistant' ? 'bot' : message.role,
      content: message.content,
      content_type: 'text/markdown',
      timestamp: 0,
      message_id: '',
      feedback: [],
      attachments: []
    }));

    query.push({
      role: 'system',
      content: config.SystemPrompt,
      content_type: 'text/markdown',
      timestamp: 0,
      message_id: '',
      feedback: [],
      attachments: []
    });

    const requestBody = JSON.stringify({
      query: query,
      user_id: '',
      conversation_id: '',
      message_id: '',
      version: '1.0',
      type: 'query',
      temperature: parseFloat(config.Temperature || '0.7'),
      logit_bias: JSON.parse(config.LogitBias || '{}'),
    });

    debug(`Request body: ${requestBody}\n`);

    const options = {
      hostname: 'api.poe.com',
      port: 443,
      path: `/bot/${config.Model}`,
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${config.APIKey}`,
      },
    };

    debug(`Request options: ${JSON.stringify(options)}\n`);

    function handleEvent(event, data) {
      debug(`Received event: ${event}\n`);
      debug(`Received event data: ${JSON.stringify(data)}\n`);

      if (event === 'text') {
        process.send({
          type: 'stream',
          requestID: requestID,
          partialText: data.text
        });
        return data.text;
      } else if (event === 'replace_response') {
        process.send({
          type: 'stream',
          requestID: requestID,
          partialText: data.text
        });
        return data.text;
      } else {
        debug(`Unsupported event: ${event}\n`);
      }

      return null;
    }

    let responseText = '';
    
    const req = https.request(options, (res) => {
      debug(`Response status code: ${res.statusCode}\n`);
      debug(`Response headers: ${JSON.stringify(res.headers)}\n`);

      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
        debug(`Received data: ${chunk}\n`);

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
