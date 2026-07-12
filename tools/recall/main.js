// ==ICETool==
// @name         recall
// @description  Search your saved conversations (the .chat files in this workspace) for something discussed in the past, by message text or file name, optionally within a date range. Read-only, and nothing reaches the assistant until you review the matches and approve what to share.
// ==/ICETool==
'use strict';

/**
 * A built-in ICE tool: a long-term memory helper.
 *
 * It searches the other `.chat` files in the workspace for messages (or file
 * names) matching a query and offers them back to the model, but only with the
 * user's explicit consent. Past conversations are private by default, so the tool
 * never returns a match to the assistant on its own: it does the (read-only)
 * search, shows the user exactly what it found in an editable field, and shares
 * only what the user approves (they can trim it, or share nothing). That
 * disclosure gate is the whole point of the tool: recall that stays under the
 * user's control.
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
  const label = match.byName ? 'name match' : chat.roleLabel(match.role);
  const meta = [label, chat.when(match.timestamp)].filter(Boolean).join(' \u00b7 ');
  return `${index + 1}. ${match.rel}${meta ? '  (' + meta + ')' : ''}\n   ${match.excerpt}`;
}

/**
 * Resolves a fuzzy date expression to the period { start, end } it covers, so a
 * recall search can be limited to a time window. Understands ISO dates and
 * partials (2026, 2026-06, 2026-06-15), month names ("June", "Jun 2026"),
 * keywords (today, yesterday), "this/last week|month|year", "last N days|weeks|
 * months", and "N days|weeks|months|years ago". Returns null if unrecognised.
 * Periods are built in local time, which is what a person means by "yesterday".
 */
function resolveDateExpression(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  const now = new Date();
  const Y = now.getFullYear();
  const Mo = now.getMonth();
  const D = now.getDate();

  const day = (y, m, d) => ({ start: new Date(y, m, d, 0, 0, 0, 0), end: new Date(y, m, d, 23, 59, 59, 999) });
  const monthOf = (y, m) => ({ start: new Date(y, m, 1, 0, 0, 0, 0), end: new Date(y, m + 1, 0, 23, 59, 59, 999) });
  const yearOf = (y) => ({ start: new Date(y, 0, 1, 0, 0, 0, 0), end: new Date(y, 11, 31, 23, 59, 59, 999) });
  const span = (a, b) => ({ start: a, end: b });

  if (lower === 'now') {
    return span(now, now);
  }
  if (lower === 'today') {
    return day(Y, Mo, D);
  }
  if (lower === 'yesterday') {
    const d = new Date(Y, Mo, D - 1);
    return day(d.getFullYear(), d.getMonth(), d.getDate());
  }
  if (lower === 'tomorrow') {
    const d = new Date(Y, Mo, D + 1);
    return day(d.getFullYear(), d.getMonth(), d.getDate());
  }

  let m;
  // "this|last|past week|month|year"
  if ((m = lower.match(/^(this|last|past)\s+(week|month|year)$/))) {
    const which = m[1];
    const unit = m[2];
    if (unit === 'year') {
      return yearOf(which === 'this' ? Y : Y - 1);
    }
    if (unit === 'month') {
      if (which === 'this') {
        return monthOf(Y, Mo);
      }
      const d = new Date(Y, Mo - 1, 1);
      return monthOf(d.getFullYear(), d.getMonth());
    }
    // week: a rolling 7-day window.
    if (which === 'this') {
      return span(new Date(Y, Mo, D - 6, 0, 0, 0, 0), new Date(Y, Mo, D, 23, 59, 59, 999));
    }
    return span(new Date(Y, Mo, D - 13, 0, 0, 0, 0), new Date(Y, Mo, D - 7, 23, 59, 59, 999));
  }

  // "last|past N days|weeks|months|years" -> a window ending now
  if ((m = lower.match(/^(?:last|past)\s+(\d+)\s+(day|week|month|year)s?$/))) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const end = new Date(Y, Mo, D, 23, 59, 59, 999);
    let start;
    if (unit === 'day') {
      start = new Date(Y, Mo, D - (n - 1), 0, 0, 0, 0);
    } else if (unit === 'week') {
      start = new Date(Y, Mo, D - (n * 7 - 1), 0, 0, 0, 0);
    } else if (unit === 'month') {
      start = new Date(Y, Mo - n, D, 0, 0, 0, 0);
    } else {
      start = new Date(Y - n, Mo, D, 0, 0, 0, 0);
    }
    return span(start, end);
  }

  // "N days|weeks|months|years ago" -> that day/period
  if ((m = lower.match(/^(\d+)\s+(day|week|month|year)s?\s+ago$/))) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === 'day') {
      const d = new Date(Y, Mo, D - n);
      return day(d.getFullYear(), d.getMonth(), d.getDate());
    }
    if (unit === 'week') {
      const d = new Date(Y, Mo, D - n * 7);
      return day(d.getFullYear(), d.getMonth(), d.getDate());
    }
    if (unit === 'month') {
      return monthOf(Y, Mo - n);
    }
    return yearOf(Y - n);
  }

  // Month name, optionally with a year: "june", "jun", "June 2026"
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  if ((m = lower.match(/^([a-z]{3,9})\.?(?:\s+(\d{4}))?$/))) {
    const idx = MONTHS.findIndex((name) => name.startsWith(m[1]));
    if (idx >= 0) {
      return monthOf(m[2] ? parseInt(m[2], 10) : Y, idx);
    }
  }

  // ISO date or partial: YYYY, YYYY-MM, YYYY-MM-DD (a date, not an instant).
  if ((m = raw.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/))) {
    const yr = parseInt(m[1], 10);
    if (m[2] == null) {
      return yearOf(yr);
    }
    const mo = parseInt(m[2], 10) - 1;
    if (mo < 0 || mo > 11) {
      return null;
    }
    if (m[3] == null) {
      return monthOf(yr, mo);
    }
    return day(yr, mo, parseInt(m[3], 10));
  }

  // Anything else the platform can parse (e.g. "July 1, 2026", a full ISO datetime).
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    return span(parsed, parsed);
  }
  return null;
}

module.exports = {
  // The search itself is read-only and side-effect free, so the call does not
  // need a run-approval gate. The meaningful consent is on *disclosure*: the
  // elicitation below decides what (if anything) reaches the model.
  readOnly: true,
  arguments: {
    query: {
      type: 'string',
      description: 'What to look for. Space-separated words must all appear (case-insensitive) in a single message, or in a conversation\'s file name.',
    },
    folder: {
      type: 'string',
      optional: true,
      description: 'Limit the search to this folder (relative to the workspace, or an absolute path). Defaults to the whole workspace.',
    },
    after: {
      type: 'string',
      optional: true,
      description: 'Only include messages written on or after this. Fuzzy: an ISO date (2026-06-15), a partial (2026, 2026-06), a month ("June 2026"), or a phrase ("last week", "7 days ago", "yesterday").',
    },
    before: {
      type: 'string',
      optional: true,
      description: 'Only include messages written on or before this. Same fuzzy formats as `after`; a partial like 2026-06 covers the whole of that month.',
    },
    when: {
      type: 'string',
      optional: true,
      description: 'Shortcut to limit results to a single period (sets both bounds), e.g. "yesterday", "last week", "June 2026", or 2026-06. Use `after`/`before` for an open-ended range.',
    },
    max_results: {
      type: 'number',
      optional: true,
      range: [1, 50],
      description: 'How many matching messages to return at most (default 10, most recent first).',
    },
  },
  async call({ query, folder, after, before, when, max_results }, context) {
    const termList = chat.terms(query);
    if (termList.length === 0) {
      throw new Error('`query` is required (one or more words to search for).');
    }

    // Resolve an optional date window. Every expression resolves to a period;
    // `after` uses its start, `before` its end, and `when` sets both.
    let lowerBound = null;
    let upperBound = null;
    if (when != null && String(when).trim()) {
      const period = resolveDateExpression(when);
      if (!period) {
        throw new Error(`Could not understand the date "${when}". Try e.g. 2026-06, "June 2026", "last week", "7 days ago", or "yesterday".`);
      }
      lowerBound = period.start;
      upperBound = period.end;
    }
    if (after != null && String(after).trim()) {
      const period = resolveDateExpression(after);
      if (!period) {
        throw new Error(`Could not understand the "after" date "${after}".`);
      }
      lowerBound = period.start;
    }
    if (before != null && String(before).trim()) {
      const period = resolveDateExpression(before);
      if (!period) {
        throw new Error(`Could not understand the "before" date "${before}".`);
      }
      upperBound = period.end;
    }
    if (lowerBound && upperBound && lowerBound.getTime() > upperBound.getTime()) {
      throw new Error('That date range is empty: "after" is later than "before".');
    }
    const hasDateFilter = Boolean(lowerBound || upperBound);
    const inRange = (ts) => {
      if (!hasDateFilter) {
        return true;
      }
      if (!ts) {
        return false;
      }
      const t = new Date(ts).getTime();
      if (isNaN(t)) {
        return false;
      }
      if (lowerBound && t < lowerBound.getTime()) {
        return false;
      }
      if (upperBound && t > upperBound.getTime()) {
        return false;
      }
      return true;
    };
    const fmtBound = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let rangeLabel = '';
    if (lowerBound && upperBound) {
      rangeLabel = ` between ${fmtBound(lowerBound)} and ${fmtBound(upperBound)}`;
    } else if (lowerBound) {
      rangeLabel = ` since ${fmtBound(lowerBound)}`;
    } else if (upperBound) {
      rangeLabel = ` up to ${fmtBound(upperBound)}`;
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
      const rel = relativeLabel(bases, file);
      // Recall also matches the conversation's file name/path (without the .chat
      // suffix), so a well-named conversation surfaces even when the query words
      // never appear in its messages.
      const nameMatches = chat.matchesAll(rel.replace(/\.chat$/i, ''), termList);
      let fileMatchCount = 0;
      let latestTimestamp = '';
      let hasInRange = false;
      for (const id of tree.order) {
        const node = tree.nodes.get(id);
        // Skip meta nodes and tool results: recall is about what was actually said
        // in past conversations, not tool output (often large and noisy).
        if (!node || chat.isMeta(node.role) || node.role === 'tool') {
          continue;
        }
        // Honour the date window, if any: a message counts only when it was written
        // within it.
        if (!inRange(node.timestamp)) {
          continue;
        }
        hasInRange = true;
        if (node.timestamp && String(node.timestamp) > latestTimestamp) {
          latestTimestamp = String(node.timestamp);
        }
        if (chat.matchesAll(node.content, termList)) {
          fileMatchCount++;
          matches.push({
            file,
            rel,
            role: node.role,
            excerpt: chat.matchExcerpt(node.content, termList, 110),
            timestamp: node.timestamp || '',
          });
          if (matches.length >= MAX_MATCHES) {
            break;
          }
        }
      }
      // A conversation whose file name matched but whose messages did not is still
      // worth surfacing, represented by its title, as long as it has activity in
      // the requested date window.
      if (nameMatches && fileMatchCount === 0 && matches.length < MAX_MATCHES && (!hasDateFilter || hasInRange)) {
        fileMatchCount++;
        matches.push({
          file,
          rel,
          byName: true,
          excerpt: conversationTitle(tree, file),
          timestamp: latestTimestamp,
        });
      }
      if (fileMatchCount > 0) {
        byFile.set(file, { rel, count: fileMatchCount, title: conversationTitle(tree, file) });
      }
      if (context && context.progress && scanned % 25 === 0) {
        context.progress({ progress: scanned, total: files.length, message: `Searched ${scanned} of ${files.length}\u2026` });
      }
    }

    const quotedQuery = '\u201c' + String(query).trim() + '\u201d';

    // No hit reveals nothing sensitive, so it is safe (and kinder) to just say so
    // rather than making the user approve an empty result.
    if (matches.length === 0) {
      return `No matches for ${quotedQuery}${rangeLabel} in ${files.length} saved conversation${files.length === 1 ? '' : 's'}.`;
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
      `conversation${conversationCount === 1 ? '' : 's'} for ${quotedQuery}${rangeLabel}.`;
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
