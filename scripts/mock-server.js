#!/usr/bin/env node
/**
 * Zero-dependency mock LLM server for free, deterministic testing.
 *
 * Speaks just enough of the OpenAI Chat Completions API for ICE's
 * OpenAI_Compatible provider to stream against it — no network, no API key, no
 * cost. It streams reasoning (`delta.reasoning_text`) and answer
 * (`delta.content`) in small chunks so it can exercise the webview's
 * incremental renderer (code fences, lists, multi-paragraph, reasoning->answer
 * handoff) under realistic token pacing.
 *
 * Usage:
 *   node scripts/mock-server.js                 # listens on :8788
 *   MOCK_PORT=9000 MOCK_DELAY_MS=25 node scripts/mock-server.js
 *
 * Point a provider at it, e.g. with the test harness:
 *   node scripts/test-provider.js \
 *     --host http://localhost:8788 --path /v1/chat/completions \
 *     --model mock-reasoning --api-key test
 *
 * The requested `model` selects a scenario (see SCENARIOS below); unknown models
 * fall back to the `reasoning` scenario.
 */

'use strict';

const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || process.env.PORT || '8788', 10);
const DELAY_MS = parseInt(process.env.MOCK_DELAY_MS || '12', 10);

/**
 * Canned scenarios. Each has an optional `reasoning` stream and a `content`
 * (answer) stream. The markdown is intentionally varied to stress incremental
 * rendering: headings, paragraphs, bullet/numbered lists, fenced code, inline
 * code, emphasis and blockquotes.
 */
const SCENARIOS = {
  plain: {
    content:
      'Sure — here is a short, plain answer.\n\n' +
      'It spans a couple of paragraphs so the streaming caret and the gentle ' +
      'block-entrance animation are both visible as text arrives.\n\n' +
      'That is all there is to it.',
  },
  markdown: {
    content:
      '## Rendering a Markdown answer\n\n' +
      'Here is a paragraph with some **bold**, some *italic*, and a bit of ' +
      '`inline code` mixed in for good measure.\n\n' +
      'A few key points:\n\n' +
      '- First, streaming should feel smooth.\n' +
      '- Second, earlier blocks must stay put.\n' +
      '- Third, the caret marks where text is arriving.\n\n' +
      'And an ordered list:\n\n' +
      '1. Parse the markdown into blocks.\n' +
      '2. Reconcile only what changed.\n' +
      '3. Append new blocks as they start.\n\n' +
      '> A short blockquote to close things out.\n',
  },
  code: {
    content:
      'Here is a small function:\n\n' +
      '```js\n' +
      'function greet(name) {\n' +
      '  const greeting = `Hello, ${name}!`;\n' +
      '  console.log(greeting);\n' +
      '  return greeting;\n' +
      '}\n' +
      '```\n\n' +
      'Call it with `greet("world")` and it prints a greeting.',
  },
  reasoning: {
    reasoning:
      'Let me think about this carefully. The user wants a clear, well-structured ' +
      'answer. First I should restate the idea, then give a concrete example, and ' +
      'finally summarize. A short code sample will make it tangible.',
    content:
      "Here's a structured answer.\n\n" +
      'The core idea is to update only what changed instead of redrawing ' +
      'everything. For example:\n\n' +
      '```python\n' +
      'def stream(blocks, token):\n' +
      '    blocks[-1] += token  # extend the tail in place\n' +
      '    return blocks\n' +
      '```\n\n' +
      'In short: keep stable blocks, grow the last one, and append new ones.',
  },
};

/**
 * Splits text into small, token-like chunks (keeps trailing spaces/newlines with
 * their word) so streaming looks realistic and reconciliation is exercised.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) {
    return [];
  }
  const pieces = text.match(/\s+|\S+/g) || [];
  const chunks = [];
  for (const piece of pieces) {
    if (/^\S+$/.test(piece) && piece.length > 6) {
      // Break long words into a few sub-chunks.
      for (let i = 0; i < piece.length; i += 4) {
        chunks.push(piece.slice(i, i + 4));
      }
    } else {
      chunks.push(piece);
    }
  }
  // Merge a trailing space chunk into the previous chunk to reduce event count.
  const merged = [];
  for (const chunk of chunks) {
    if (/^\s+$/.test(chunk) && merged.length > 0) {
      merged[merged.length - 1] += chunk;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

function sseChunk(delta, finishReason) {
  const payload = {
    id: 'mockcmpl-' + Date.now().toString(36),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function pickScenario(model) {
  if (!model) {
    return SCENARIOS.reasoning;
  }
  const key = String(model).replace(/^mock[-_]?/i, '').toLowerCase();
  return SCENARIOS[key] || SCENARIOS.reasoning;
}

function streamCompletion(req, res, body) {
  const scenario = pickScenario(body && body.model);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const events = [];
  for (const chunk of tokenize(scenario.reasoning)) {
    events.push({ reasoning_text: chunk });
  }
  for (const chunk of tokenize(scenario.content)) {
    events.push({ content: chunk });
  }

  let index = 0;
  let timer = null;
  let aborted = false;

  function stop() {
    aborted = true;
    if (timer) {
      clearTimeout(timer);
    }
  }
  // Detect the client going away via the *response* stream. (Listening on the
  // request fires as soon as its body is consumed, which would abort early.)
  res.on('close', stop);

  function next() {
    if (aborted) {
      return;
    }
    if (index < events.length) {
      res.write(sseChunk(events[index]));
      index++;
      timer = setTimeout(next, DELAY_MS);
      return;
    }
    res.write(sseChunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  }

  next();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: Object.keys(SCENARIOS).map((name) => ({
          id: 'mock-' + name,
          object: 'model',
          owned_by: 'mock',
        })),
      })
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'error', error: { message: 'Invalid JSON body' } }));
        return;
      }
      process.stderr.write(`[mock] completion model=${body.model || '(default)'}\n`);
      streamCompletion(req, res, body);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'error', error: { message: 'Not found' } }));
});

server.listen(PORT, () => {
  process.stderr.write(
    `[mock] OpenAI-compatible mock server on http://localhost:${PORT}\n` +
      `[mock] scenarios: ${Object.keys(SCENARIOS).map((s) => 'mock-' + s).join(', ')} (delay ${DELAY_MS}ms)\n`
  );
});
