// ==ICETool==
// @name         fetch_url
// @description  Fetch a web page and return its main content as clean Markdown (default) or raw HTML. Use to read a specific page.
// ==/ICETool==

'use strict';

const cheerio = require('cheerio');
// Depending on how webpack resolves it, turndown may arrive as its CJS export
// (the class) or its ES build (a { default } namespace) — normalise to the
// constructor so `new TurndownService()` works either way.
const turndownModule = require('turndown');
const TurndownService = turndownModule && turndownModule.default ? turndownModule.default : turndownModule;

const MAX_CHARS = 100000;

// Elements that are almost always chrome/boilerplate rather than the content a
// reader (or a model) wants — stripped before conversion so the result is the
// page's substance, not its navigation.
const NOISE = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'template', 'link', 'meta',
  'form', 'button', 'input', 'select', 'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[aria-hidden="true"]', '[hidden]',
].join(', ');

/** Clamps a very large result so a single fetch can't blow up the context window. */
function clamp(text) {
  if (text.length > MAX_CHARS) {
    return `${text.slice(0, MAX_CHARS)}\n…[truncated ${text.length - MAX_CHARS} more characters]`;
  }
  return text;
}

/** Tidies converted Markdown: no trailing spaces, no long runs of blank lines. */
function tidy(markdown) {
  return markdown.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Reduces a raw HTML page to the readable Markdown of its main content: strips
 * boilerplate, keeps the primary content region, makes links/images absolute so
 * they survive out of context, and converts what remains to Markdown.
 */
function toMarkdown(html, baseUrl) {
  const $ = cheerio.load(html);

  $(NOISE).remove();
  $('*').contents().each(function () {
    if (this.type === 'comment') {
      $(this).remove();
    }
  });

  const resolve = (value) => {
    try {
      return new URL(value, baseUrl).href;
    } catch (_error) {
      return value;
    }
  };
  $('a[href]').each(function () { $(this).attr('href', resolve($(this).attr('href'))); });
  $('img[src]').each(function () { $(this).attr('src', resolve($(this).attr('src'))); });

  const title = ($('title').first().text() || '').trim();

  // Prefer the primary content region; fall back to the whole body/document.
  let region = null;
  for (const selector of ['main', 'article', '[role="main"]', 'body']) {
    const found = $(selector).first();
    if (found.length) {
      region = found;
      break;
    }
  }
  if (!region) {
    region = $.root();
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  const body = tidy(turndown.turndown(region.html() || ''));

  // Too little survived cleaning — probably a JS-rendered page whose real
  // content isn't in the initial HTML. Signal the caller to keep the raw page.
  if (body.replace(/\s+/g, '').length < 80) {
    return null;
  }

  // Prepend the page title only when the content doesn't already open with a
  // heading, so the article's own <h1> isn't duplicated.
  const heading = title && !/^#\s/.test(body.trimStart()) ? `# ${title}\n\n` : '';
  return `${heading}${body}\n\n[Source](${baseUrl})`;
}

/**
 * A built-in ICE tool: fetch a URL and return its main content as clean Markdown
 * (or the raw page source when `format: "html"`). Non-HTML resources (JSON, plain
 * text, …) are returned as-is.
 */
module.exports = {
  arguments: {
    url: { type: 'string', description: 'The absolute URL to fetch (must be http or https).' },
    format: {
      type: 'string',
      optional: true,
      enum: ['markdown', 'html'],
      description: 'How to return the page: "markdown" (clean, structured main content — the default) or "html" (the raw page source).',
    },
  },

  async call({ url, format }) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('`url` must be an absolute http(s) URL.');
    }

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Request failed (HTTP ${response.status} ${response.statusText}).`);
    }

    const finalUrl = response.url || url;
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();

    // Only HTML is worth cleaning; return raw HTML on request, and any non-HTML
    // resource (JSON, plain text, …) untouched.
    const isHtml = /html/i.test(contentType) || (!contentType && /<html[\s>]/i.test(raw));
    if (format === 'html' || !isHtml) {
      return clamp(raw);
    }

    try {
      const markdown = toMarkdown(raw, finalUrl);
      if (markdown) {
        return clamp(markdown);
      }
      // Cleaning yielded almost nothing (e.g. a JavaScript-rendered page): the
      // raw HTML is more useful than an empty result.
      return clamp('> Note: this page seems to be rendered by JavaScript; its initial HTML has little readable content, so the raw source is returned below.\n\n' + raw);
    } catch (_error) {
      // If parsing/conversion fails for any reason, fall back to the raw page.
      return clamp(raw);
    }
  },
};
