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
 * A running `execute` call is a small bidirectional session, not a single
 * request/response: the tool receives a `context` with real capabilities
 * (progress reporting, a cancellation signal, and form-mode elicitation), and
 * the host relays those over IPC. These are ICE tool capabilities, not anything
 * MCP-specific; the MCP bridge is just one tool that forwards them.
 *
 * Messages in:  { type: 'introspect' | 'listTools' | 'execute' | 'cancel' | 'elicitResult' | 'sessionApplyResult', requestID, ... }
 * Messages out: { type: 'definition' | 'tools' | 'result' | 'progress' | 'elicit' | 'sessionApply' | 'toolsError' | 'error', requestID, ... }
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

// In-flight `execute` calls, keyed by requestID, so a later `cancel` or
// `elicitResult` message can reach the right call. Each entry owns an
// AbortController (its signal is handed to the tool) and a map of outstanding
// elicitation resolvers.
const activeCalls = new Map();

/**
 * Builds the `context` handed to a tool's `call`. Everything here is an ICE tool
 * capability, offered uniformly to every tool (built-in, custom, or the MCP
 * bridge); each method is optional for a tool to use and a no-op-safe if unused.
 */
function buildContext(requestID, config, session) {
  const controller = new AbortController();
  const entry = { controller, elicitations: new Map(), elicitCounter: 0, sessionApplies: new Map(), applyCounter: 0 };
  activeCalls.set(requestID, entry);

  const sessionInfo = session || {};

  return {
    config: config || {},
    // Aborts when the user stops the call (or it times out). Pass it to fetch(),
    // an MCP callTool, or check `signal.aborted` in a loop.
    signal: controller.signal,
    // Report progress for this call: { progress, total?, message? } or a string.
    progress(update) {
      if (!process.send || controller.signal.aborted) {
        return;
      }
      const payload = (update && typeof update === 'object') ? update : { message: update == null ? '' : String(update) };
      process.send({ type: 'progress', requestID, progress: payload });
    },
    // Ask the user for structured input mid-call (form-mode elicitation). `fields`
    // is ICE's friendly `arguments` shape or a ready JSON schema; the host relays
    // it and resolves with { action: 'accept'|'decline'|'cancel', content? }.
    elicit(message, fields) {
      if (controller.signal.aborted || !process.send) {
        return Promise.resolve({ action: 'cancel' });
      }
      const elicitationID = 'el-' + (entry.elicitCounter++);
      return new Promise((resolve) => {
        entry.elicitations.set(elicitationID, resolve);
        process.send({ type: 'elicit', requestID, elicitationID, message: message == null ? '' : String(message), fields: fields || {} });
      });
    },
    // The current conversation this call belongs to. The read fields describe
    // where it lives (so a tool can read the file itself, or other `.chat` files
    // in the workspace) and which thread the user is viewing. `apply` is the only
    // way to *change* it: the tool never writes directly, it asks the editor to,
    // so every change stays visible in the transcript and undoable in one step.
    session: {
      file: sessionInfo.file || null,
      dir: sessionInfo.dir || null,
      workspaceFolders: Array.isArray(sessionInfo.workspaceFolders) ? sessionInfo.workspaceFolders : [],
      activePath: Array.isArray(sessionInfo.activePath) ? sessionInfo.activePath : [],
      // Ask the editor to apply message operations to the current conversation
      // (e.g. { op: 'edit', id, content } or { op: 'delete', id }). Resolves with
      // { ok, results: [{ id, op, ok, error? }] }. Mirrors elicit: the host relays
      // the request and the answer comes back over IPC.
      apply(operations) {
        if (controller.signal.aborted || !process.send) {
          return Promise.resolve({ ok: false, error: 'The call was stopped.' });
        }
        const applyID = 'ap-' + (entry.applyCounter++);
        return new Promise((resolve) => {
          entry.sessionApplies.set(applyID, resolve);
          process.send({ type: 'sessionApply', requestID, applyID, operations: Array.isArray(operations) ? operations : [] });
        });
      },
    },
  };
}

/** Tears a call down, resolving any dangling elicitations as cancelled. */
function endCall(requestID) {
  const entry = activeCalls.get(requestID);
  if (!entry) {
    return;
  }
  activeCalls.delete(requestID);
  for (const resolve of entry.elicitations.values()) {
    try {
      resolve({ action: 'cancel' });
    } catch (_error) {
      // ignore
    }
  }
  for (const resolve of entry.sessionApplies.values()) {
    try {
      resolve({ ok: false, error: 'The call ended before the change was applied.' });
    } catch (_error) {
      // ignore
    }
  }
}

process.on('message', async (message) => {
  const requestID = message.requestID;

  // Out-of-band control for an in-flight call: cancellation and elicitation
  // responses are not requests of their own, they steer an existing `execute`.
  if (message.type === 'cancel') {
    const entry = activeCalls.get(requestID);
    if (entry) {
      try {
        entry.controller.abort();
      } catch (_error) {
        // ignore
      }
      for (const [id, resolve] of [...entry.elicitations]) {
        entry.elicitations.delete(id);
        try {
          resolve({ action: 'cancel' });
        } catch (_error) {
          // ignore
        }
      }
      for (const [id, resolve] of [...entry.sessionApplies]) {
        entry.sessionApplies.delete(id);
        try {
          resolve({ ok: false, error: 'The call was stopped.' });
        } catch (_error) {
          // ignore
        }
      }
    }
    return;
  }
  if (message.type === 'sessionApplyResult') {
    const entry = activeCalls.get(requestID);
    const resolve = entry && entry.sessionApplies.get(message.applyID);
    if (resolve) {
      entry.sessionApplies.delete(message.applyID);
      resolve(message.result || { ok: false });
    }
    return;
  }
  if (message.type === 'elicitResult') {
    const entry = activeCalls.get(requestID);
    const resolve = entry && entry.elicitations.get(message.elicitationID);
    if (resolve) {
      entry.elicitations.delete(message.elicitationID);
      resolve({ action: message.action || 'cancel', content: message.content });
    }
    return;
  }

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
      // `context` carries this call's capabilities (config, cancellation signal,
      // progress, elicitation, and the current session). It is always torn down
      // when the call settles.
      const context = buildContext(requestID, message.config, message.session);
      try {
        const result = isSource
          ? await tool.call(message.name, message.arguments || {}, context)
          : await tool.call(message.arguments || {}, context);
        process.send({ type: 'result', requestID, ...normalizeResult(result) });
      } finally {
        endCall(requestID);
      }
    }
  } catch (error) {
    const errorMessage = (error && error.message) ? error.message : String(error);
    if (message.type === 'execute') {
      // A thrown error becomes a model-facing error result (Apple's "throw or
      // return a string" model), never a crash. (If the throw was the tool
      // honouring an abort, the host has already settled this call as stopped and
      // ignores this late result.)
      endCall(requestID);
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
