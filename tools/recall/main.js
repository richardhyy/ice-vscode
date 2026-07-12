// ==ICETool==
// @name         recall
// @description  Search your saved conversations (the .chat files in this workspace) for something discussed in the past. Read-only, and nothing reaches the assistant until you review the matches and approve what to share.
// ==/ICETool==
'use strict';

/**
 * A built-in ICE tool: a long-term memory helper.
 *
 * It searches the other `.chat` files in the workspace for messages matching a
 * query and offers them back to the model, but only with the user's explicit
 * consent. Past conversations are private by default, so the tool never returns a
 * match to the assistant on its own: it does the (read-only) search, shows the
 * user what it found, and asks what to share. The user can disclose the full
 * matches, only a summary (which conversations matched, without the message
 * text), or nothing at all. That disclosure gate is the whole point of the tool:
 * recall that stays under the user's control.
 *
 * It reads `.chat` files directly (via `context.session`, which tells it the
 * workspace roots and the current file to exclude); it never writes anything.
 */

const fs = require('fs');
const path = require('path');
const chat = require('../_lib/chat');

// Safety bounds so a search over a large workspace stays quick and bounded.
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 300;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RETURN_CHARS = 8000;

// Directories never worth walking for saved conversations.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.cache', 'coverage']);

/** Recursively collects `.chat` files under `root`, bounded and excluding `excludeFile`. */
function collectChatFiles(root, excludeFile, found) {
  if (found.length >= MAX_FILES) {
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_error) {
    return;
  }
  for (const entry of entries) {
    if (found.length >= MAX_FILES) {
      return;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // Skip heavy build/vcs folders and hidden directories.
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      collectChatFiles(full, excludeFile, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.chat')) {
      if (excludeFile && path.resolve(full) === path.resolve(excludeFile)) {
        continue;
      }
      found.push(full);
    }
  }
}

/** A short title for a conversation: its first user message, else the file name. */
function conversationTitle(tree, file) {
  for (const id of tree.order) {
    const node = tree.nodes.get(id);
    if (node && node.role === 'user' && String(node.content || '').trim()) {
      return chat.snippet(node.content, 70);
    }
  }
  return path.basename(file);
}

/** The shortest workspace-relative label for a file path (falls back to its name). */
function relativeLabel(bases, file) {
  let best = null;
  for (const base of bases) {
    const relative = path.relative(base, file);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      if (best === null || relative.length < best.length) {
        best = relative;
      }
    }
  }
  return best || path.basename(file);
}

/** Renders one match as a numbered `rel (Role . when)` line with its excerpt beneath. */
function formatMatch(match, index) {
  const meta = [chat.roleLabel(match.role), chat.when(match.timestamp)].filter(Boolean).join(' \u00b7 ');
  return `${index + 1}. ${match.rel}${meta ? '  (' + meta + ')' : ''}\n   ${match.excerpt}`;
}

module.exports = {
  // The search itself is read-only and side-effect free, so the call does not
  // need a run-approval gate. The meaningful consent is on *disclosure*: the
  // elicitation below decides what (if anything) reaches the model.
  readOnly: true,
  arguments: {
    query: {
      type: 'string',
      description: 'What to look for. Space-separated words must all appear in a message (case-insensitive).',
    },
    folder: {
      type: 'string',
      optional: true,
      description: 'Limit the search to this folder (relative to the workspace, or an absolute path). Defaults to the whole workspace.',
    },
    max_results: {
      type: 'number',
      optional: true,
      range: [1, 50],
      description: 'How many matching messages to return at most (default 10, most recent first).',
    },
  },
  async call({ query, folder, max_results }, context) {
    const termList = chat.terms(query);
    if (termList.length === 0) {
      throw new Error('`query` is required (one or more words to search for).');
    }

    const session = (context && context.session) || {};
    const bases = Array.isArray(session.workspaceFolders) && session.workspaceFolders.length
      ? session.workspaceFolders.slice()
      : (session.dir ? [session.dir] : []);
    if (bases.length === 0) {
      throw new Error('There is no workspace folder to search. Open a folder, or place this conversation inside one.');
    }

    // Resolve the roots to walk: a given folder (relative to each workspace root,
    // or absolute), otherwise every workspace root.
    let roots;
    if (folder && String(folder).trim()) {
      roots = [];
      const raw = String(folder).trim();
      if (path.isAbsolute(raw)) {
        if (fs.existsSync(raw)) {
          roots.push(raw);
        }
      } else {
        for (const base of bases) {
          const candidate = path.resolve(base, raw);
          if (fs.existsSync(candidate)) {
            roots.push(candidate);
          }
        }
      }
      if (roots.length === 0) {
        throw new Error(`Folder not found: ${folder}`);
      }
    } else {
      roots = bases;
    }

    // Gather candidate files (excluding the current conversation - this is about
    // *other* conversations).
    const files = [];
    const seen = new Set();
    for (const root of roots) {
      const collected = [];
      collectChatFiles(root, session.file, collected);
      for (const file of collected) {
        const key = path.resolve(file);
        if (!seen.has(key)) {
          seen.add(key);
          files.push(file);
        }
      }
    }
    if (files.length === 0) {
      return `No other saved conversations were found to search${folder ? ` in "${folder}"` : ''}.`;
    }

    if (context && context.progress) {
      context.progress({ message: `Searching ${files.length} saved conversation${files.length === 1 ? '' : 's'}\u2026` });
    }

    // Scan each file for matching messages, reporting rough progress along the way.
    const matches = [];
    const byFile = new Map();
    let scanned = 0;
    for (const file of files) {
      if (context && context.signal && context.signal.aborted) {
        break;
      }
      if (matches.length >= MAX_MATCHES) {
        break;
      }
      scanned++;
      let actions;
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) {
          continue;
        }
        actions = chat.loadActions(file);
      } catch (_error) {
        continue;
      }
      const tree = chat.reconstruct(actions);
      let fileMatchCount = 0;
      for (const id of tree.order) {
        const node = tree.nodes.get(id);
        // Skip meta nodes and tool results: recall is about what was actually said
        // in past conversations, not tool output (often large and noisy).
        if (!node || chat.isMeta(node.role) || node.role === 'tool') {
          continue;
        }
        if (chat.matchesAll(node.content, termList)) {
          fileMatchCount++;
          matches.push({
            file,
            rel: relativeLabel(bases, file),
            role: node.role,
            excerpt: chat.matchExcerpt(node.content, termList, 110),
            timestamp: node.timestamp || '',
          });
          if (matches.length >= MAX_MATCHES) {
            break;
          }
        }
      }
      if (fileMatchCount > 0) {
        byFile.set(file, { rel: relativeLabel(bases, file), count: fileMatchCount, title: conversationTitle(tree, file) });
      }
      if (context && context.progress && scanned % 25 === 0) {
        context.progress({ progress: scanned, total: files.length, message: `Searched ${scanned} of ${files.length}\u2026` });
      }
    }

    const quotedQuery = '\u201c' + String(query).trim() + '\u201d';

    // No hit reveals nothing sensitive, so it is safe (and kinder) to just say so
    // rather than making the user approve an empty result.
    if (matches.length === 0) {
      return `No matches for ${quotedQuery} in ${files.length} saved conversation${files.length === 1 ? '' : 's'}.`;
    }

    // Most recent first - that is usually what "recall" wants.
    matches.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const limit = Math.max(1, Math.min(50, Number(max_results) || DEFAULT_MAX_RESULTS));
    const shown = matches.slice(0, limit);
    const conversationCount = byFile.size;

    // Assemble the exact text that would be shared and hand it to the user as an
    // editable field. Nothing is disclosed on its own: what the assistant receives
    // is precisely what the user leaves in the box (and nothing if they empty it).
    let shareable = shown.map(formatMatch).join('\n\n');
    if (matches.length > shown.length) {
      const rest = matches.length - shown.length;
      shareable += `\n\n(${rest} further match${rest === 1 ? '' : 'es'} not shown; refine the query or raise max_results.)`;
    }
    if (shareable.length > MAX_RETURN_CHARS) {
      shareable = shareable.slice(0, MAX_RETURN_CHARS) + '\n\u2026[truncated]';
    }

    const message =
      `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} in ${conversationCount} saved ` +
      `conversation${conversationCount === 1 ? '' : 's'} for ${quotedQuery}.`;
    const fields = {
      type: 'object',
      properties: {
        shared: {
          type: 'string',
          format: 'multiline',
          title: 'What to share',
          description: 'Edit freely. Sent to the assistant only when you choose Share.',
          default: shareable,
        },
      },
      submitLabel: 'Share',
      declineLabel: "Don't share",
    };

    const { action, content } = await context.elicit(message, fields);
    if (action !== 'accept') {
      return 'The user chose not to share any results from their saved conversations.';
    }
    const shared = (content && typeof content.shared === 'string') ? content.shared.trim() : '';
    if (!shared) {
      return 'The user reviewed the matches and chose to share nothing.';
    }
    let out = `The user reviewed and approved sharing the following from their saved conversations (for ${quotedQuery}):\n\n${shared}`;
    if (out.length > MAX_RETURN_CHARS) {
      out = out.slice(0, MAX_RETURN_CHARS) + '\n\u2026[truncated]';
    }
    return out;
  },
};
