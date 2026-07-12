// ==ICETool==
// @name         session_messages
// @description  Look through and tidy the current conversation. Find or read messages in this chat (the open thread, or every branch), and edit or delete a message. Edits and deletions are applied by the editor, shown in place, and can be undone.
// ==/ICETool==
'use strict';

/**
 * A built-in ICE tool: in-session message lookup and light manipulation.
 *
 * Where `recall` reaches across *other* saved conversations (read-only, behind a
 * disclosure gate), this tool works within the *current* one - the `.chat` file
 * the user has open. It can:
 *   - find messages matching a query,
 *   - read a message in full (or map out the conversation tree),
 *   - edit a message's content,
 *   - delete a message and the messages after it (with the user's confirmation).
 *
 * Reads come straight from the file on disk (via `context.session`), so they are
 * always consistent with what the user sees. Writes are never applied here: the
 * tool hands them to the editor through `context.session.apply`, which is the one
 * place conversations are mutated. That keeps every change visible in the
 * transcript, flashed where it lands, and undoable in a single step, exactly like
 * an edit the user made by hand. Because the tool can change the conversation it
 * is not read-only, so (unless the user has turned auto-run on) each call waits
 * for their approval before it runs.
 */

const fs = require('fs');
const chat = require('../_lib/chat');

const MAX_FIND_RESULTS = 40;
const MAX_OUTLINE_LINES = 200;
const MAX_READ_CHARS = 12000;

/** Resolves an id argument (number or string) to `{ id, node }` in the tree, or null. */
function resolveNode(tree, idArg) {
  if (idArg === null || idArg === undefined || idArg === '') {
    return null;
  }
  const candidates = [idArg, Number(idArg), String(idArg)];
  for (const key of candidates) {
    if ((typeof key !== 'number' || !isNaN(key)) && tree.nodes.has(key)) {
      return { id: key, node: tree.nodes.get(key) };
    }
  }
  return null;
}

/** Loads and reconstructs the current conversation, or throws a friendly error. */
function loadSession(context) {
  const session = (context && context.session) || {};
  if (!session.file) {
    throw new Error('There is no saved conversation to work with yet.');
  }
  if (!fs.existsSync(session.file)) {
    throw new Error('The conversation file could not be found on disk.');
  }
  const tree = chat.reconstruct(chat.loadActions(session.file));
  const activePath = Array.isArray(session.activePath) ? session.activePath.map(String) : [];
  return { session, tree, activePath, activeSet: new Set(activePath) };
}

/** The ids to consider for a scope: the open thread (default) or the whole tree. */
function idsForScope(tree, activePath, scope) {
  if (scope === 'all') {
    return tree.order.slice();
  }
  // The active thread, in order, limited to ids that still exist.
  return activePath.map((id) => resolveNode(tree, id)).filter(Boolean).map((hit) => hit.id);
}

/** A `#id [Role . when]` label for a node. */
function nodeLabel(id, node) {
  const meta = [chat.roleLabel(node.role), chat.when(node.timestamp)].filter(Boolean).join(' \u00b7 ');
  return `#${id} [${meta}]`;
}

/** find: list messages matching a query within the chosen scope. */
function doFind(args, loaded) {
  const termList = chat.terms(args.query);
  if (termList.length === 0) {
    throw new Error('`query` is required for a find (one or more words to search for).');
  }
  const scope = args.scope === 'all' ? 'all' : 'thread';
  const ids = idsForScope(loaded.tree, loaded.activePath, scope);
  const where = scope === 'all' ? 'conversation (all branches)' : 'current thread';

  const hits = [];
  for (const id of ids) {
    const node = loaded.tree.nodes.get(id);
    if (!node || chat.isMeta(node.role)) {
      continue;
    }
    if (chat.matchesAll(node.content, termList)) {
      hits.push({ id, node });
      if (hits.length >= MAX_FIND_RESULTS) {
        break;
      }
    }
  }

  const quoted = '\u201c' + String(args.query).trim() + '\u201d';
  if (hits.length === 0) {
    return `No messages in the ${where} match ${quoted}.`;
  }
  const lines = hits.map(({ id, node }) => `${nodeLabel(id, node)}\n   ${chat.matchExcerpt(node.content, termList, 110)}`);
  return (
    `${hits.length} match${hits.length === 1 ? '' : 'es'} for ${quoted} in the ${where}. ` +
    'Use read/edit/delete with a #id.\n\n' +
    lines.join('\n\n')
  );
}

/** read: the full content of one message, or an outline of the scope. */
function doRead(args, loaded) {
  // A specific message, in full.
  if (args.id !== undefined && args.id !== null && args.id !== '') {
    const hit = resolveNode(loaded.tree, args.id);
    if (!hit) {
      return `No message with id ${args.id} exists in this conversation.`;
    }
    if (chat.isMeta(hit.node.role)) {
      return `${nodeLabel(hit.id, hit.node)} is a meta node (settings/tooling), not a conversation message.`;
    }
    let content = String(hit.node.content == null ? '' : hit.node.content);
    if (content.length > MAX_READ_CHARS) {
      content = content.slice(0, MAX_READ_CHARS) + '\n\u2026[truncated]';
    }
    const onThread = loaded.activeSet.has(String(hit.id));
    return `${nodeLabel(hit.id, hit.node)}${onThread ? '' : '  (on another branch, not the open thread)'}\n\n${content || '(empty)'}`;
  }

  // No id: an outline of the conversation within scope.
  const scope = args.scope === 'all' ? 'all' : 'thread';
  if (scope === 'thread') {
    const ids = idsForScope(loaded.tree, loaded.activePath, 'thread');
    const lines = ids
      .map((id) => ({ id, node: loaded.tree.nodes.get(id) }))
      .filter((entry) => entry.node && !chat.isMeta(entry.node.role))
      .map((entry) => `${nodeLabel(entry.id, entry.node)}: ${chat.snippet(entry.node.content, 100)}`);
    if (lines.length === 0) {
      return 'The current thread has no conversation messages yet.';
    }
    return `The current thread, in order (${lines.length} message${lines.length === 1 ? '' : 's'}):\n\n` + lines.join('\n');
  }

  // Whole tree: a depth-first outline that shows the branch structure. A "*"
  // marks messages on the thread the user is currently viewing.
  const roots = loaded.tree.order.filter((id) => {
    const parentID = loaded.tree.nodes.get(id).parentID;
    return parentID === null || parentID === undefined || !loaded.tree.nodes.has(parentID);
  });
  const lines = [];
  const walk = (id, depth) => {
    if (lines.length >= MAX_OUTLINE_LINES) {
      return;
    }
    const node = loaded.tree.nodes.get(id);
    if (node && !chat.isMeta(node.role)) {
      const marker = loaded.activeSet.has(String(id)) ? '*' : ' ';
      lines.push(`${marker} ${'  '.repeat(depth)}${nodeLabel(id, node)}: ${chat.snippet(node.content, 80)}`);
    }
    const children = loaded.tree.childrenOf.get(id) || [];
    const childDepth = node && chat.isMeta(node.role) ? depth : depth + 1;
    for (const child of children) {
      walk(child, childDepth);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  if (lines.length === 0) {
    return 'This conversation has no messages yet.';
  }
  let out = `The whole conversation tree ("*" marks the open thread):\n\n` + lines.join('\n');
  if (lines.length >= MAX_OUTLINE_LINES) {
    out += '\n\u2026[outline truncated]';
  }
  return out;
}

/** Reads the per-operation outcome out of an apply result. */
function operationOutcome(result, op, id) {
  if (result && Array.isArray(result.results)) {
    const match = result.results.find((entry) => entry && entry.op === op && String(entry.id) === String(id));
    if (match) {
      return match;
    }
  }
  if (result && result.ok) {
    return { ok: true };
  }
  return { ok: false, error: (result && result.error) || 'The editor did not apply the change.' };
}

/** edit: replace a message's content, applied by the editor. */
async function doEdit(args, loaded, context) {
  const hit = resolveNode(loaded.tree, args.id);
  if (!hit) {
    return { content: `No message with id ${args.id} exists in this conversation.`, isError: true };
  }
  if (chat.isMeta(hit.node.role)) {
    return { content: `#${hit.id} is a meta node (settings/tooling) and cannot be edited here.`, isError: true };
  }
  if (args.content === undefined || args.content === null) {
    return { content: '`content` is required for an edit (the new message text).', isError: true };
  }
  if (!context.session || typeof context.session.apply !== 'function') {
    return { content: 'This conversation cannot be edited right now.', isError: true };
  }

  const result = await context.session.apply([{ op: 'edit', id: hit.id, content: String(args.content) }]);
  const outcome = operationOutcome(result, 'edit', hit.id);
  if (!outcome.ok) {
    return { content: `Could not edit #${hit.id}: ${outcome.error}`, isError: true };
  }
  const onThread = loaded.activeSet.has(String(hit.id));
  return {
    content:
      `Edited #${hit.id}. The change is now shown in the editor and can be undone. ` +
      (onThread
        ? 'Replies after it may now be out of date with its new content.'
        : 'It is on another branch, so the open thread is unchanged.'),
    isError: false,
  };
}

/** Collects a message and every message beneath it, depth-first (the target first). */
function collectSubtree(tree, rootID) {
  const ids = [];
  const visit = (id) => {
    if (!tree.nodes.has(id)) {
      return;
    }
    ids.push(id);
    for (const child of (tree.childrenOf.get(id) || [])) {
      visit(child);
    }
  };
  visit(rootID);
  return ids;
}

/**
 * delete: remove a message and everything after it in its branch.
 *
 * A message can't be removed on its own without orphaning whatever follows it, so
 * a delete always takes the message together with its whole subtree. Rather than
 * refuse (in a live chat almost every message has something after it), the tool
 * shows the user the exact list of messages that would go and asks them to
 * confirm the scope before anything is removed. The deletion is then applied by
 * the editor, visibly and undoably.
 */
async function doDelete(args, loaded, context) {
  const hit = resolveNode(loaded.tree, args.id);
  if (!hit) {
    return { content: `No message with id ${args.id} exists in this conversation.`, isError: true };
  }
  if (chat.isMeta(hit.node.role)) {
    return { content: `#${hit.id} is a meta node (settings/tooling) and cannot be deleted here.`, isError: true };
  }
  if (!context.session || typeof context.session.apply !== 'function') {
    return { content: 'This conversation cannot be edited right now.', isError: true };
  }

  const subtree = collectSubtree(loaded.tree, hit.id);
  const conversation = subtree.filter((id) => {
    const node = loaded.tree.nodes.get(id);
    return node && !chat.isMeta(node.role);
  });
  const count = conversation.length;
  const metaCount = subtree.length - count;

  // Show the user exactly what would be removed and let them confirm the scope.
  const SHOWN = 40;
  const listLines = conversation.slice(0, SHOWN).map((id) => {
    const node = loaded.tree.nodes.get(id);
    return `- ${nodeLabel(id, node)}: ${chat.snippet(node.content, 90)}`;
  });
  if (conversation.length > SHOWN) {
    listLines.push(`\u2026and ${conversation.length - SHOWN} more.`);
  }
  const following = count > 1 ? ` and the ${count - 1} message${count - 1 === 1 ? '' : 's'} after it` : '';
  const metaNote = metaCount > 0 ? `\n\n(Plus ${metaCount} settings/tooling node${metaCount === 1 ? '' : 's'} attached to them.)` : '';
  const message =
    `Delete #${hit.id}${following}? This removes ${count === 1 ? 'it' : 'them'} from the conversation, and can be undone.` +
    `\n\n${listLines.join('\n')}${metaNote}`;
  const fields = {
    type: 'object',
    properties: {},
    submitLabel: count === 1 ? 'Delete' : `Delete ${count}`,
    declineLabel: 'Keep',
  };

  const { action } = await context.elicit(message, fields);
  if (action !== 'accept') {
    return `The user chose to keep ${count === 1 ? 'the message' : 'the messages'}.`;
  }

  const result = await context.session.apply(subtree.map((id) => ({ op: 'delete', id })));
  if (!result || !result.ok) {
    const failed = (result && Array.isArray(result.results)) ? result.results.find((entry) => entry && !entry.ok) : null;
    const detail = failed && failed.error ? ` (${failed.error})` : (result && result.error ? ` (${result.error})` : '');
    return { content: `Could not delete #${hit.id}${detail}.`, isError: true };
  }
  return `Deleted ${count} message${count === 1 ? '' : 's'} starting at #${hit.id}. The change is shown in the editor and can be undone.`;
}

module.exports = {
  // Not read-only: this tool can change the conversation, so its calls are gated
  // by the usual run approval (unless the user has enabled auto-run). Reads of the
  // current conversation are safe - it is already what the user is looking at -
  // and every write is applied by the editor, visibly and undoably.
  readOnly: false,
  arguments: {
    action: {
      type: 'string',
      enum: ['find', 'read', 'edit', 'delete'],
      description: 'find: search this conversation. read: show a message in full, or (with no id) an outline. edit: replace a message. delete: remove a message and everything after it in its branch (the user confirms the list first).',
    },
    query: {
      type: 'string',
      optional: true,
      description: 'For find: space-separated words that must all appear in a message (case-insensitive).',
    },
    id: {
      type: 'number',
      optional: true,
      description: 'For read/edit/delete: the message id shown as #id in find/read results.',
    },
    content: {
      type: 'string',
      optional: true,
      description: 'For edit: the full new content for the message.',
    },
    scope: {
      type: 'string',
      optional: true,
      enum: ['thread', 'all'],
      description: 'For find/read: "thread" (default) looks only at the open conversation; "all" covers every branch, including ones not currently shown.',
    },
  },
  async call(args, context) {
    const action = args && args.action;
    if (!action) {
      throw new Error('`action` is required (find, read, edit, or delete).');
    }

    const loaded = loadSession(context);
    switch (action) {
      case 'find':
        return doFind(args, loaded);
      case 'read':
        return doRead(args, loaded);
      case 'edit':
        return doEdit(args, loaded, context);
      case 'delete':
        return doDelete(args, loaded, context);
      default:
        throw new Error(`Unknown action "${action}". Use find, read, edit, or delete.`);
    }
  },
};
