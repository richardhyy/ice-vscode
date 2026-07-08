/*
 * Incremental streaming renderer for assistant messages.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ICEStreamingRenderer = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Creates a streaming renderer bound to a markdown pipeline.
   * @param {Object} deps
   * @param {Object} deps.marked - The marked instance (uses `marked.parser`).
   * @param {Object} deps.parserParameters - Options forwarded to `marked.parser`.
   * @param {(content: string) => Array<{raw: string}>} deps.convertMarkdownToTokens
   *   Lexes markdown into top-level tokens (each with a `.raw` source string).
   * @returns {Object} The renderer API.
   */
  function createStreamingRenderer(deps) {
    const marked = deps.marked;
    const parserParameters = deps.parserParameters;
    const convertMarkdownToTokens = deps.convertMarkdownToTokens;
    const onThinkingActive = deps.onThinkingActive;

    /**
     * Renders markdown as an ordered list of top-level blocks, one entry per
     * top-level token.
     * @param {string} content - The markdown content to render.
     * @returns {Array<{raw: string, html: string}>} The per-block render results.
     */
    function renderMarkdownBlocks(content) {
      const tokens = convertMarkdownToTokens(content);
      const blocks = [];
      for (const token of tokens) {
        blocks.push({ raw: token.raw, html: marked.parser([token], parserParameters) });
      }
      return blocks;
    }

    /**
     * Parses an HTML string into an array of nodes, dropping pure-whitespace
     * text nodes that sit between top-level blocks.
     * @param {string} html - The HTML string to parse.
     * @returns {Node[]} The parsed nodes.
     */
    function htmlToNodes(html) {
      const template = document.createElement("template");
      template.innerHTML = html;
      const nodes = [];
      template.content.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length === 0) {
          return;
        }
        nodes.push(node);
      });
      return nodes;
    }

    /**
     * Incrementally reconciles the rendered markdown blocks inside a container
     * against `content`.
     * @param {HTMLElement} container - The element whose children hold the blocks.
     * @param {string} content - The full markdown content to render.
     * @param {boolean} animateNew - Whether newly-appended blocks fade in.
     */
    function reconcileBlocks(container, content, animateNew) {
      const newBlocks = renderMarkdownBlocks(content);
      let old = container._blocks;
      if (!old) {
        // No incremental state yet — the container may have been populated by a
        // full render (innerHTML, no block model). Discard whatever is there so
        // the DOM is authoritatively rebuilt from our blocks and we never append
        // duplicates on top of pre-existing content.
        container.innerHTML = "";
        old = [];
      }

      // Longest common prefix by raw source (streaming appends at the tail).
      let i = 0;
      while (i < old.length && i < newBlocks.length && old[i].raw === newBlocks[i].raw) {
        i++;
      }

      // Update the first divergent block in place when it maps to a single
      // element of the same tag. This preserves the node so the growing tail
      // does not flash and entrance animations attached at birth can finish.
      if (i < old.length && i < newBlocks.length) {
        const oldBlock = old[i];
        const oldEl = oldBlock.nodes.length === 1 && oldBlock.nodes[0].nodeType === Node.ELEMENT_NODE ?
          oldBlock.nodes[0] : null;
        const parsed = htmlToNodes(newBlocks[i].html);
        const newEl = parsed.length === 1 && parsed[0].nodeType === Node.ELEMENT_NODE ?
          parsed[0] : null;
        if (oldEl && newEl && oldEl.tagName === newEl.tagName) {
          oldEl.innerHTML = newEl.innerHTML;
          oldBlock.raw = newBlocks[i].raw;
          i++;
        }
      }

      // Remove diverged / trailing old block nodes.
      for (let j = i; j < old.length; j++) {
        for (const node of old[j].nodes) {
          if (node.parentNode) {
            node.parentNode.removeChild(node);
          }
        }
      }

      // Append the remaining new blocks.
      const rebuilt = old.slice(0, i);
      for (let j = i; j < newBlocks.length; j++) {
        const nodes = htmlToNodes(newBlocks[j].html);
        for (const node of nodes) {
          if (animateNew && node.nodeType === Node.ELEMENT_NODE) {
            node.classList.add("md-block-enter");
          }
          container.appendChild(node);
        }
        rebuilt.push({ raw: newBlocks[j].raw, nodes });
      }
      container._blocks = rebuilt;
    }

    /**
     * Incrementally updates a streaming assistant message in place, avoiding a
     * full re-render of the message container on every token.
     * @param {Object} message - The (incomplete) message being streamed.
     * @returns {boolean} True if handled incrementally; false to fall back to a
     *   full re-render.
     */
    function updateStreamingMessage(message) {
      const container = document.querySelector(
        `.message-container[data-id="${message.id}"]`
      );
      if (!container) {
        return false;
      }
      const messageContent = container.querySelector(".message-content");
      if (!messageContent || messageContent.classList.contains("editing")) {
        return false;
      }

      // --- Reasoning (secondary, stays quiet) ---
      const reasoning = message.customFields && message.customFields.reasoning;
      const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
      const reasoningBlock = messageContent.querySelector(":scope > .reasoning-block");
      if (hasReasoning && !reasoningBlock) {
        // The reasoning block needs to be created — do it via one full render.
        return false;
      }
      if (hasReasoning && reasoningBlock) {
        const isThinking = message.content.length === 0;
        const summary = reasoningBlock.querySelector(".reasoning-summary");
        const label = reasoningBlock.querySelector(".reasoning-label");
        if (summary) {
          summary.classList.toggle("thinking", isThinking);
        }
        if (label && !isThinking) {
          // While thinking, the label text is owned by the typewriter animator.
          label.textContent = "Reasoning";
        }
        if (isThinking && onThinkingActive) {
          onThinkingActive();
        }
        reasoningBlock.open = true;
        const reasoningContent = reasoningBlock.querySelector(".reasoning-content");
        if (reasoningContent) {
          reconcileBlocks(reasoningContent, reasoning, false);
        }
      }

      // --- Answer (primary content) ---
      const markdownEl = messageContent.querySelector(":scope > .markdown-content");
      if (!markdownEl) {
        return false;
      }
      if (message.content.length === 0) {
        // Only the reasoning is streaming so far; leave the placeholder untouched.
        return true;
      }
      if (markdownEl.classList.contains("empty") || markdownEl.classList.contains("typing")) {
        // Clear the placeholder / typing indicator before the first real block.
        markdownEl.classList.remove("empty");
        markdownEl.classList.remove("typing");
        markdownEl.innerHTML = "";
        markdownEl._blocks = null;
      }
      reconcileBlocks(markdownEl, message.content, true);
      return true;
    }

    return {
      renderMarkdownBlocks: renderMarkdownBlocks,
      htmlToNodes: htmlToNodes,
      reconcileBlocks: reconcileBlocks,
      updateStreamingMessage: updateStreamingMessage,
    };
  }

  return { createStreamingRenderer: createStreamingRenderer };
}));
