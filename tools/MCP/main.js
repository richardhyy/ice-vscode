// ==ICETool==
// @name MCP
// @description Tools from your configured MCP (Model Context Protocol) servers.
// @dynamic true
// @config ice.mcpServers
// ==/ICETool==
'use strict';

/**
 * ICE's MCP bridge, as an ordinary ICE tool.
 *
 * MCP is not special to ICE's core: it is simply one dynamic tool source that
 * happens to speak the Model Context Protocol. This script owns its own MCP
 * client and the whole SDK is bundled into *this* tool's process, so the core
 * extension stays lean and MCP can be edited, replaced, or removed like any
 * other tool.
 *
 * Configuration comes from the `ice.mcpServers` setting (declared via the
 * `@config` header): a map of `{ serverId: { command, args, env, url, headers } }`.
 * The host reads that setting and hands it to `listTools`/`call` as `config` —
 * secrets stay as `${env:VAR}` references and are expanded here, inside the tool
 * process, against its own environment.
 *
 * Interface (a dynamic source):
 *   - listTools(config)          -> [{ name, description, inputSchema, readOnly, sourceLabel }]
 *   - call(name, args, context)  -> { content, isError }
 *
 * Each tool is exposed under a stable `serverId__toolName` name so a single flat
 * list can span several servers; a private index maps that back to the real
 * server and tool for execution.
 */

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CLIENT_NAME = 'ice';
const CLIENT_VERSION = '1.0';

/** Live connections, keyed by server id: { client, transport, configHash, tools }. */
const connections = new Map();

/** In-flight connection attempts, so concurrent callers share one connect. */
const connecting = new Map();

/** Maps an exposed `serverId__toolName` back to its real { serverId, toolName }. */
let index = null;

/** Replaces `${env:VAR}` references with values from this process's environment. */
function expand(value) {
  return String(value).replace(/\$\{env:([^}]+)\}/g, (_match, name) => process.env[name] || '');
}

function expandRecord(record) {
  const out = {};
  for (const key in record || {}) {
    out[key] = expand(record[key]);
  }
  return out;
}

/** Sanitizes a name to the characters model function names allow. */
function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function createTransport(serverId, config) {
  const kind = config.type || (config.url ? 'http' : 'stdio');

  if (kind === 'http') {
    if (!config.url) {
      throw new Error(`MCP server "${serverId}" is missing a url`);
    }
    const headers = expandRecord(config.headers);
    return new StreamableHTTPClientTransport(new URL(expand(config.url)), {
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
  }

  if (!config.command) {
    throw new Error(`MCP server "${serverId}" is missing a command`);
  }
  // Make node/npx findable even when VS Code was launched from the GUI (whose
  // PATH often lacks nvm/homebrew): put the running node's bin dir, plus the
  // usual locations, ahead of the inherited PATH.
  const nodeBinDir = path.dirname(process.execPath);
  const augmentedPath = [nodeBinDir, '/usr/local/bin', '/opt/homebrew/bin', process.env.PATH || '']
    .filter(Boolean)
    .join(path.delimiter);
  return new StdioClientTransport({
    command: expand(config.command),
    args: (config.args || []).map(expand),
    env: { ...getDefaultEnvironment(), PATH: augmentedPath, ...expandRecord(config.env) },
    stderr: 'pipe',
  });
}

async function discoverTools(client) {
  const response = await client.listTools();
  return (response.tools || []).map((tool) => ({
    name: tool.name,
    title: tool.title || (tool.annotations && tool.annotations.title) || undefined,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: Boolean(tool.annotations && tool.annotations.readOnlyHint),
  }));
}

/** Best-effort drain of a stdio server's buffered stderr for diagnostics. */
function drainStderr(transport) {
  const stream = transport && transport.stderr;
  if (!stream || typeof stream.read !== 'function') {
    return '';
  }
  let out = '';
  let chunk;
  while ((chunk = stream.read()) !== null) {
    out += chunk.toString();
  }
  return out.trim().slice(0, 800);
}

/** Builds a helpful error string for a failed connection, including any stderr. */
function describeConnectError(error, transport) {
  let message = (error && error.message) || String(error);
  const stderr = drainStderr(transport);
  if (stderr) {
    message += `\n${stderr}`;
  } else if (/closed/i.test(message)) {
    message += ' — the server process exited during startup. Check that its command is installed and on PATH, and that any file paths/arguments are valid.';
  }
  return message;
}

async function closeConnection(serverId) {
  const conn = connections.get(serverId);
  connections.delete(serverId);
  if (conn && conn.client) {
    try {
      await conn.client.close();
    } catch (_error) {
      // Best-effort teardown.
    }
  }
}

/**
 * Ensures a server is connected with the given config, reusing a healthy
 * connection when the declaration is unchanged and reconnecting when it differs.
 * Concurrent callers share a single in-flight attempt so a server process is
 * never spawned twice at once.
 */
async function ensureConnected(serverId, config) {
  const hash = JSON.stringify(config || {});
  const existing = connections.get(serverId);
  if (existing && existing.client && existing.configHash === hash) {
    return existing;
  }

  const pending = connecting.get(serverId);
  if (pending) {
    return pending;
  }

  const attempt = (async () => {
    if (existing) {
      await closeConnection(serverId);
    }

    const transport = createTransport(serverId, config || {});
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (error) {
      try {
        await client.close();
      } catch (_error) {
        // ignore
      }
      throw new Error(describeConnectError(error, transport));
    }

    // Drain the server's stderr so it can't apply backpressure, and log it.
    const stderrStream = transport.stderr;
    if (stderrStream && typeof stderrStream.on === 'function') {
      stderrStream.on('data', (data) => console.error(`[MCP ${serverId}] ${String(data).trimEnd()}`));
    }

    const tools = await discoverTools(client);
    const connection = { client, transport, configHash: hash, tools };
    connections.set(serverId, connection);
    return connection;
  })().finally(() => connecting.delete(serverId));

  connecting.set(serverId, attempt);
  return attempt;
}

function contentToText(result) {
  const parts = [];
  for (const item of (result && result.content) || []) {
    if (item.type === 'text') {
      parts.push(item.text);
    } else if (item.type === 'resource' && item.resource) {
      const resource = item.resource;
      parts.push(typeof resource.text === 'string' ? resource.text : JSON.stringify(resource));
    } else {
      // Images/audio/other parts are not inlined as text yet; note their presence.
      parts.push(`[${item.type} content]`);
    }
  }
  return parts.join('\n');
}

/**
 * Connects to every configured server and returns their tools as one flat list.
 * Connections are reconciled against `config`: servers that dropped out are
 * closed, and a server that fails to connect is skipped (logged to stderr) so it
 * can't hide the others.
 */
async function listTools(config) {
  const servers = config && typeof config === 'object' ? config : {};
  const wantedIds = Object.keys(servers);

  for (const serverId of [...connections.keys()]) {
    if (!wantedIds.includes(serverId)) {
      await closeConnection(serverId);
    }
  }

  // Build into a LOCAL index and publish it only at the end: two concurrent
  // listTools calls (e.g. a picker refresh racing an add-server probe) must not
  // reset and clobber a shared map — that produced spurious `__tool_2` names.
  const newIndex = new Map();
  const out = [];
  for (const serverId of wantedIds) {
    let connection;
    try {
      connection = await ensureConnected(serverId, servers[serverId]);
    } catch (error) {
      console.error(`[MCP ${serverId}] ${(error && error.message) || error}`);
      continue;
    }
    for (const tool of connection.tools) {
      let name = `${sanitize(serverId)}__${sanitize(tool.name)}`;
      if (newIndex.has(name)) {
        let n = 2;
        while (newIndex.has(`${name}_${n}`)) {
          n++;
        }
        name = `${name}_${n}`;
      }
      newIndex.set(name, { serverId, toolName: tool.name });
      out.push({
        name,
        title: tool.title || tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: tool.readOnly,
        sourceLabel: serverId,
      });
    }
  }
  index = newIndex;
  return out;
}

/**
 * Invokes a tool by its exposed `serverId__toolName` name. If this process is
 * cold (e.g. after a window reload) the index is rebuilt from the passed config
 * first. Connection/execution failures come back as error results.
 */
async function call(name, args, context) {
  const servers = context && context.config && typeof context.config === 'object' ? context.config : {};

  if (!index || !index.has(name)) {
    await listTools(servers);
  }
  const target = index && index.get(name);
  if (!target) {
    throw new Error(`Unknown MCP tool: ${name}`);
  }

  let connection;
  try {
    connection = await ensureConnected(target.serverId, servers[target.serverId]);
  } catch (error) {
    return { content: (error && error.message) || String(error), isError: true };
  }

  try {
    const result = await connection.client.callTool({ name: target.toolName, arguments: args || {} });
    return { content: contentToText(result), isError: Boolean(result.isError) };
  } catch (error) {
    return { content: (error && error.message) || String(error), isError: true };
  }
}

// Best-effort teardown so spawned MCP servers don't linger when this tool
// process is terminated by the host.
function closeAll() {
  for (const serverId of [...connections.keys()]) {
    const conn = connections.get(serverId);
    connections.delete(serverId);
    if (conn && conn.client) {
      try {
        conn.client.close();
      } catch (_error) {
        // ignore
      }
    }
  }
}
process.on('SIGTERM', () => {
  closeAll();
  process.exit(0);
});
process.on('exit', closeAll);

module.exports = { listTools, call };
