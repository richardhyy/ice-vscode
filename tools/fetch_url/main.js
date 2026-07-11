// ==ICETool==
// @name         fetch_url
// @description  Fetch the text content of a web page by URL and return it. Use when the user references a specific page to read.
// ==/ICETool==

'use strict';

/**
 * A built-in ICE tool: fetch the text of a URL. Kept deliberately tiny to show
 * how little a tool is — a self-describing object with typed `arguments` and a
 * `call` that returns a string (or throws to report a problem to the model).
 */
module.exports = {
  arguments: {
    url: { type: 'string', description: 'The absolute URL to fetch (must be http or https).' },
  },

  async call({ url }) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('`url` must be an absolute http(s) URL.');
    }

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Request failed (HTTP ${response.status} ${response.statusText}).`);
    }

    const text = await response.text();

    // Clamp very large pages so a single fetch can't blow up the context window.
    const MAX_CHARS = 100000;
    if (text.length > MAX_CHARS) {
      return `${text.slice(0, MAX_CHARS)}\n…[truncated ${text.length - MAX_CHARS} more characters]`;
    }
    return text;
  },
};
