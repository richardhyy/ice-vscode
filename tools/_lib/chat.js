'use strict';

/**
 * Shared helpers for reading `.chat` files from inside an ICE tool.
 *
 * A `.chat` file is an append-only YAML log of `{ action: Add | Edit | Delete }`
 * entries; the conversation is the tree you get by replaying them (Add creates a
 * node, Edit merges into it, Delete removes it) and following `parentID` links.
 * The active thread the user is looking at is a UI concept and is NOT stored in
 * the file, so the host passes it to a tool as `context.session.activePath`.
 *
 * This module is not an ICE tool itself (no `==ICETool==` header, and it lives in
 * an `_`-prefixed folder so tool discovery skips it); it is required by the tools
 * that need to parse conversations, and webpack inlines it into each tool bundle.
 */

const fs = require('fs');
const yaml = require('js-yaml');

/** Content that starts with `#` (e.g. `#head`/`#config`/`#tools`) is meta, not conversation. */
const META_PREFIX = '#';

/** Reads and parses a `.chat` file's action log. Returns [] for an empty/blank file. */
function loadActions(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const actions = yaml.load(text);
  return Array.isArray(actions) ? actions : [];
}

/**
 * Replays an action log into the current conversation tree.
 *
 * Returns { nodes, order, childrenOf } where `nodes` is a Map(id -> message),
 * `order` lists surviving ids in creation order, and `childrenOf` maps a node id
 * to its children (also in creation order). Nodes orphaned by a deleted ancestor
 * are pruned, mirroring how the editor reconciles the tree, so what a tool sees
 * matches what the user sees.
 */
function reconstruct(actions) {
  const nodes = new Map();
  const created = [];

  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      continue;
    }
    if (action.action === 'Add') {
      const node = Object.assign({}, action);
      delete node.action;
      nodes.set(node.id, node);
      created.push(node.id);
    } else if (action.action === 'Edit') {
      const existing = nodes.get(action.id);
      if (existing) {
        const merged = Object.assign({}, existing, action);
        delete merged.action;
        nodes.set(action.id, merged);
      }
    } else if (action.action === 'Delete') {
      nodes.delete(action.id);
    }
  }

  // Prune orphans (a node whose parent is gone), repeating until stable so a
  // whole detached subtree disappears - exactly what the editor shows.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of nodes) {
      if (node.parentID !== null && node.parentID !== undefined && !nodes.has(node.parentID)) {
        nodes.delete(id);
        changed = true;
      }
    }
  }

  const childrenOf = new Map();
  const order = [];
  for (const id of created) {
    if (!nodes.has(id)) {
      continue;
    }
    order.push(id);
    const parentID = nodes.get(id).parentID;
    if (parentID !== null && parentID !== undefined) {
      if (!childrenOf.has(parentID)) {
        childrenOf.set(parentID, []);
      }
      childrenOf.get(parentID).push(id);
    }
  }

  return { nodes, order, childrenOf };
}

/** True when a role is a meta node (`#head`, `#config`, `#tools`, ...), not conversation content. */
function isMeta(role) {
  return typeof role === 'string' && role.charAt(0) === META_PREFIX;
}

/** The path (root -> id) of node ids leading to `id`, or [] if it is unknown. */
function pathTo(tree, id) {
  const path = [];
  const seen = new Set();
  let current = id;
  while (current !== null && current !== undefined && tree.nodes.has(current) && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = tree.nodes.get(current).parentID;
  }
  return path;
}

/** A one-line, whitespace-collapsed excerpt of `content`, at most `max` chars. */
function snippet(content, max) {
  const flat = String(content == null ? '' : content).replace(/\s+/g, ' ').trim();
  const limit = max || 140;
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + '\u2026' : flat;
}

/**
 * An excerpt of `content` centred on the first match of any term (case-insensitive),
 * so a search hit shows the words in context rather than just the opening line.
 */
function matchExcerpt(content, terms, radius) {
  const flat = String(content == null ? '' : content).replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (at === -1 || index < at)) {
      at = index;
    }
  }
  const span = radius || 90;
  if (at === -1) {
    return snippet(flat, span * 2);
  }
  const start = Math.max(0, at - span);
  const end = Math.min(flat.length, at + span);
  return (start > 0 ? '\u2026' : '') + flat.slice(start, end).trim() + (end < flat.length ? '\u2026' : '');
}

/** Splits a query into lowercased terms; a message matches when it contains them all. */
function terms(query) {
  return String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when `content` contains every term (case-insensitive). */
function matchesAll(content, termList) {
  if (termList.length === 0) {
    return false;
  }
  const lower = String(content == null ? '' : content).toLowerCase();
  return termList.every((term) => lower.indexOf(term) !== -1);
}

/** A short, human label for a role, used in previews and transcripts. */
function roleLabel(role) {
  if (role === 'user') {
    return 'You';
  }
  if (role === 'assistant') {
    return 'Assistant';
  }
  if (role === 'tool') {
    return 'Tool';
  }
  return String(role || 'message');
}

/** Formats an ISO timestamp as a compact UTC date-time, or '' if absent/invalid. */
function when(timestamp) {
  if (!timestamp) {
    return '';
  }
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

module.exports = {
  loadActions,
  reconstruct,
  isMeta,
  pathTo,
  snippet,
  matchExcerpt,
  terms,
  matchesAll,
  roleLabel,
  when,
};
