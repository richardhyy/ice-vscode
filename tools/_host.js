'use strict';

/**
 * ICE tool host.
 *
 * A fixed harness that runs an ICE tool script in a forked child process and
 * bridges it to the extension over IPC. Tool scripts themselves stay clean,
 * self-describing object exports (no messaging boilerplate) — this file owns the
 * protocol so authoring a tool is as simple as exporting `{ arguments, call }`.
 *
 * The tool script path is passed via the ICE_TOOL_PATH environment variable.
 *
 * Messages in:  { type: 'introspect' | 'listTools' | 'execute', requestID, ... }
 * Messages out: { type: 'definition' | 'tools' | 'result' | 'toolsError' | 'error', requestID, ... }
 */

const toolPath = process.env.ICE_TOOL_PATH;

let tool;
try {
  // eslint-disable-next-line
  tool = require(toolPath);
} catch (error) {
  if (process.send) {
    process.send({ type: 'fatal', error: `Failed to load tool: ${error && error.message ? error.message : error}` });
  }
  process.exit(1);
}

// A tool that exposes `listTools` is a dynamic source (one script, many tools,
// e.g. an MCP bridge); otherwise it is a single tool described by `arguments`.
const isSource = typeof tool.listTools === 'function';

/** Normalizes a tool's return value into { content, isError }. */
function normalizeResult(result) {
  if (typeof result === 'string') {
    return { content: result, isError: false };
  }
  if (result && typeof result === 'object') {
    return { content: result.content != null ? String(result.content) : '', isError: Boolean(result.isError) };
  }
  return { content: result == null ? '' : String(result), isError: false };
}

process.on('message', async (message) => {
  const requestID = message.requestID;

  try {
    if (message.type === 'introspect') {
      process.send({
        type: 'definition',
        requestID,
        isSource,
        name: tool.name,
        description: tool.description,
        arguments: tool.arguments || null,
        readOnly: Boolean(tool.readOnly),
      });
    } else if (message.type === 'listTools') {
      const tools = await tool.listTools(message.config || {});
      process.send({ type: 'tools', requestID, tools: Array.isArray(tools) ? tools : [] });
    } else if (message.type === 'execute') {
      // `context` is the seam for future capabilities (e.g. a session API to look
      // up messages or manipulate the conversation). For now it carries config.
      const context = { config: message.config || {} };
      const result = isSource
        ? await tool.call(message.name, message.arguments || {}, context)
        : await tool.call(message.arguments || {}, context);
      process.send({ type: 'result', requestID, ...normalizeResult(result) });
    }
  } catch (error) {
    const errorMessage = (error && error.message) ? error.message : String(error);
    if (message.type === 'execute') {
      // A thrown error becomes a model-facing error result (Apple's "throw or
      // return a string" model), never a crash.
      process.send({ type: 'result', requestID, content: errorMessage, isError: true });
    } else if (message.type === 'listTools') {
      process.send({ type: 'toolsError', requestID, error: errorMessage });
    } else {
      process.send({ type: 'error', requestID, error: errorMessage });
    }
  }
});

if (process.send) {
  process.send({ type: 'ready' });
}
