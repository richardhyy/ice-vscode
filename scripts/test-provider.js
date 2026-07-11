#!/usr/bin/env node
/**
 * Standalone provider test harness.
 *
 * Forks an ICE provider script the same way `src/providerManager.ts` does
 * (IPC child process + `getCompletion` message) and exercises it against a real
 * endpoint, printing the streamed reasoning and answer separately.
 *
 * This lets you iterate on providers systematically from the terminal without
 * launching the full VS Code extension host.
 *
 * Usage:
 *   node scripts/test-provider.js [options]
 *
 * Options:
 *   --provider <name>     Provider folder under providers/ (default: OpenAI_Compatible)
 *   --model <id>          Model id (default: $ICE_TEST_MODEL or gpt-5.5)
 *   --preset <name>       OpenAI-compatible preset, e.g. OpenAI|Ollama|Groq (default: $ICE_TEST_PRESET or OpenAI)
 *   --base-url <url>      OpenAI-style base URL, e.g. http://localhost:8788/v1 (default: $ICE_TEST_BASE_URL; implies the Custom preset)
 *   --host <baseUrl>      Legacy API host (default: $ICE_TEST_HOST) — kept for backward compatibility
 *   --path <path>         Legacy API path (default: $ICE_TEST_PATH) — kept for backward compatibility
 *   --prompt <text>       User prompt (default: a small reasoning question)
 *   --system <text>       System prompt (default: a generic assistant prompt)
 *   --api-key <key>       API key / bearer token (default: $ICE_TEST_API_KEY or empty)
 *   --reasoning <effort>  Optional reasoning effort (e.g. low|medium|high). Sent only if set.
 *   --max-tokens <n>      Max tokens to sample (default: 1024)
 *   --timeout <ms>        Overall timeout (default: 60000)
 *   --verbose             Print raw debug messages from the provider
 *
 * Endpoint, model and key can be supplied via CLI flags or the ICE_TEST_*
 * environment variables so no specific setup needs to be hardcoded here.
 *
 * Exit codes: 0 = completed, 1 = provider error, 2 = timeout, 3 = usage/spawn error.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const child_process = require('child_process');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    if (key === 'verbose' || key === 'tools') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`Missing value for --${key}`);
      process.exit(3);
    }
    args[key] = value;
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const providerName = args.provider || 'OpenAI_Compatible';
const model = args.model || process.env.ICE_TEST_MODEL || 'gpt-5.5';
const baseUrl = args['base-url'] || process.env.ICE_TEST_BASE_URL || '';
const host = args.host || process.env.ICE_TEST_HOST || '';
// A custom Base URL or legacy host implies the "Custom" preset: a recognised
// preset owns its own endpoint and would otherwise ignore these. Mirrors the
// config menu's `@variableImplies BaseURL Preset=Custom`.
const preset = args.preset || process.env.ICE_TEST_PRESET || ((baseUrl || host) ? 'Custom' : 'OpenAI');
const apiPath = args.path || process.env.ICE_TEST_PATH || '';
const prompt = args.prompt || 'What is 23 * 47? Reason it out briefly, then give the final answer.';
const systemPrompt = args.system || 'You are a helpful assistant.';
const apiKey = args['api-key'] || process.env.ICE_TEST_API_KEY || '';
const reasoningEffort = args.reasoning || '';
const maxTokens = args['max-tokens'] || '1024';
const timeoutMs = parseInt(args.timeout || '60000', 10);
const verbose = Boolean(args.verbose);

const providerPath = path.resolve(__dirname, '..', 'providers', providerName, 'main.js');
if (!fs.existsSync(providerPath)) {
  console.error(`Provider script not found: ${providerPath}`);
  process.exit(3);
}

// Config mirrors the merged config that ProviderManager passes to a provider.
const config = {
  APIKey: apiKey,
  Preset: preset,
  Model: model,
  MaxTokensToSample: maxTokens,
  SystemPrompt: systemPrompt,
  Temperature: '0.7',
  LogitBias: '{}',
  AdditionalHeaders: '{}',
};
if (baseUrl) {
  config.BaseURL = baseUrl;
}
// Legacy host/path override (still honoured by the OpenAI-compatible provider).
if (host) {
  config.APIHost = host;
}
if (apiPath) {
  config.APIPath = apiPath;
}
if (reasoningEffort) {
  config.ReasoningEffort = reasoningEffort;
}

const requestID = 'harness-' + Date.now();
const messageTrail = [
  { id: 1, role: 'user', content: prompt, parentID: null, timestamp: new Date().toISOString() },
];

const endpointDescription = baseUrl
  ? `${baseUrl.replace(/\/$/, '')}/chat/completions`
  : host
    ? `${host}${apiPath || '/v1/chat/completions'}`
    : `preset: ${preset}`;

console.log('─'.repeat(72));
console.log(`Provider : ${providerName}  (${providerPath})`);
console.log(`Endpoint : ${endpointDescription}`);
console.log(`Model    : ${model}${reasoningEffort ? `  (reasoning: ${reasoningEffort})` : ''}`);
console.log(`Prompt   : ${prompt}`);
console.log('─'.repeat(72));

const child = child_process.fork(providerPath, [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env,
    ICE_PROVIDER_ID: `${providerName}@harness`,
    ICE_PROVIDER_CONFIG: JSON.stringify(config),
  },
});

let reasoningText = '';
let contentText = '';
let reasoningHeaderShown = false;
let answerHeaderShown = false;
let finished = false;

const timer = setTimeout(() => {
  console.error(`\n\n[timeout] No completion after ${timeoutMs}ms`);
  cleanup(2);
}, timeoutMs);

function cleanup(code) {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timer);
  try {
    child.kill();
  } catch (_) {
    /* ignore */
  }
  process.exit(code);
}

child.stderr.on('data', (data) => {
  process.stderr.write(`[provider stderr] ${data}`);
});

child.on('message', (message) => {
  switch (message.type) {
    case 'stream': {
      if (message.reasoningText) {
        if (!reasoningHeaderShown) {
          process.stdout.write('\nREASONING\n');
          reasoningHeaderShown = true;
        }
        reasoningText += message.reasoningText;
        process.stdout.write(message.reasoningText);
      }
      if (message.partialText) {
        if (!answerHeaderShown) {
          process.stdout.write(`${reasoningHeaderShown ? '\n' : ''}\n💬 ANSWER\n`);
          answerHeaderShown = true;
        }
        contentText += message.partialText;
        process.stdout.write(message.partialText);
      }
      break;
    }
    case 'done':
      console.log(`\nDone. reasoning: ${reasoningText.length} chars, answer: ${contentText.length} chars`);
      if (message.model) {
        console.log(`   model: ${message.model}`);
      }
      if (message.usage) {
        console.log(`   usage: ${JSON.stringify(message.usage)}`);
      }
      if (message.toolCalls && message.toolCalls.length) {
        console.log(`   toolCalls: ${JSON.stringify(message.toolCalls)}`);
      }
      if (reasoningText.length === 0) {
        console.log('   (no reasoning stream received — model/endpoint may not emit reasoning)');
      }
      cleanup(0);
      break;
    case 'error':
      console.error(`\nProvider error: ${message.error}`);
      cleanup(1);
      break;
    case 'warning':
      console.warn(`\nProvider warning: ${message.content}`);
      break;
    case 'debug':
      if (verbose) {
        process.stderr.write(`[debug] ${message.content}`);
      }
      break;
    default:
      if (verbose) {
        console.error(`[unknown message] ${JSON.stringify(message)}`);
      }
  }
});

child.on('error', (err) => {
  console.error(`\nFailed to run provider: ${err.message}`);
  cleanup(3);
});

child.on('exit', (code, signal) => {
  if (!finished) {
    console.error(`\nProvider exited early (code=${code}, signal=${signal})`);
    cleanup(1);
  }
});

// Optional sample tools to exercise tool calling (enabled with --tools).
const tools = args.tools
  ? [
      {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        inputSchema: {
          type: 'object',
          properties: { location: { type: 'string', description: 'City name' } },
          required: ['location'],
        },
      },
    ]
  : [];

// Kick off the request, mirroring ProviderManager's initialize + getCompletion.
child.send({ type: 'initialize', id: `${providerName}@harness` });
child.send({ type: 'getCompletion', requestID, messageTrail, config, tools });
