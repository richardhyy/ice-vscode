const icons = require('./icons.js');
const marked = require('marked');
const { createStreamingRenderer } = require('./streamingRenderer.js');
import { Ruler } from './widgets/ruler.js';
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { autocompletion, startCompletion } from "@codemirror/autocomplete";

const vscode = acquireVsCodeApi();
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

const rulerElement = document.getElementById('ruler');
const conversationContainer = document.getElementById("conversation-container");
const PARSER_PARAMETERS = {
  ...marked.getDefaults(),
  "breaks": true
};

const ruler = new Ruler(conversationContainer, rulerElement);
let flatMessages = {};
let messageIDWithChildren = {}; // {messageID: [childID1, childID2, ...]}
let activePath = [];
// IDs of assistant replies whose upstream context was edited after they were
// generated (see _computeStaleMessages). Derived at render time from message
// timestamps — never persisted — and surfaced as a quiet per-message marker.
let _staleMessageIDs = new Set();
let currentProvider = null;
let availableProviders = [];
let providerConfigKeys = {}; // {providerID: [configKey1, configKey2, ...]}
// Per-variable option metadata a provider exposes: {providerID: {varName: {suggestions?, dynamic?, quick?}}}.
let providerOptions = {};
// Resolved non-secret config defaults per provider, used to snapshot a provider's
// configuration into the conversation the moment it is adopted (see _adoptProvider).
let providerDefaults = {};
// Cache of dynamically-listed option values: {providerID: {varName: [{value,label?,detail?}]}}.
let providerDynamicOptionsCache = {};
// In-flight/finished dynamic option fetches so we never double-request: {providerID: {varName: 'loading'|'done'}}.
let _dynamicOptionsState = {};
// Pending provider-option requests keyed by request id -> resolve callback.
let _pendingOptionRequests = {};
let _optionRequestCounter = 0;
// Callbacks waiting for a provider's config/options payload: {providerID: [cb, ...]}.
let _providerConfigWaiters = {};
// Quick-tune overrides chosen in the composer, keyed by the (shadow) message id
// -> {ConfigKey: value}. Materialised into a #config node when the message is sent.
let _composerQuickConfig = {};
// A pending "provider defaults changed" offer: { providerID, changes:{key:value} } or
// null. Surfaced as a quiet notice at the end of the conversation; applying it inserts
// a #config node so the change becomes part of this (trackable, forkable) conversation
// rather than silently diverging from the global defaults.
let _pendingConfigSync = null;
// Tool-call orchestration state.
let _toolAutoApprove = false;      // ice.tools.autoApprove (approval on when false)
let _toolMaxAutoIterations = 8;    // ice.tools.maxAutoIterations (loop cap)
let _toolAutoRunCount = 0;         // consecutive auto tool rounds since last user send
let _pendingToolRequests = {};     // requestID -> { assistantID, call }
let _toolOrchestration = {};       // assistantID -> 'awaiting-approval' | 'running' | 'capped' | 'stopped-continue'
let _toolRequestCounter = 0;
// Per-call live runtime while a tool executes: progress, cancellation, and any
// open elicitation form. Keyed by call id; cleared when the result lands.
let _toolRuntime = {};             // callID -> { requestID, assistantID, call, startedAt, status, progress, elicit }
let _toolTicker = null;            // shared 1s interval that refreshes running elapsed labels
// Composer Tools control: the draft tool selection per (shadow) message, plus a
// cache of the tools available to enable (built-in + MCP), fetched from the host.
let _composerToolSelection = {};
let _availableTools = null;
let _availableToolsWaiters = [];
let _toolsPopoverRefresh = null; // rebuilds the open Tools picker when availability changes
let snippets = {}; // {completion: content}

let globalUndoLock = null;
let contextMenuTargetElement = null;

let _editingMessageAttachments = {}; // {messageID: [attachment1, attachment2, ...]}

// --- Message selection state -------------------------------------------------
// Set of currently selected message IDs (stored as strings for consistency with
// dataset.id). `selectionAnchorID` is the pivot for Shift-click range selection
// and "Select to Here".
let selectedMessageIDs = new Set();
let selectionAnchorID = null;

// Monotonic counter so IDs generated within the same millisecond never collide
// (Date.now() alone can, e.g. when pasting several messages at once).
let _idCounter = 0;

// Pending host clipboard reads, keyed by request id -> resolve callback.
let _pendingClipboardRequests = {};
let _clipboardRequestCounter = 0;

// Marker that carries structured ICE message data inside an otherwise clean
// Markdown clipboard payload, so messages round-trip between .chat files while
// still pasting as readable Markdown anywhere else.
const ICE_CLIPBOARD_MARKER = "ICE-MESSAGES:v1";


/**
 * Generates a fresh, collision-free numeric message ID.
 * @returns {number} A unique message ID not present in `flatMessages`.
 */
function _freshID() {
  let id = Date.now() * 1000 + (_idCounter++ % 1000);
  while (flatMessages[id] !== undefined) {
    id = Date.now() * 1000 + (_idCounter++ % 1000);
  }
  return id;
}


/**
 * Sets the progress indicator in the UI.
 * @param {string} text - The text to display in the progress indicator.
 * @param {string|null} cancelableRequestID - The ID of the request that can be canceled, if any.
 */
function setProgressIndicator(text, cancelableRequestID) {
  const container = document.querySelector(".progress-container");
  if (text) {
    document.querySelector(".progress-label").textContent = text;
    container.classList.add("show");
  } else {
    container.classList.remove("show");
  }
  const cancelButton = document.getElementById("progress-cancel-button");
  if (cancelableRequestID) {
    cancelButton.onclick = () => {
      vscode.postMessage({
        type: "cancelRequest",
        requestID: cancelableRequestID,
      });
    };
    cancelButton.classList.add("show");
  } else {
    cancelButton.onclick = null;
    cancelButton.classList.remove("show");
  }
}

/**
 * Displays an error overlay with a message and optional details.
 * @param {string} message - The main error message to display.
 * @param {string} icon - HTML string for the icon to show.
 * @param {string|null} details - Optional detailed error information.
 */
function showErrorOverlay(message, icon, details = null) {
  const overlay = document.getElementById('errorOverlay');
  const errorIcon = document.getElementById('errorIcon');
  const errorMessage = document.getElementById('errorMessage');
  const showDetailsButton = document.getElementById('showDetailsButton');
  const errorDetails = document.getElementById('errorDetails');

  errorMessage.textContent = message;
  errorIcon.innerHTML = icon;
  if (details) {
    errorDetails.textContent = details;

    showDetailsButton.onclick = () => {
      errorDetails.classList.add('show');
      showDetailsButton.classList.remove('show');
    };

    showDetailsButton.classList.add('show');
  } else {
    errorDetails.classList.remove('show');
    showDetailsButton.classList.remove('show');
  }

  overlay.classList.add('show');
}


/**
 * Updates the attachments for a specific message.
 * @param {string} messageID - The ID of the message to update attachments for.
 * @param {Array} attachments - The new attachments to add or replace.
 * @param {boolean} append - Whether to append the new attachments or replace existing ones.
 * @param {HTMLElement|null} attachmentContainerElement - The container element for attachments, if available.
 */
function updateAttachments(messageID, attachments, append = false, attachmentContainerElement = null) {
  // Update the variable
  if (append) {
    _editingMessageAttachments[messageID] = (_editingMessageAttachments[messageID] || []).concat(attachments);
  } else {
    // Replace the attachments
    _editingMessageAttachments[messageID] = attachments;
  }

  // Update the UI
  _renderAttachments(messageID, _editingMessageAttachments[messageID], true, attachmentContainerElement);
}


/**
 * Updates the flat messages object with a new or edited message.
 * @param {Object} message - The message object to update or add.
 */
function updateFlatMessages(message) {
  delete message.action;
  flatMessages[message.id] = message;
}


/**
 * Build the message tree from the flat messages
 */
function scanMessageTree() {
  // Remove nodes whose parent is not in the flat messages
  Object.values(flatMessages).forEach((message) => {
    if (message.parentID && !flatMessages[message.parentID]) {
      delete flatMessages[message.id];
    }
  });

  messageIDWithChildren = {};
  Object.values(flatMessages).forEach((message) => {
    if (message.parentID) {
      if (!messageIDWithChildren[message.parentID]) {
        messageIDWithChildren[message.parentID] = [];
      }
      messageIDWithChildren[message.parentID].push(message.id);
    }
  });
}


/**
 * Get the configuration for a message
 * This traverses the message tree to build the configuration until the target message
 * @param {numeric} Target message ID
 * @returns {object} The configuration object
 */
function getMessageConfig(messageID) {
  let config = {};
  for (const id of getPathWithMessage(messageID)) {
    const currentMessage = flatMessages[id];
    if (currentMessage.role === "#config") {
      config = {
        ...config,
        ...JSON.parse(currentMessage.content)
      };
    }

    if (id === messageID) {
      // Stop at the target message
      break;
    }
  }
  return config;
}


/**
 * Gets the path from the root to the latest child of a given message.
 * @param {string} messageID - The ID of the message to get the path for.
 * @returns {Array} An array of message IDs representing the path.
 */
function getPathWithMessage(messageID) {
  const path = [];
  let currentMessage = flatMessages[messageID];
  // Find the path from the message to the root
  while (currentMessage) {
    path.unshift(currentMessage.id);
    currentMessage = flatMessages[currentMessage.parentID];
  }

  // Find the path from the message to the latest child
  let children = messageIDWithChildren[messageID];
  while (children && children.length > 0) {
    // Pick the latest child to push to the path
    const latestChild = children[children.length - 1];
    path.push(latestChild);
    children = messageIDWithChildren[latestChild];
  }

  return path;
}


/**
 * Handles the submission of a message, either creating a new one or editing an existing one.
 * @param {string} content - The content of the message.
 * @param {Object} message - The message object to create or edit.
 */
function _handleMessageSubmit(content, message) {
  if (currentProvider === null) {
    vscode.postMessage({
      type: "error",
      error: "Please select a chat provider first",
    });
    console.error("No chat provider selected");
    return;
  }

  if (content.trim() === "") {
    // Silently ignore empty messages
    console.log("Empty message ignored");
    return;
  }

  if (flatMessages[message.id] === undefined) {
    // If the message is a shadow message, create a new message
    const shadowId = message.id;
    const parentID = message.parentID;

    // Materialise any composer quick-tune overrides (model, thinking effort, …)
    // as a #config node placed just before this message — but only for keys that
    // actually differ from the inherited config, so no redundant nodes appear.
    let configDiff = null;
    const quick = _composerQuickConfig[shadowId];
    if (quick) {
      const inherited = parentID != null ? getMessageConfig(parentID) : {};
      configDiff = {};
      for (const key in quick) {
        const value = quick[key];
        const inheritedValue = inherited[key] == null ? "" : String(inherited[key]);
        if (value !== undefined && value !== null && value !== "" && String(value) !== inheritedValue) {
          configDiff[key] = value;
        }
      }
      if (Object.keys(configDiff).length === 0) {
        configDiff = null;
      }
    }

    // Materialise a composer tool selection into a #tools node, but only when it
    // differs from the tools already enabled at this point.
    let toolsSelection = null;
    const draftTools = _composerToolSelection[shadowId];
    if (draftTools) {
      const inheritedTools = parentID != null ? _enabledToolsAt(parentID) : [];
      const inheritedRefs = new Set(inheritedTools.map((tool) => tool.ref));
      const draftRefs = new Set(draftTools.map((tool) => tool.ref));
      const changed = inheritedRefs.size !== draftRefs.size || [...draftRefs].some((ref) => !inheritedRefs.has(ref));
      if (changed) {
        toolsSelection = draftTools;
      }
    }

    message = {
      id: _freshID(),
      role: "user",
      content,
      attachments: _editingMessageAttachments[shadowId],
      parentID: parentID,
      timestamp: new Date().toISOString(),
    };

    if (configDiff || toolsSelection) {
      // Insert the config/tools nodes and the user message as one undoable step.
      _asUndoTransaction(() => {
        let chainParent = parentID;
        if (configDiff) {
          chainParent = insertConfigUpdate(chainParent, null, configDiff);
        }
        if (toolsSelection) {
          chainParent = _createToolsNode(chainParent, toolsSelection);
        }
        message.parentID = chainParent;
        addMessage(message);
      });
    } else {
      addMessage(message);
    }

    delete _composerQuickConfig[shadowId];
    delete _composerToolSelection[shadowId];
  } else {
    // Edit the message if it's an existing message
    message.content = content;
    message.attachments = _editingMessageAttachments[message.id] || [];
    // Bump the local timestamp to match the edit the host is about to persist
    // (ChatHistoryManager.editMessage stamps its own). Keeping the in-memory copy
    // current is what lets downstream replies show as stale straight away, before
    // any reload.
    message.timestamp = new Date().toISOString();
    vscode.postMessage({
      type: "editMessage",
      messageID: message.id,
      updates: {
        content: content,
        attachments: message.attachments,
      }
    });
  }

  updateFlatMessages(message);
  scanMessageTree();
  activePath = getPathWithMessage(message.id);
  renderConversation();

  delete _editingMessageAttachments[message.id];

  if (message.role === "user" && (!messageIDWithChildren[message.id] || messageIDWithChildren[message.id].length === 0)) {
    // Send the message if it's a user message and has no children, i.e. it's the last message in the conversation
    sendMessage(message);
  }
}


/**
 * Converts markdown to tokens, handling custom HTML tags.
 * @param {string} markdown - The markdown string to convert.
 * @returns {marked.TokensList} The converted tokens.
 */
function _convertMarkdownToTokens(markdown) {
  let tokens = marked.lexer(markdown, PARSER_PARAMETERS);

  // Process HTML tokens
  function processTokens(tokens) {
    return tokens.map(token => {
      if (token.type === 'html') {
        // Process custom HTML tags
        const processed = _processHtmlToken(token);
        return processed || token;
      }
      if (token.tokens) {
        token.tokens = processTokens(token.tokens);
      }
      if (token.items) {
        token.items = processTokens(token.items);
      }
      return token;
    });
  }

  return processTokens(tokens);
}


/**
 * Escapes HTML characters in a string.
 * @param {string} unsafe - The string to escape.
 * @returns {string} The escaped string.
 * @see https://stackoverflow.com/a/6234804
 */
function _escapeHtml(unsafe)
{
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
 }

/**
 * Processes an HTML token, parsing any markdown content within custom tags.
 * @param {Object} token - The HTML token to process.
 * @returns {Object|null} The processed token or null if no processing was needed.
 */
function _processHtmlToken(token) {
  const customTagRegex = /^<(\w+)>([\s\S]*)<\/\1>([\s\S]*)$/m;
  const match = token.text.match(customTagRegex);

  if (match) {
    const [, tag, content, trailing] = match;
    console.log(`${token.text}\ntag: <${tag}>; content: ${content}`);
    // Parse the content inside the custom tag
    const innerTokens = _convertMarkdownToTokens(content);
    const trailingTokens = _convertMarkdownToTokens(trailing);
    return {
      type: 'text',
      raw: token.raw,
      text: `&lt;${tag}&gt;` + marked.parser(innerTokens, PARSER_PARAMETERS) + `&lt;/${tag}&gt;` + marked.parser(trailingTokens, PARSER_PARAMETERS)
    };
  } else {
    console.log(`No match for tag: ${token.text}`);
    return {
      type: 'text',
      raw: token.raw,
      text: _escapeHtml(token.text)
    };
  }
}


/**
 * Renders markdown content, optionally converting single line breaks.
 * @param {string} content - The markdown content to render.
 * @returns {string} The rendered HTML string.
 */
function _renderMarkdown(content) {
  return marked.parser(_convertMarkdownToTokens(content), PARSER_PARAMETERS);
}


/**
 * "Thinking" typewriter effect
 * It types out "Thinking" one character at a time ("T", "Th", … "Thinking"),
 * then loops a single travelling dot ("Thinking.", "Thinking·.", "Thinking··.")
 */
const thinkingAnimator = (function () {
  const WORD = "Thinking";
  const TICK_MS = 90;
  const DOT_HOLD = 4; // ticks each dot position is held before it moves
  const DOT_POSITIONS = 3;
  const NBSP = "\u00A0";
  const SELECTOR = ".reasoning-summary.thinking .reasoning-label";
  const motionQuery = window.matchMedia ?
    window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  let intervalID = null;

  function frameText(frame) {
    if (frame < WORD.length) {
      return WORD.slice(0, frame + 1);
    }
    const dot = Math.floor((frame - WORD.length) / DOT_HOLD) % DOT_POSITIONS;
    return WORD + NBSP.repeat(dot) + ".";
  }

  function stop() {
    if (intervalID !== null) {
      clearInterval(intervalID);
      intervalID = null;
    }
  }

  function tick() {
    const labels = document.querySelectorAll(SELECTOR);
    if (labels.length === 0) {
      stop();
      return false;
    }
    labels.forEach((label) => {
      const frame = label._thinkFrame || 0;
      label.textContent = frameText(frame);
      label._thinkFrame = frame + 1;
    });
    return true;
  }

  function ensureRunning() {
    if (motionQuery && motionQuery.matches) {
      // Reduced motion: show a calm, static label instead of the typewriter.
      document.querySelectorAll(SELECTOR).forEach((label) => {
        label.textContent = WORD + "\u2026";
      });
      return;
    }
    if (intervalID !== null) {
      return;
    }
    if (tick()) {
      intervalID = setInterval(tick, TICK_MS);
    }
  }

  return { ensureRunning };
})();


// Incremental streaming renderer, sharing the same markdown pipeline as the
// full renderer above. Used to patch streaming assistant messages in place
// rather than rebuilding the whole message container on every token.
const streamingRenderer = createStreamingRenderer({
  marked,
  parserParameters: PARSER_PARAMETERS,
  convertMarkdownToTokens: _convertMarkdownToTokens,
  onThinkingActive: () => thinkingAnimator.ensureRunning(),
});


/**
 * Creates an animated typing indicator (three composing dots) shown while
 * waiting for the assistant's first answer token — the familiar "a reply is
 * being composed" metaphor.
 * @returns {HTMLElement} The typing indicator element.
 */
function _createTypingIndicator() {
  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  indicator.setAttribute("aria-label", "Assistant is responding");
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "typing-dot";
    indicator.appendChild(dot);
  }
  return indicator;
}

/**
 * Builds the inline error notice shown on a failed assistant reply. The provider
 * error is recorded on the message (and persisted to the .chat file), so it stays
 * visible in the conversation instead of only flashing in a notification. Kept
 * quiet but unambiguous: a small octagon glyph plus the reason in the theme's
 * error colour, shown inline in the bubble (no nested card). A faint top divider
 * is added only when answer content streamed before the failure.
 * @param {string} text - The error message to display.
 * @param {boolean} [withDivider=false] - Whether to set the notice off from
 *   preceding answer content with a divider.
 * @returns {HTMLElement} The error notice element.
 */
function _createMessageErrorBlock(text, withDivider = false) {
  const block = document.createElement("div");
  block.className = withDivider ? "message-error with-divider" : "message-error";
  block.setAttribute("role", "alert");

  const icon = document.createElement("span");
  icon.className = "message-error-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = icons.ICON_EXCLAMATION_OCTAGON;
  block.appendChild(icon);

  const label = document.createElement("span");
  label.className = "message-error-text";
  label.textContent = text;
  block.appendChild(label);

  return block;
}


/**
 * Encodes a configuration object to a string format.
 * @param {Object} obj - The configuration object to encode.
 * @returns {string} The encoded configuration string.
 */
function _encodeConfig(obj) {
  let lines = [];
  for (let key in obj) {
    if (obj.hasOwnProperty(key)) {
      let value = obj[key];
      if (typeof value === 'string') {
        lines.push(key + ' = ' + value.replace(/\n/g, '\n'));
      } else {
        lines.push(key + ' = ' + value);
      }
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}


/**
 * Decodes a configuration string to an object.
 * @param {string} str - The configuration string to decode.
 * @returns {Object} The decoded configuration object.
 */
function _decodeConfig(str) {
  let obj = {};
  let lines = str.split('\n');
  let currentKey = null;
  let currentValue = null;

  for (let line of lines) {
    line = line.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    let equalsIndex = line.indexOf('=');
    if (equalsIndex !== -1) {
      if (currentKey !== null) {
        obj[currentKey] = currentValue.trim();
      }
      currentKey = line.slice(0, equalsIndex).trim();
      currentValue = line.slice(equalsIndex + 1).trim() + '\n';
    } else {
      currentValue += line + '\n';
    }
  }

  if (currentKey !== null) {
    obj[currentKey] = currentValue.trim();
  }

  return obj;
}


// --- Provider option selection ----------------------------------------------
// Providers may declare that a config variable has suggestions (a hint list of
// values, never a hard limit), is dynamic (the provider lists values at runtime,
// e.g. available models), and/or is a "quick option" surfaced in the composer's
// quick-tune bar. These helpers fetch/cache those options and drive the
// value-selection UIs (config-editor autocomplete, composer quick-tune, panel).

/** Normalises a provider option list to `[{value, label?, detail?}]`, accepting bare strings. */
function _normalizeOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map((option) => {
      if (typeof option === "string") {
        return { value: option };
      }
      if (option && typeof option.value === "string") {
        return { value: option.value, label: option.label, detail: option.detail };
      }
      return null;
    })
    .filter((option) => option !== null);
}

/** The option metadata a provider declared for a variable, or null. */
function _optionMetaFor(providerID, variableName) {
  const meta = providerOptions[providerID];
  return (meta && meta[variableName]) || null;
}

/**
 * Ensures a provider's config keys + option metadata are loaded, then runs `cb`.
 * If already loaded, `cb` runs synchronously; otherwise it is queued and the
 * payload is requested from the host (see the `providerConfig` handler).
 */
function _ensureProviderConfig(providerID, cb) {
  if (!providerID) {
    return;
  }
  if (providerOptions[providerID] !== undefined) {
    cb();
    return;
  }
  if (!_providerConfigWaiters[providerID]) {
    _providerConfigWaiters[providerID] = [];
  }
  _providerConfigWaiters[providerID].push(cb);
  vscode.postMessage({ type: "fetchProviderConfig", providerID: providerID });
}

/**
 * Requests the runtime option values for a variable from its provider.
 * @returns {Promise<Array<{value:string,label?:string,detail?:string}>>}
 */
function _fetchProviderOptions(providerID, variableName) {
  return new Promise((resolve, reject) => {
    const requestID = "opt-" + Date.now() + "-" + _optionRequestCounter++;
    _pendingOptionRequests[requestID] = { resolve, reject };
    vscode.postMessage({
      type: "fetchProviderOptions",
      requestID: requestID,
      providerID: providerID,
      variableName: variableName,
    });
  });
}

/**
 * Lazily loads (and caches) a dynamic variable's options, invoking `onReady`
 * with the option list once available. Static-only variables resolve
 * immediately from their declared suggestions; failures fall back to them.
 */
function _loadDynamicOptions(providerID, variableName, onReady) {
  const meta = _optionMetaFor(providerID, variableName) || {};
  const staticOptions = (meta.suggestions || []).map((value) => ({ value }));

  if (!meta.dynamic) {
    onReady(staticOptions, false);
    return;
  }

  const cached = providerDynamicOptionsCache[providerID] && providerDynamicOptionsCache[providerID][variableName];
  if (cached) {
    onReady(_mergeOptions(cached, staticOptions), false);
    return;
  }

  const state = _dynamicOptionsState[providerID] || (_dynamicOptionsState[providerID] = {});

  if (state[variableName] === "error") {
    // A previous fetch failed; don't hammer the endpoint — offer static options.
    onReady(staticOptions, false);
    return;
  }

  // Signal "loading" so the caller can show a spinner; static options meanwhile.
  onReady(staticOptions, true);

  if (state[variableName] === "loading") {
    return;
  }
  state[variableName] = "loading";
  _fetchProviderOptions(providerID, variableName)
    .then((options) => {
      if (!providerDynamicOptionsCache[providerID]) {
        providerDynamicOptionsCache[providerID] = {};
      }
      providerDynamicOptionsCache[providerID][variableName] = options;
      state[variableName] = "done";
      onReady(_mergeOptions(options, staticOptions), false);
    })
    .catch((error) => {
      state[variableName] = "error";
      console.warn("Failed to list options for", variableName, error);
      onReady(staticOptions, false, error);
    });
}

/** Merges two option lists, keeping the first occurrence of each value. */
function _mergeOptions(primary, secondary) {
  const seen = new Set();
  const merged = [];
  for (const option of [...primary, ...secondary]) {
    if (option && typeof option.value === "string" && !seen.has(option.value)) {
      seen.add(option.value);
      merged.push(option);
    }
  }
  return merged;
}

/** True when the provider declared any selectable values for the variable. */
function _hasSelectableOptions(providerID, variableName) {
  const meta = _optionMetaFor(providerID, variableName);
  return !!meta && ((meta.suggestions && meta.suggestions.length > 0) || meta.dynamic === true);
}

/** Humanises a config variable name for display ("ReasoningEffort" -> "Reasoning Effort"). */
function _humanizeVariableName(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}


// The currently-open option-select menu (only one at a time), so opening one or
// clicking elsewhere closes any other.
let _openOptionSelect = null;

/**
 * Builds a compact, theme-aware dropdown for picking a provider option value.
 * Suggested values appear immediately; dynamic variables show a "Loading…"
 * state while the provider lists values, then populate in place. An optional
 * "Default" entry clears the override (passes null to `onChange`).
 *
 * @param {Object} opts
 * @param {string} opts.providerID
 * @param {string} opts.variableName
 * @param {string} [opts.currentValue] The active value (may be inherited).
 * @param {boolean} [opts.isOverride] Whether currentValue is an explicit override.
 * @param {boolean} [opts.allowClear] Offer a "Default" entry that clears the value.
 * @param {Function} opts.onChange Called with the chosen value (or null to clear).
 * @returns {HTMLElement}
 */
function _createOptionSelect(opts) {
  const { providerID, variableName, onChange } = opts;
  const humanName = _humanizeVariableName(variableName);

  const wrapper = document.createElement("div");
  wrapper.classList.add("option-select");

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("option-select-button");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.title = humanName;

  const labelText = document.createElement("span");
  labelText.classList.add("option-select-label");

  const caret = document.createElement("span");
  caret.classList.add("option-select-caret");
  caret.innerHTML = icons.ICON_CARET_DOWN;

  button.appendChild(labelText);
  button.appendChild(caret);
  wrapper.appendChild(button);

  let currentValue = opts.currentValue || "";
  let isOverride = Boolean(opts.isOverride);

  function renderLabel() {
    if (currentValue) {
      labelText.textContent = currentValue;
      wrapper.classList.toggle("is-override", isOverride);
      wrapper.classList.remove("is-placeholder");
    } else {
      labelText.textContent = humanName;
      wrapper.classList.remove("is-override");
      wrapper.classList.add("is-placeholder");
    }
  }
  renderLabel();

  let menu = null;
  let list = null;
  let searchInput = null;
  let currentOptions = [];
  let currentLoading = false;

  function closeMenu() {
    if (menu) {
      menu.remove();
      menu = null;
    }
    list = null;
    searchInput = null;
    button.setAttribute("aria-expanded", "false");
    if (_openOptionSelect === api) {
      _openOptionSelect = null;
    }
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
  }

  function onDocPointerDown(event) {
    if (!wrapper.contains(event.target)) {
      closeMenu();
    }
  }

  function onDocKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMenu();
      button.focus();
    }
  }

  /** Applies a value as an explicit override (used by option clicks and custom entry). */
  function selectValue(value) {
    currentValue = value;
    isOverride = true;
    renderLabel();
    closeMenu();
    button.focus();
    onChange(value);
  }

  /** Commits a free-typed value, so declared suggestions are a hint, never a hard limit. */
  function commitCustom(value) {
    const trimmed = String(value).trim();
    if (trimmed) {
      selectValue(trimmed);
    }
  }

  // Records the latest option list/loading state, then re-renders the menu body.
  function buildMenuItems(options, loading) {
    currentOptions = Array.isArray(options) ? options : [];
    currentLoading = Boolean(loading);
    if (list) {
      renderList();
    }
  }

  // Renders the menu body: Default (when unfiltered), the filtered options, an
  // escape-hatch "Use …" row for any typed value, and loading/empty states.
  function renderList() {
    list.innerHTML = "";
    const rawFilter = searchInput ? searchInput.value.trim() : "";
    const filter = rawFilter.toLowerCase();

    if (opts.allowClear && !filter) {
      // "Default" is the active choice only when there is no effective value.
      list.appendChild(makeItem({ value: "", label: "Default" }, !currentValue, true));
    }

    const filtered = currentOptions.filter((option) => {
      if (!filter) {
        return true;
      }
      const haystack = ((option.label || "") + " " + option.value).toLowerCase();
      return haystack.includes(filter);
    });

    for (const option of filtered) {
      list.appendChild(makeItem(option, option.value === currentValue, false));
    }

    // Offer to use a typed value that isn't already an exact option value.
    const exact = currentOptions.some((option) => option.value === rawFilter);
    if (rawFilter && !exact) {
      list.appendChild(makeCustomItem(rawFilter));
    }

    if (currentLoading) {
      const loadingItem = document.createElement("div");
      loadingItem.classList.add("option-select-loading");
      loadingItem.textContent = "Loading\u2026";
      list.appendChild(loadingItem);
    } else if (filtered.length === 0 && !rawFilter && !opts.allowClear) {
      const emptyItem = document.createElement("div");
      emptyItem.classList.add("option-select-loading");
      emptyItem.textContent = "No options";
      list.appendChild(emptyItem);
    }
  }

  function makeCustomItem(value) {
    const item = document.createElement("button");
    item.type = "button";
    item.classList.add("option-select-item", "option-select-custom");
    item.setAttribute("role", "option");

    const primary = document.createElement("span");
    primary.classList.add("option-select-item-label");
    primary.textContent = "Use \u201C" + value + "\u201D";
    item.appendChild(primary);

    item.addEventListener("click", () => commitCustom(value));
    return item;
  }

  function makeItem(option, selected, isClear) {
    const item = document.createElement("button");
    item.type = "button";
    item.classList.add("option-select-item");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) {
      item.classList.add("selected");
    }

    const primary = document.createElement("span");
    primary.classList.add("option-select-item-label");
    primary.textContent = isClear ? "Default" : (option.label || option.value);
    item.appendChild(primary);

    if (!isClear && option.detail) {
      const detail = document.createElement("span");
      detail.classList.add("option-select-item-detail");
      detail.textContent = option.detail;
      item.appendChild(detail);
    }

    item.addEventListener("click", () => {
      if (isClear) {
        // "Default" drops the override, reverting to the inherited value.
        currentValue = opts.inheritedValue || "";
        isOverride = false;
        renderLabel();
        closeMenu();
        button.focus();
        onChange(null);
      } else {
        selectValue(option.value);
      }
    });
    return item;
  }

  function openMenu() {
    if (_openOptionSelect && _openOptionSelect !== api) {
      _openOptionSelect.close();
    }
    menu = document.createElement("div");
    menu.classList.add("option-select-menu");
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", humanName);

    // A filter box that doubles as a custom-value entry: type to narrow the
    // list, or type any value and press Enter to use it (declared options are
    // suggestions, not a hard constraint).
    searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.classList.add("option-select-search");
    searchInput.placeholder = "Filter or enter a value\u2026";
    searchInput.setAttribute("aria-label", humanName + " \u2014 filter or custom value");
    searchInput.addEventListener("input", renderList);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const typed = searchInput.value.trim();
        const match = currentOptions.find((option) => option.value === typed);
        if (match) {
          selectValue(match.value);
        } else if (typed) {
          commitCustom(typed);
        }
      } else if (event.key === "ArrowDown") {
        const first = list.querySelector(".option-select-item");
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    menu.appendChild(searchInput);

    list = document.createElement("div");
    list.classList.add("option-select-list");
    menu.appendChild(list);

    wrapper.appendChild(menu);
    button.setAttribute("aria-expanded", "true");
    _openOptionSelect = api;
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);

    buildMenuItems([], true);
    _loadDynamicOptions(providerID, variableName, (options, loading) => {
      if (menu) {
        buildMenuItems(options, loading);
      }
    });

    // Let the user type immediately (filter long model lists / enter a value).
    searchInput.focus();
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  const api = {
    element: wrapper,
    close: closeMenu,
  };
  return wrapper;
}


/**
 * Appends the composer quick-tune bar to a draft message editor. Renders one
 * dropdown per provider-declared "quick option" (e.g. model, thinking effort),
 * seeded from the inherited config and writing user choices into
 * `_composerQuickConfig[message.id]`, which is materialised into a #config node
 * when the message is sent (see _handleMessageSubmit).
 * @param {HTMLElement} parentElement
 * @param {Object} message The draft (shadow) message being composed.
 */
function _appendComposerQuickBar(parentElement, message) {
  // A shadow draft isn't in flatMessages yet, so inherit config from its parent.
  const configBaseMessageID = message.isShadow ? message.parentID : message.id;
  const inheritedConfig = configBaseMessageID != null ? getMessageConfig(configBaseMessageID) : {};
  const providerID = inheritedConfig.Provider || currentProvider;
  if (!providerID) {
    return;
  }

  const bar = document.createElement("div");
  bar.classList.add("composer-quick-bar");
  parentElement.appendChild(bar);

  // Tools control: choose which tools the model may call for this message. Shown
  // regardless of provider quick-options so tools stay discoverable.
  bar.appendChild(_createComposerToolsControl(message, configBaseMessageID));

  _ensureProviderConfig(providerID, () => {
    // The editor may have been dismissed while the payload was in flight.
    if (!bar.isConnected) {
      return;
    }
    const meta = providerOptions[providerID] || {};
    const quickKeys = Object.keys(meta).filter((key) => meta[key] && meta[key].quick);

    for (const key of quickKeys) {
      const override = _composerQuickConfig[message.id] && _composerQuickConfig[message.id][key];
      const inherited = inheritedConfig[key];
      const hasOverride = override !== undefined && override !== null && override !== "";
      const select = _createOptionSelect({
        providerID: providerID,
        variableName: key,
        currentValue: hasOverride ? override : (inherited || ""),
        isOverride: hasOverride,
        inheritedValue: inherited || "",
        allowClear: true,
        onChange: (value) => {
          if (value === null || value === "") {
            if (_composerQuickConfig[message.id]) {
              delete _composerQuickConfig[message.id][key];
            }
          } else {
            if (!_composerQuickConfig[message.id]) {
              _composerQuickConfig[message.id] = {};
            }
            _composerQuickConfig[message.id][key] = value;
          }
        },
      });
      bar.appendChild(select);
    }
  });
}

/** Ensures the available-tools list (built-in + MCP) is loaded, then runs `cb`. */
function _ensureAvailableTools(cb) {
  if (_availableTools !== null) {
    cb(_availableTools);
    return;
  }
  _availableToolsWaiters.push(cb);
  vscode.postMessage({ type: "fetchAvailableTools" });
}

/** Creates and persists a '#tools' node under `parentID`, returning its id. */
function _createToolsNode(parentID, enabled) {
  const id = _freshID();
  const node = {
    id: id,
    role: "#tools",
    content: JSON.stringify({ enabled: enabled || [] }),
    parentID: parentID,
    timestamp: new Date().toISOString(),
  };
  updateFlatMessages(node);
  addMessage(node);
  return id;
}

/**
 * Builds the composer's Tools control: a pill (with a live count of enabled
 * tools) that opens an inline picker of the available tools. Toggling a tool
 * updates a draft selection for the message being composed, which is written as
 * a '#tools' node when the message is sent. Keeps tool setup in one discoverable
 * place, including a shortcut to add an MCP server.
 */
function _createComposerToolsControl(message, configBaseMessageID) {
  const wrapper = document.createElement("div");
  wrapper.className = "composer-tools";

  const effectiveSelection = () =>
    _composerToolSelection[message.id] || (configBaseMessageID != null ? _enabledToolsAt(configBaseMessageID) : []);

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "composer-tools-pill";
  const pillLabel = document.createElement("span");
  pillLabel.textContent = "Tools";
  pill.appendChild(pillLabel);
  const pillCount = document.createElement("span");
  pillCount.className = "composer-tools-count";
  pill.appendChild(pillCount);
  wrapper.appendChild(pill);

  const refreshPill = () => {
    const count = effectiveSelection().length;
    pillCount.textContent = count > 0 ? String(count) : "";
    pill.classList.toggle("is-active", count > 0);
  };
  refreshPill();

  let popover = null;
  const onDocumentDown = (event) => {
    if (popover && !wrapper.contains(event.target)) {
      closePopover();
    }
  };
  function closePopover() {
    if (popover) {
      popover.remove();
      popover = null;
      _toolsPopoverRefresh = null;
      document.removeEventListener("mousedown", onDocumentDown, true);
    }
  }

  const buildRows = (available) => {
    if (!popover) {
      return;
    }
    popover.innerHTML = "";

    if (!available || available.length === 0) {
      const empty = document.createElement("div");
      empty.className = "composer-tools-empty";
      empty.textContent = "No tools available yet.";
      popover.appendChild(empty);
    } else {
      const selectedRefs = new Set(effectiveSelection().map((tool) => tool.ref));

      // Group tools by their source (built-in, and one group per MCP server) so a
      // whole server can be toggled at once and its tools shown with short names.
      const groups = new Map();
      for (const tool of available) {
        const label = tool.sourceLabel || tool.source || tool.server || "tools";
        if (!groups.has(label)) {
          groups.set(label, { label: label, source: tool.source, tools: [] });
        }
        groups.get(label).tools.push(tool);
      }

      const addSelection = (tools) => {
        const current = effectiveSelection().slice();
        for (const tool of tools) {
          if (!current.some((entry) => entry.ref === tool.ref)) {
            current.push(tool);
          }
        }
        _composerToolSelection[message.id] = current;
        refreshPill();
      };
      const removeSelection = (tools) => {
        const refs = new Set(tools.map((tool) => tool.ref));
        _composerToolSelection[message.id] = effectiveSelection().filter((entry) => !refs.has(entry.ref));
        refreshPill();
      };

      for (const group of groups.values()) {
        const groupEl = document.createElement("div");
        groupEl.className = "composer-tools-group";

        const header = document.createElement("div");
        header.className = "composer-tools-group-header";

        const toggle = document.createElement("label");
        toggle.className = "composer-tools-group-toggle";
        const groupCheckbox = document.createElement("input");
        groupCheckbox.type = "checkbox";
        toggle.appendChild(groupCheckbox);

        const groupName = document.createElement("span");
        groupName.className = "composer-tools-group-name";
        groupName.textContent = group.label;
        toggle.appendChild(groupName);

        const groupCount = document.createElement("span");
        groupCount.className = "composer-tools-group-count";
        toggle.appendChild(groupCount);
        header.appendChild(toggle);

        // Only MCP servers are removable here (built-in and file tools aren't
        // server-backed). Removing edits the user's settings, refreshing the list.
        if (group.source === "MCP") {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "composer-tools-group-remove";
          remove.title = "Remove this MCP server";
          remove.setAttribute("aria-label", "Remove MCP server " + group.label);
          remove.innerHTML = icons.ICON_TRASH;
          remove.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            vscode.postMessage({ type: "removeMcpServer", server: group.label });
          });
          header.appendChild(remove);
        }

        groupEl.appendChild(header);

        const toolsEl = document.createElement("div");
        toolsEl.className = "composer-tools-group-tools";
        const childCheckboxes = [];

        const syncGroup = () => {
          const selected = childCheckboxes.filter((box) => box.checked).length;
          groupCheckbox.checked = selected > 0 && selected === childCheckboxes.length;
          groupCheckbox.indeterminate = selected > 0 && selected < childCheckboxes.length;
          groupCount.textContent = selected > 0 ? selected + "/" + group.tools.length : String(group.tools.length);
        };

        groupCheckbox.addEventListener("change", () => {
          const on = groupCheckbox.checked;
          childCheckboxes.forEach((box) => { box.checked = on; });
          if (on) {
            addSelection(group.tools);
          } else {
            removeSelection(group.tools);
          }
          syncGroup();
        });

        for (const tool of group.tools) {
          const row = document.createElement("label");
          row.className = "composer-tools-row";
          if (tool.description) {
            row.title = tool.description;
          }

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = selectedRefs.has(tool.ref);
          childCheckboxes.push(checkbox);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              addSelection([tool]);
            } else {
              removeSelection([tool]);
            }
            syncGroup();
          });
          row.appendChild(checkbox);

          const name = document.createElement("span");
          name.className = "composer-tools-row-name";
          name.textContent = tool.title || tool.name;
          row.appendChild(name);

          if (tool.readOnly) {
            const readonly = document.createElement("span");
            readonly.className = "composer-tools-row-readonly";
            readonly.textContent = "read-only";
            row.appendChild(readonly);
          }

          toolsEl.appendChild(row);
        }

        syncGroup();
        groupEl.appendChild(toolsEl);
        popover.appendChild(groupEl);
      }
    }

    const footer = document.createElement("div");
    footer.className = "composer-tools-footer";
    const addFromFile = document.createElement("button");
    addFromFile.type = "button";
    addFromFile.className = "composer-tools-add";
    addFromFile.textContent = "Add tool from file\u2026";
    addFromFile.addEventListener("click", () => {
      vscode.postMessage({ type: "addToolFromFile" });
    });
    footer.appendChild(addFromFile);
    const addServer = document.createElement("button");
    addServer.type = "button";
    addServer.className = "composer-tools-add";
    addServer.textContent = "Add MCP server\u2026";
    addServer.addEventListener("click", () => {
      vscode.postMessage({ type: "openAddMcpServer" });
      _availableTools = null; // refresh next time the picker opens
      closePopover();
    });
    footer.appendChild(addServer);
    popover.appendChild(footer);
  };

  pill.addEventListener("click", () => {
    if (popover) {
      closePopover();
      return;
    }
    popover = document.createElement("div");
    popover.className = "composer-tools-popover";
    const loading = document.createElement("div");
    loading.className = "composer-tools-empty";
    loading.textContent = "Loading tools\u2026";
    popover.appendChild(loading);
    wrapper.appendChild(popover);
    document.addEventListener("mousedown", onDocumentDown, true);
    _toolsPopoverRefresh = () => buildRows(_availableTools);
    _ensureAvailableTools(buildRows);
  });

  return wrapper;
}


/**
 * Renders attachments for a specific message.
 * @param {string} messageID - The ID of the message to render attachments for.
 * @param {Array} attachments - The attachments to render.
 * @param {boolean} editing - Whether the message is being edited.
 * @param {HTMLElement|null} attachmentContainerElement - The container element for attachments, if available.
 */
function _renderAttachments(messageID, attachments, editing, attachmentContainerElement = null) {
  const attachmentContainer = attachmentContainerElement ? attachmentContainerElement : document.querySelector(
    `.attachment-container[data-id="${messageID}"]`
  );
  if (!attachmentContainer) {
    console.error("Attachment container not found for message", messageID);
    return;
  }

  attachmentContainer.innerHTML = "";

  for (const attachment of attachments) {
    const file = document.createElement("div");
    file.classList.add("file");
    file.dataset.attachmentID = attachment.id;
    const vscodeContext = {
      isAttachment: true,
    };
    if (editing) {
      vscodeContext.editibleAttachment = true;
    }
    vscodeContext.revealableAttachment = !attachment.url.startsWith("data");
    file.dataset.vscodeContext = JSON.stringify(vscodeContext);
    file.title = attachment.name + (attachment.url.startsWith("data") ? ` (Embedded)` : ` (${attachment.url})`);

    const fileName = document.createElement("div");
    fileName.classList.add("file-name");
    fileName.textContent = attachment.name;

    const extension = attachment.name.split('.').pop();

    const extensionLabel = document.createElement("div");
    extensionLabel.classList.add("file-extension");
    extensionLabel.textContent = extension;

    if (attachment.url.startsWith("data:image/")) {
      // Image attachment
      const filePreview = document.createElement("div");
      filePreview.classList.add("file-preview");

      const image = document.createElement("img");
      image.src = attachment.url;
      image.alt = attachment.name;

      filePreview.appendChild(image);
      file.appendChild(filePreview);
    } else {
      file.appendChild(fileName);
    }
    file.appendChild(extensionLabel);
    attachmentContainer.appendChild(file);
  }
}


/**
 * Renders an editor for message input or editing.
 * @param {HTMLElement} codeMirrorContainer - The container element for the editor.
 * @param {string} id - The ID of the message being edited.
 * @param {string} content - The initial content of the editor.
 * @param {string} placeholderText - The placeholder text for the editor.
 * @param {Function} autocompletionCallback - The callback function for autocompletion.
 * @param {Function} submitCallback - The callback function for submitting the content.
 * @returns {EditorView} The created CodeMirror editor instance.
 */
function _renderEditor(codeMirrorContainer, id, content, placeholderText, autocompletionCallback, submitCallback) {
  const selectionColor = "color-mix(in srgb, var(--accent-color) 5%, var(--vscode-editor-selectionBackground))";
  const codeMirrorView = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        minimalSetup,
        autocompletion({
          override: [autocompletionCallback]
        }),
        Prec.highest(
          keymap.of([{
            key: "Ctrl-Enter",
            mac: "Cmd-Enter",
            run: () => {
              submitCallback(codeMirrorView.state.doc.toString());
              return true;
            }
          }])
        ),
        placeholder(placeholderText),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": {
            backgroundColor: "transparent",
            fontFamily: "sans-serif",
          },
          "&.cm-editor": {
            maxHeight: "61.8vh",
          },
          "&.cm-scroller": {
            overflow: "auto",
          },
          "& .cm-scroller::-webkit-scrollbar": {
            width: "5px",
            height: "5px",
          },
          "& .cm-scroller::-webkit-scrollbar-thumb": {
            borderRadius: "var(--border-radius-small)",
          },
          ".cm-gutters": {
            display: "none",
          },
          "&.cm-focused": {
            outline: "none",
          },
          ".cm-line": {
            color: "var(--vscode-editor-foreground)",
            fontFamily: "sans-serif",
          },
          ".cm-activeLine": {
            backgroundColor: "transparent",
          },
          ".cm-content": {
            caretColor: selectionColor,
          },
          ".cm-selectionBackground": {
            backgroundColor: selectionColor + " !important",
            opacity: "0.8",
          },
          ".cm-announced": {
            /* If we don't set this, the height of the page will be confusingly changed */
            /* Still looking for a better solution */
            display: "none",
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--vscode-editorCursor-foreground)",
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.focusChanged) {
            if (update.view.hasFocus) {
              globalUndoLock = id;
            } else {
              if (globalUndoLock === id) {
                globalUndoLock = null;
              }
            }
          }
        }),
      ],
    }),
    parent: codeMirrorContainer
  });

  return codeMirrorView;
}


/**
 * Renders a bubble message in the conversation.
 * @param {HTMLElement} messageNode - The container node for the message.
 * @param {Object} message - The message object to render.
 * @param {boolean} clipContent - Whether to clip the content of the message.
 * @param {boolean} editing - Whether the message is being edited.
 */
function _renderBubbleMessage(messageNode, message, clipContent, editing) {
  if (editing && !message.isShadow) {
    const cancelButtonElement = document.createElement("button");
    cancelButtonElement.className =
      "edit-operation-button edit-operation-button-cancel";
    cancelButtonElement.innerHTML = icons.ICON_X;
    cancelButtonElement.addEventListener("click", function () {
      // Cancel editing
      messageNode.replaceWith(createMessageNode(message, false, false));
    });
    messageNode.appendChild(cancelButtonElement);
  }

  const messageContent = document.createElement("div");
  messageContent.classList.add("message-content");
  messageNode.appendChild(messageContent);

  const attachmentContainer = document.createElement("div");
  attachmentContainer.classList.add("attachment-container");
  attachmentContainer.dataset.id = message.id;

  if (editing) {
    messageContent.classList.add("editing");

    const submitButtonElement = document.createElement("button");
    submitButtonElement.className =
      "edit-operation-button edit-operation-button-submit";
    submitButtonElement.innerHTML =
      message.role === "user" &&
      (!messageIDWithChildren[message.id] || messageIDWithChildren[message.id].length === 0) ?
      icons.ICON_ARROW_RIGHT :
      icons.ICON_CHECK;
    messageNode.appendChild(submitButtonElement);

    const messageContentEditing = document.createElement("div");
    messageContentEditing.classList.add("message-content-editing");
    messageContent.appendChild(messageContentEditing);

    // Create a CodeMirror editor instance
    const codeMirrorContainer = document.createElement("div");
    codeMirrorContainer.classList.add("codemirror-container");
    codeMirrorContainer.dataset.id = message.id;
    codeMirrorContainer.dataset.vscodeContext = JSON.stringify({
      isEditor: true
    });
    messageContentEditing.appendChild(codeMirrorContainer);

    const placeholderText = message.role === "user" ? "Type a message..." : "Type a response...";
    const editor = _renderEditor(codeMirrorContainer, message.id, message.content, placeholderText, 
    (context) => {
      const before = context.matchBefore(/\/(\w*)|(\w+)/);
      if (!before) {
        return null;
      }

      const options = Object.entries(snippets).map(([completion, content]) => ({
        label: "/" + completion,
        apply: content,
        type: "text",
      }));

      return {
        from: before.from,
        options: options,
        validFor: /^(\/\w*|\w*)$/,
      };
    }, 
    (content) => {
      _handleMessageSubmit(content, message);
    });

    submitButtonElement.addEventListener("click", function () {
      // Submit editing
      _handleMessageSubmit(
        editor.state.doc.toString(),
        message
      );
    });

    if (message.role === "user") {
      // Attachment button
      const attachmentButton = document.createElement("button");
      attachmentButton.className = "attachment-button";
      attachmentButton.innerHTML = icons.ICON_PAPERCLIP;
      attachmentButton.title = "Attach an image/file";
      attachmentButton.addEventListener("click", function () {
        let configBaseMessageID = message.id;
        if (message.isShadow) {
          // A shadow message is not in the `flatMessages` yet, so we need to find the base message to get the config
          configBaseMessageID = message.parentID;
        }
        const config = getMessageConfig(configBaseMessageID);

        vscode.postMessage({
          type: "selectAttachment",
          messageID: message.id,
          providerID: config.Provider || currentProvider,
        });
      });
      messageContentEditing.appendChild(attachmentButton);

      // Quick-tune bar: provider-specified options (e.g. model, thinking effort)
      // the user can adjust for the message being composed. Only shown for the
      // active draft (shadow) message, and only when the provider declares any.
      // Placed below the editor row as a quiet composer footer.
      if (message.isShadow) {
        _appendComposerQuickBar(messageContent, message);
      }

      // Attachment list
      messageContent.appendChild(attachmentContainer);
      updateAttachments(message.id, message.attachments || [], false, attachmentContainer);
    }
  } else { // Not editing
    // Render reasoning/thinking output (if any) as a collapsible block above the answer.
    let hasReasoningBlock = false;
    if (!clipContent) {
      const reasoning = message.customFields && message.customFields.reasoning;
      if (typeof reasoning === "string" && reasoning.trim().length > 0) {
        hasReasoningBlock = true;
        // "Thinking" while reasoning is still streaming and no answer has arrived yet.
        const isThinking = message.incomplete && message.content.length === 0;

        const reasoningBlock = document.createElement("details");
        reasoningBlock.classList.add("reasoning-block");
        // Keep it expanded while streaming, collapsed once the message is complete.
        reasoningBlock.open = Boolean(message.incomplete);

        const reasoningSummary = document.createElement("summary");
        reasoningSummary.classList.add("reasoning-summary");
        if (isThinking) {
          reasoningSummary.classList.add("thinking");
        }

        const reasoningChevron = document.createElement("span");
        reasoningChevron.classList.add("reasoning-chevron");
        reasoningChevron.innerHTML = icons.ICON_CARET_RIGHT;
        reasoningSummary.appendChild(reasoningChevron);

        const reasoningLabel = document.createElement("span");
        reasoningLabel.classList.add("reasoning-label");
        reasoningLabel.textContent = isThinking ? "Thinking\u2026" : "Reasoning";
        reasoningSummary.appendChild(reasoningLabel);

        reasoningBlock.appendChild(reasoningSummary);

        const reasoningContent = document.createElement("div");
        reasoningContent.classList.add("reasoning-content", "markdown-content");
        reasoningContent.innerHTML = _renderMarkdown(reasoning);
        reasoningBlock.appendChild(reasoningContent);

        messageContent.appendChild(reasoningBlock);
      }
    }

    // While waiting for the first answer token (and not already showing the
    // reasoning "Thinking\u2026" state), show an animated typing indicator rather
    // than a static placeholder — the familiar "composing a reply" metaphor.
    // A recorded provider error (persisted on the message) is shown as its own
    // notice below, so it takes the place of the "(empty)" placeholder.
    const providerError =
      message.customFields && message.customFields.metadata && message.customFields.metadata.error;
    const hasError = typeof providerError === "string" && providerError.trim().length > 0;

    const isTypingPlaceholder =
      message.content.length === 0 && message.incomplete && !hasReasoningBlock;
    let answerText = message.content;
    if (message.content.length === 0) {
      answerText = message.incomplete || hasError ? "" : "(empty)";
    }
    let renderedContent = _renderMarkdown(answerText);
    const markdownContent = document.createElement("div");
    markdownContent.classList.add("markdown-content");
    if (message.content.length === 0 && !hasError) {
      markdownContent.classList.add(isTypingPlaceholder ? "typing" : "empty");
    }
    messageContent.appendChild(markdownContent);
    if (clipContent) {
      const clippedContent = document.createElement("div");
      clippedContent.classList.add("clipped-content");
      clippedContent.innerHTML = renderedContent;
      markdownContent.appendChild(clippedContent);
    } else {
      markdownContent.innerHTML = renderedContent;
      if (isTypingPlaceholder) {
        markdownContent.appendChild(_createTypingIndicator());
      }
    }

    if (hasError && !clipContent) {
      // Divider only when an answer streamed before the failure, to set the
      // notice off from that content; an error-only reply needs none.
      messageContent.appendChild(
        _createMessageErrorBlock(providerError, message.content.length > 0)
      );
    }

    if (!message.incomplete) {
      // Find code blocks and add copy buttons
      const codeBlocks = messageContent.querySelectorAll('pre');
      for (const codeBlock of codeBlocks) {
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-button';
        copyButton.innerHTML = icons.ICON_COPY;
        copyButton.addEventListener('click', function () {
          const code = codeBlock.querySelector('code');
          if (code) {
            const range = document.createRange();
            range.selectNode(code);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.execCommand('copy');
            window.getSelection().removeAllRanges();
          }

          copyButton.innerHTML = icons.ICON_CHECK;
        });
        codeBlock.appendChild(copyButton);
      }
    }

    // Tool calls the model emitted this turn, rendered as visible blocks.
    _appendToolCallBlocks(messageContent, message);

    if (message.attachments) {
      messageContent.appendChild(attachmentContainer);
      _renderAttachments(message.id, message.attachments, false, attachmentContainer);
    }
  }
}


/** Strips the id suffix from a provider id ("Claude@built-in" -> "Claude"). */
function _providerLabel(providerID) {
  return providerID ? String(providerID).split("@")[0] : "";
}

/** Best-effort model label for a reply that stored none (e.g. older replies). */
function _deriveModelLabel(message) {
  const config = getMessageConfig(message.id);
  return config.Model || _providerLabel(config.Provider);
}

/** Truncates a string for compact display. */
function _truncateText(text, max) {
  const str = String(text);
  return str.length > max ? str.slice(0, max - 1).trimEnd() + "\u2026" : str;
}

/** Short timestamp: time-only when today, otherwise a short (year-aware) date. */
function _formatShortDateTime(timestamp) {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(
    [],
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" }
  );
}

/** Full, unambiguous timestamp for the hover detail. */
function _formatFullDateTime(timestamp) {
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? "" : date.toLocaleString();
}

const _STALE_EXPLANATION =
  "[Context changed] An earlier message was edited after this reply was generated.";

/**
 * Builds the quiet metadata caption shown above an assistant reply (top-left,
 * outside the bubble): the model that responded and a short timestamp. It is a
 * focusable, hoverable affordance that reveals a fuller detail popover — the
 * "rarely inspected" details (provider, config, token usage) plus the staleness
 * note live there, so the always-visible caption stays minimal. The popover is
 * built lazily on first hover/focus to keep long conversations light.
 */
function _createMessageMetaHeader(message) {
  const metadata = (message.customFields && message.customFields.metadata) || {};
  const isStale = _staleMessageIDs.has(message.id);

  const header = document.createElement("div");
  header.className = "message-meta-header";
  if (isStale) {
    header.classList.add("stale");
  }
  header.tabIndex = 0;
  header.setAttribute("role", "button");
  header.setAttribute("aria-haspopup", "true");

  const model = metadata.model || _deriveModelLabel(message) || "Assistant";
  const modelEl = document.createElement("span");
  modelEl.className = "mmh-model";
  modelEl.textContent = model;
  header.appendChild(modelEl);

  const shortTime = _formatShortDateTime(message.timestamp);
  if (shortTime) {
    const sep = document.createElement("span");
    sep.className = "mmh-sep";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "\u00b7";
    header.appendChild(sep);

    const timeEl = document.createElement("span");
    timeEl.className = "mmh-time";
    timeEl.textContent = shortTime;
    header.appendChild(timeEl);
  }

  if (isStale) {
    const dot = document.createElement("span");
    dot.className = "mmh-stale-dot";
    dot.setAttribute("aria-hidden", "true");
    header.appendChild(dot);
  }

  header.setAttribute(
    "aria-label",
    "Reply by " + model + (shortTime ? ", " + _formatFullDateTime(message.timestamp) : "") +
      (isStale ? ". " + _STALE_EXPLANATION : "")
  );

  // Build the detail popover only when the caption is actually inspected.
  let popoverBuilt = false;
  const ensurePopover = () => {
    if (popoverBuilt) {
      return;
    }
    popoverBuilt = true;
    header.appendChild(_createMetaPopover(message, metadata, isStale));
  };
  header.addEventListener("pointerenter", ensurePopover);
  header.addEventListener("focus", ensurePopover);

  return header;
}

/** The hover/focus detail popover: model, when, provider, config, tokens, staleness. */
function _createMetaPopover(message, metadata, isStale) {
  const popover = document.createElement("div");
  popover.className = "mmh-popover";
  popover.setAttribute("role", "tooltip");

  const config = getMessageConfig(message.id);
  const rows = [];
  rows.push(["Model", metadata.model || _deriveModelLabel(message) || "\u2014"]);
  if (config.Provider) {
    rows.push(["Provider", _providerLabel(config.Provider)]);
  }
  const fullTime = _formatFullDateTime(message.timestamp);
  if (fullTime) {
    rows.push(["When", fullTime]);
  }
  if (config.Temperature !== undefined && config.Temperature !== "") {
    rows.push(["Temperature", String(config.Temperature)]);
  }
  const maxTokens = config.MaxTokensToSample || config.MaxTokens;
  if (maxTokens !== undefined && maxTokens !== "") {
    rows.push(["Max tokens", String(maxTokens)]);
  }
  const usage = metadata.usage;
  if (usage) {
    const parts = [];
    if (usage.promptTokens != null) {
      parts.push(usage.promptTokens + " in");
    }
    if (usage.completionTokens != null) {
      parts.push(usage.completionTokens + " out");
    }
    if (usage.totalTokens != null) {
      parts.push(usage.totalTokens + " total");
    }
    if (parts.length) {
      rows.push(["Tokens", parts.join(" \u00b7 ")]);
    }
  }
  if (config.SystemPrompt) {
    rows.push(["System prompt", _truncateText(config.SystemPrompt, 72)]);
  }

  const list = document.createElement("dl");
  list.className = "mmh-fields";
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.appendChild(dt);
    list.appendChild(dd);
  }
  popover.appendChild(list);

  if (isStale) {
    const note = document.createElement("div");
    note.className = "mmh-stale-note";
    const noteDot = document.createElement("span");
    noteDot.className = "mmh-stale-dot";
    noteDot.setAttribute("aria-hidden", "true");
    note.appendChild(noteDot);
    const noteText = document.createElement("span");
    noteText.textContent = _STALE_EXPLANATION;
    note.appendChild(noteText);
    popover.appendChild(note);
  }

  return popover;
}


/**
 * Checks if a configuration string is valid.
 * @param {string} content - The configuration string to check.
 * @returns {string|null} An error message if the config is invalid, or null if it's valid.
 */
function _checkConfig(content) {
  const config = _decodeConfig(content);
  if (Object.keys(config).length === 0) {
    return "Config is empty";
  } else {
    return null;
  }
}


/**
 * Updates the available configuration keys for a provider.
 * @param {string} providerID - The ID of the provider.
 * @param {HTMLElement} editorContainer - The container element for the editor.
 * @param {string} configKeyContainerID - The ID of the container for config keys.
 * @param {string} messageID - The ID of the message being edited.
 * @returns {Array<{label: string, apply: string, type: string, detail: string}>} The available config keys.
 */
function _updateAvailableConfigKeys(providerID, editorContainer, configKeyContainerID, messageID) {
  const configKeyContainer = document.getElementById(configKeyContainerID);
  configKeyContainer.innerHTML = "";
  const editor = EditorView.findFromDOM(editorContainer);
  if (!editor) {
    return;
  }

  let result = [];

  const config = _decodeConfig(editor.state.doc.toString());

  function createKeyToken(key, group, type, detail = undefined, hasOptions = false) {
    const tokenElement = document.createElement("span");
    tokenElement.classList.add("config-key-token");
    if (hasOptions) {
      tokenElement.classList.add("has-options");
    }
    const keyLabel = document.createElement("span");
    keyLabel.textContent = key;
    tokenElement.appendChild(keyLabel);
    if (hasOptions) {
      // A caret hints that this key offers a list of values to pick from.
      const caret = document.createElement("span");
      caret.classList.add("config-key-token-caret");
      caret.innerHTML = icons.ICON_CARET_DOWN;
      tokenElement.appendChild(caret);
    }
    tokenElement.title = group;
    tokenElement.addEventListener("click", function () {
      editor.dispatch({
        changes: {
          from: editor.state.doc.length,
          insert: key + " = "
        },
      });
      editor.focus();
      _updateAvailableConfigKeys(providerID, editorContainer, configKeyContainerID, messageID);
      if (hasOptions) {
        // Immediately open the value picker for suggested/dynamic keys.
        startCompletion(editor);
      }
    });
    configKeyContainer.appendChild(tokenElement);

    result.push({
      label: key + " = ",
      apply: key + " = ",
      type: type,
      detail: detail
    });
  }

  for (let group of Object.keys(providerConfigKeys[providerID])) {
    for (let key of providerConfigKeys[providerID][group]) {
      if (config[key] === undefined) {
        createKeyToken(key, group, `config-key-${group}`, undefined, _hasSelectableOptions(providerID, key));
      }
    }
  }

  // Add the Provider key
  if (config["Provider"] === undefined) {
    createKeyToken("Provider", "Chat Provider", "config-key-Provider");
  }

  return result;
}


/**
 * Renders a configuration node in the conversation.
 * @param {HTMLElement} messageNode - The container node for the message.
 * @param {Object} message - The message object to render.
 * @param {boolean} clipContent - Whether to clip the content of the message.
 * @param {boolean} editing - Whether the message is being edited.
 */
function _renderConfigNode(messageNode, message, clipContent, editing) {
  if (editing) {
    const config = getMessageConfig(message.id);
    const providerID = config.Provider || currentProvider;

    const validityCheckElement = document.createElement("div");
    validityCheckElement.classList.add("validity-check");

    const configKeyContainer = document.createElement("div");
    configKeyContainer.classList.add("config-key-container");
    configKeyContainer.id = `config-key-container-${message.id}`;

    const codeMirrorContainer = document.createElement("div");
    codeMirrorContainer.classList.add("codemirror-container");
    codeMirrorContainer.dataset.id = message.id;
    codeMirrorContainer.dataset.vscodeContext = JSON.stringify({
      isEditor: true
    });
    messageNode.appendChild(codeMirrorContainer);

    let autocompleteItems = [];

    const editor = _renderEditor(codeMirrorContainer, message.id, _encodeConfig(JSON.parse(message.content)), "Type the configuration...",
      (context) => {
        if (!providerConfigKeys[providerID]) {
          return null;
        }

        // Value position: completing the value of "Key = <prefix>" on this line.
        // For suggested/dynamic keys, offer the provider's selectable values.
        const line = context.state.doc.lineAt(context.pos);
        const textBefore = line.text.slice(0, context.pos - line.from);
        const keyValueMatch = /^(\w[\w-]*)\s*=\s*(.*)$/.exec(textBefore);
        if (keyValueMatch) {
          const key = keyValueMatch[1];
          const valuePrefix = keyValueMatch[2];
          if (!_hasSelectableOptions(providerID, key)) {
            return null;
          }
          const meta = _optionMetaFor(providerID, key) || {};
          const staticOptions = (meta.suggestions || []).map((value) => ({ value }));
          const cached = providerDynamicOptionsCache[providerID] && providerDynamicOptionsCache[providerID][key];
          const optionList = cached ? _mergeOptions(cached, staticOptions) : staticOptions;

          // Lazily fetch dynamic options, reopening the picker once they arrive.
          if (meta.dynamic && !cached) {
            let sync = true;
            _loadDynamicOptions(providerID, key, (options, loading) => {
              // Only reopen on the asynchronous arrival (not the synchronous
              // static/error response), so a failed fetch can't loop.
              if (!sync && !loading) {
                const liveEditor = EditorView.findFromDOM(codeMirrorContainer);
                if (liveEditor && liveEditor.hasFocus) {
                  startCompletion(liveEditor);
                }
              }
            });
            sync = false;
          }

          const valueOptions = optionList.map((option) => ({
            label: option.value,
            detail: option.label || option.detail,
            type: "config-value",
          }));
          if (valueOptions.length === 0) {
            return null;
          }
          return {
            from: context.pos - valuePrefix.length,
            options: valueOptions,
            validFor: /^.*$/,
          };
        }

        if (autocompleteItems.length === 0) {
          autocompleteItems = _updateAvailableConfigKeys(providerID, codeMirrorContainer, configKeyContainer.id, message.id);
        }
      
        const before = context.matchBefore(/^\w*/);
      
        if (!before) {
          return null;
        }
      
        return {
          from: before.from,
          options: autocompleteItems,
        };
      },
      (content) => {
      const error = _checkConfig(content);
      if (error) {
        validityCheckElement.textContent = error;
        validityCheckElement.classList.add("invalid");
      } else {
        _handleMessageSubmit(JSON.stringify(_decodeConfig(content)), message);
      }
    });

    const operationBar = document.createElement("div");
    operationBar.classList.add("operation-bar");
    messageNode.appendChild(operationBar);

    // Config Key Container
    operationBar.appendChild(configKeyContainer);

    // Save and Cancel Buttons
    const buttonContainer = document.createElement("div");
    buttonContainer.classList.add("operation-group");
    operationBar.appendChild(buttonContainer);

    const cancelButtonElement = document.createElement("button");
    cancelButtonElement.className = "button";
    cancelButtonElement.textContent = "Cancel";

    cancelButtonElement.addEventListener("click", function () {
      // Cancel editing
      messageNode.replaceWith(createMessageNode(message, false, false));
    });

    const saveButtonElement = document.createElement("button");
    saveButtonElement.className = "button primary";
    saveButtonElement.textContent = "Done";

    saveButtonElement.addEventListener("click", function () {
      // Submit editing
      _handleMessageSubmit(
        JSON.stringify(_decodeConfig(editor.state.doc.toString())),
        message
      );
    });

    buttonContainer.appendChild(cancelButtonElement);
    buttonContainer.appendChild(saveButtonElement);

    // Fetch provider config keys
    if (providerID) {
      vscode.postMessage({
        type: "fetchProviderConfig",
        providerID: providerID,
      });
    }
  } else {  // Not editing
    const config = JSON.parse(message.content);

    if (Object.keys(config).length === 0) {
      const noConfigElement = document.createElement("div");
      noConfigElement.classList.add("no-config");
      noConfigElement.textContent = "Empty Config";
      messageNode.appendChild(noConfigElement);
    } else {
      for (let key in config) {
        const rowElement = document.createElement("div");
        rowElement.classList.add("config-row");

        const keyElement = document.createElement("span");
        keyElement.classList.add("config-key");
        keyElement.textContent = key;
        rowElement.appendChild(keyElement);

        const valueElement = document.createElement("span");
        valueElement.classList.add("config-value");
        valueElement.innerHTML = _renderMarkdown(config[key]);
        rowElement.appendChild(valueElement);

        messageNode.appendChild(rowElement);
      }
    }
  }
}


/**
 * Finds the tool-result node that answers a given tool call id, if one exists.
 * Call ids are unique, so a global lookup is sufficient.
 * @param {string} callID
 * @returns {Object|undefined}
 */
function _findToolResult(callID) {
  return Object.values(flatMessages).find(
    (m) => m.role === "tool" && m.customFields && m.customFields.toolCallID === callID
  );
}

/** Pretty-prints tool-call arguments (unwrapping the invalid-JSON `_raw` case). */
function _formatToolArgs(args) {
  if (args && typeof args === "object" && "_raw" in args && Object.keys(args).length === 1) {
    return String(args._raw);
  }
  try {
    return JSON.stringify(args === undefined ? {} : args, null, 2);
  } catch (e) {
    return String(args);
  }
}

/**
 * Renders one tool call the model emitted as a visible, collapsible block. Its
 * status (requested / running / ran / failed / stopped) is derived from the live
 * runtime and any matching tool-result node, so the block always reflects where
 * the call is in its lifecycle. While running it shows progress and a Stop; while
 * a tool is asking for input it shows an elicitation form. The arguments can be
 * edited in place (like a config node) and the call re-run.
 * @param {Object} call - { id, name, arguments }
 * @param {Object} assistantMessage - the assistant turn that emitted the call
 * @returns {HTMLElement}
 */
function _createToolCallBlock(call, assistantMessage) {
  const runtime = _toolRuntime[call.id];
  const result = _findToolResult(call.id);
  const status = _toolCallStatus(call, runtime, result);
  const active = status === "running" || status === "stopping";

  const block = document.createElement("details");
  block.className = "tool-call-block tool-call-" + status;
  block.open = status === "pending" || active || Boolean(runtime && runtime.elicit);
  block.dataset.callId = call.id;

  const summary = document.createElement("summary");
  summary.className = "tool-call-summary";

  const icon = document.createElement("span");
  icon.className = "tool-call-icon";
  icon.innerHTML = _toolCallIcon(status);
  summary.appendChild(icon);

  const name = document.createElement("span");
  name.className = "tool-call-name";
  name.textContent = call.name || "tool";
  summary.appendChild(name);

  const label = document.createElement("span");
  label.className = "tool-call-status-label";
  label.setAttribute("aria-live", "polite");
  label.textContent = _toolCallStatusLabel(status, runtime);
  summary.appendChild(label);

  // A running call can be stopped straight from its summary. The click is kept
  // from toggling the <details> so Stop stops rather than collapses.
  if (active) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "tool-call-stop";
    stop.innerHTML = icons.ICON_STOP_FILL + "<span>Stop</span>";
    stop.title = "Stop waiting for this tool. A remote server may keep running its work.";
    stop.setAttribute("aria-label", "Stop " + (call.name || "tool"));
    stop.disabled = status === "stopping";
    stop.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      _stopToolCall(call.id);
    });
    summary.appendChild(stop);
  }

  block.appendChild(summary);

  const args = document.createElement("pre");
  args.className = "tool-call-args";
  const code = document.createElement("code");
  code.textContent = _formatToolArgs(call.arguments);
  args.appendChild(code);
  block.appendChild(args);

  // Live progress while running (hidden while a form is showing, to keep focus).
  if (active && !(runtime && runtime.elicit)) {
    block.appendChild(_buildToolProgress(runtime && runtime.progress));
  }

  // An open elicitation form: the tool is asking the user for input.
  if (runtime && runtime.elicit) {
    block.appendChild(_buildElicitationForm(call, assistantMessage, runtime));
  }

  // In-block actions (edit arguments / re-run), for a settled call only. Kept
  // quiet so transparency never becomes clutter.
  if (!active) {
    const actions = document.createElement("div");
    actions.className = "tool-call-actions";
    actions.appendChild(_toolCallActionButton(icons.ICON_PENCIL, "Edit arguments", () => {
      _beginToolCallArgEdit(block, args, actions, assistantMessage, call);
    }));
    actions.appendChild(_toolCallActionButton(icons.ICON_ARROW_REPEAT, result ? "Run again" : "Run", () => {
      _rerunToolCall(assistantMessage, call, label);
    }));
    block.appendChild(actions);
  }

  return block;
}

/** Derives a tool call's lifecycle status from its live runtime and result node. */
function _toolCallStatus(call, runtime, result) {
  if (runtime && (runtime.status === "running" || runtime.status === "stopping")) {
    return runtime.status;
  }
  if (!result) {
    return "pending";
  }
  const cf = result.customFields || {};
  if (cf.stopped) {
    return cf.timedOut ? "timedout" : "stopped";
  }
  return cf.isError ? "failed" : "done";
}

/** The summary icon for a tool-call status (a spinner while active). */
function _toolCallIcon(status) {
  if (status === "running" || status === "stopping") {
    return '<span class="tool-call-spinner" aria-hidden="true"></span>';
  }
  if (status === "failed") {
    return icons.ICON_TOOL_FAILED;
  }
  if (status === "stopped" || status === "timedout") {
    return icons.ICON_DASH_CIRCLE;
  }
  if (status === "done") {
    return icons.ICON_TOOL_USED;
  }
  return icons.ICON_TOOL;
}

/** The trailing status label for a tool-call block. */
function _toolCallStatusLabel(status, runtime) {
  switch (status) {
    case "running":
      return (runtime && runtime.elicit) ? "Waiting for you" : ("Running \u00b7 " + _formatElapsed(runtime ? Date.now() - runtime.startedAt : 0));
    case "stopping": return "Stopping\u2026";
    case "stopped": return "Stopped";
    case "timedout": return "Timed out";
    case "failed": return "Failed";
    case "done": return "Ran";
    default: return "Requested";
  }
}

/** Formats an elapsed duration compactly ("4s", "1m 05s"). */
function _formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return seconds + "s";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes + "m " + (rest < 10 ? "0" : "") + rest + "s";
}

/**
 * Builds the progress track shown while a tool runs. A server that reports a
 * `total` gets a determinate fill; otherwise an indeterminate bar (the graceful
 * default, since most tools report nothing). Any progress `message` is shown
 * beneath, replacing in place.
 */
function _buildToolProgress(progress) {
  const wrap = document.createElement("div");
  wrap.className = "tool-call-progress";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");

  const track = document.createElement("div");
  track.className = "tool-call-progress-track";
  const fill = document.createElement("div");
  fill.className = "tool-call-progress-fill";

  const hasTotal = progress && typeof progress.total === "number" && progress.total > 0 && typeof progress.progress === "number";
  if (hasTotal) {
    fill.style.width = Math.max(0, Math.min(100, (progress.progress / progress.total) * 100)) + "%";
  } else {
    fill.classList.add("indeterminate");
  }
  track.appendChild(fill);
  wrap.appendChild(track);

  const messageText = (progress && progress.message) ? String(progress.message) : "";
  if (messageText) {
    const line = document.createElement("div");
    line.className = "tool-call-progress-message";
    line.textContent = messageText;
    wrap.appendChild(line);
  }
  return wrap;
}

/** Finds a tool-call block element by its call id. */
function _toolBlockEl(callID) {
  const selector = '.tool-call-block[data-call-id="' + ((window.CSS && CSS.escape) ? CSS.escape(String(callID)) : String(callID)) + '"]';
  return document.querySelector(selector);
}

/** Rebuilds a tool-call block in place from its current runtime + result. */
function _replaceToolBlock(callID) {
  const runtime = _toolRuntime[callID];
  const el = _toolBlockEl(callID);
  if (!runtime || !el) {
    return;
  }
  const assistant = flatMessages[runtime.assistantID] || { id: runtime.assistantID };
  el.replaceWith(_createToolCallBlock(runtime.call, assistant));
}

// --- Tool-call live progress, cancellation, elicitation ---------------------

/** Starts the shared 1s ticker that refreshes running elapsed labels. */
function _startToolTicker() {
  if (_toolTicker) {
    return;
  }
  _toolTicker = setInterval(_tickToolTimers, 1000);
}

/** Stops the shared ticker. */
function _stopToolTicker() {
  if (_toolTicker) {
    clearInterval(_toolTicker);
    _toolTicker = null;
  }
}

/** Stops the ticker if nothing is running. */
function _stopToolTickerIfIdle() {
  const anyRunning = Object.keys(_toolRuntime).some((id) => {
    const runtime = _toolRuntime[id];
    return runtime && (runtime.status === "running" || runtime.status === "stopping");
  });
  if (!anyRunning) {
    _stopToolTicker();
  }
}

/** Refreshes the elapsed label of each running call (only that text node). */
function _tickToolTimers() {
  let any = false;
  for (const callID in _toolRuntime) {
    const runtime = _toolRuntime[callID];
    if (!runtime || (runtime.status !== "running" && runtime.status !== "stopping")) {
      continue;
    }
    any = true;
    if (runtime.elicit || runtime.status === "stopping") {
      continue;
    }
    const block = _toolBlockEl(callID);
    const label = block && block.querySelector(".tool-call-status-label");
    if (label) {
      label.textContent = "Running \u00b7 " + _formatElapsed(Date.now() - runtime.startedAt);
    }
  }
  if (!any) {
    _stopToolTicker();
  }
}

/** Requests cancellation of a running tool call (a stop, not an error). */
function _stopToolCall(callID) {
  const runtime = _toolRuntime[callID];
  if (!runtime || runtime.status === "stopping") {
    return;
  }
  runtime.status = "stopping";
  // Stopping also cancels any open elicitation for the call.
  if (runtime.elicit) {
    vscode.postMessage({ type: "toolElicitResult", requestID: runtime.requestID, elicitationID: runtime.elicit.elicitationID, action: "cancel" });
    runtime.elicit = null;
  }
  _replaceToolBlock(callID);
  vscode.postMessage({ type: "cancelTool", requestID: runtime.requestID });
}

/** Applies a progress update to a running call's block, in place. */
function _handleToolProgress(message) {
  const pending = _pendingToolRequests[message.requestID];
  if (!pending) {
    return;
  }
  const runtime = _toolRuntime[pending.call.id];
  if (!runtime) {
    return;
  }
  runtime.progress = message.progress || {};
  if (runtime.elicit) {
    // A form is showing; hold the progress display until it closes.
    return;
  }
  const block = _toolBlockEl(pending.call.id);
  if (!block) {
    return;
  }
  const fresh = _buildToolProgress(runtime.progress);
  const existing = block.querySelector(".tool-call-progress");
  if (existing) {
    existing.replaceWith(fresh);
  } else {
    const args = block.querySelector(".tool-call-args");
    if (args && args.after) {
      args.after(fresh);
    } else {
      block.appendChild(fresh);
    }
  }
}

/** Surfaces a tool's elicitation request as an in-conversation form. */
function _handleToolElicit(message) {
  const pending = _pendingToolRequests[message.requestID];
  const runtime = pending && _toolRuntime[pending.call.id];
  if (!pending || !runtime) {
    // No live call to attach this to; decline so the tool isn't left hanging.
    vscode.postMessage({ type: "toolElicitResult", requestID: message.requestID, elicitationID: message.elicitationID, action: "cancel" });
    return;
  }
  runtime.elicit = {
    elicitationID: message.elicitationID,
    message: message.message || "",
    schema: message.schema || { type: "object", properties: {} },
    values: {},
  };
  _replaceToolBlock(pending.call.id);
  const block = _toolBlockEl(pending.call.id);
  const firstField = block && block.querySelector(".tool-elic-input, .tool-elic-select, .tool-elic-check");
  if (firstField) {
    setTimeout(() => { try { firstField.focus(); } catch (e) { /* ignore */ } }, 0);
  }
}

/** The provenance line for an elicitation form ("who is asking"). */
function _elicitationWho(call, assistantMessage) {
  const enabled = _enabledToolsAt(assistantMessage ? assistantMessage.id : null);
  const entry = _findEnabledEntry(enabled, call.name);
  if (entry && entry.source === "ask_user") {
    return "The assistant is asking";
  }
  const label = (entry && (entry.server || entry.sourceLabel)) || (entry && entry.source) || call.name || "A tool";
  return label + " is asking";
}

/** Maps a string schema `format` to an input type. */
function _elicInputType(format) {
  switch (format) {
    case "email": return "email";
    case "uri": return "url";
    case "date": return "date";
    case "date-time": return "datetime-local";
    default: return "text";
  }
}

/** True if a string parses as a URL. */
function _isValidUri(value) {
  try {
    new URL(value);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Builds one form control for an elicitation field from its schema, returning
 * the wrapper plus a value getter, a validator, and a change subscription. The
 * current value is mirrored into `elicit.values` so the form survives a re-render
 * (e.g. when a sibling tool call settles) without losing what the user typed.
 */
function _buildElicitationField(fieldName, prop, isRequired, elicit, requestSend) {
  const wrap = document.createElement("div");
  wrap.className = "tool-elic-field";

  const type = prop.type || "string";
  const controlId = "elic-" + String(fieldName).replace(/[^\w-]/g, "_") + "-" + Math.random().toString(36).slice(2, 7);
  const title = prop.title || fieldName;
  const stored = (elicit.values && fieldName in elicit.values) ? elicit.values[fieldName] : (prop.default !== undefined ? prop.default : undefined);

  const changeHandlers = [];
  let getValue = () => undefined;

  const errorLine = document.createElement("div");
  errorLine.className = "tool-elic-error";
  errorLine.style.display = "none";

  const emitChange = () => {
    elicit.values[fieldName] = getValue();
    changeHandlers.forEach((handler) => handler());
  };

  if (type === "boolean") {
    const row = document.createElement("label");
    row.className = "tool-elic-field-row";
    row.setAttribute("for", controlId);
    const control = document.createElement("input");
    control.type = "checkbox";
    control.className = "tool-elic-check";
    control.id = controlId;
    control.checked = Boolean(stored);
    const text = document.createElement("span");
    text.className = "tool-elic-label";
    text.textContent = title;
    if (isRequired) {
      const req = document.createElement("span");
      req.className = "tool-elic-required";
      req.textContent = " (required)";
      text.appendChild(req);
    }
    row.appendChild(control);
    row.appendChild(text);
    wrap.appendChild(row);
    getValue = () => control.checked;
    control.addEventListener("change", emitChange);
  } else {
    const labelEl = document.createElement("label");
    labelEl.className = "tool-elic-label";
    labelEl.setAttribute("for", controlId);
    labelEl.textContent = title;
    if (isRequired) {
      const req = document.createElement("span");
      req.className = "tool-elic-required";
      req.textContent = " *";
      labelEl.appendChild(req);
    }
    wrap.appendChild(labelEl);

    if (Array.isArray(prop.enum) && prop.enum.length) {
      // A choice field. `allowCustom` (set by ICE tools like ask_user, never by a
      // strict MCP enum) adds an "Other" option so the user is not boxed in.
      const allowCustom = Boolean(prop.allowCustom);
      const optionLabel = (i, value) => (Array.isArray(prop.enumNames) && prop.enumNames[i] != null) ? String(prop.enumNames[i]) : String(value);
      let selectedIndex = -1;
      let customMode = false;
      if (stored !== undefined) {
        const idx = prop.enum.findIndex((v) => String(v) === String(stored));
        if (idx >= 0) { selectedIndex = idx; }
        else if (allowCustom) { customMode = true; }
      }
      let customInput = null;
      let refreshSelection = () => {};

      getValue = () => {
        if (customMode) {
          return (customInput && customInput.value !== "") ? customInput.value : undefined;
        }
        return selectedIndex >= 0 ? prop.enum[selectedIndex] : undefined;
      };

      const makeCustomInput = () => {
        customInput = document.createElement("input");
        customInput.type = "text";
        customInput.className = "tool-elic-input tool-elic-other-input";
        customInput.placeholder = "Type your answer\u2026";
        if (customMode && stored !== undefined) { customInput.value = String(stored); }
        customInput.addEventListener("input", emitChange);
        wrap.appendChild(customInput);
      };

      if (prop.enum.length <= 5) {
        // A short list is a vertical stack of full-width options (so long labels
        // stay readable). Click to choose; the chosen option shows a send arrow,
        // and clicking it again sends. The Send button stays available either way.
        const group = document.createElement("div");
        group.className = "tool-elic-choices";
        group.setAttribute("role", "radiogroup");
        const options = [];
        prop.enum.forEach((value, i) => {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "tool-elic-option";
          option.setAttribute("role", "radio");
          option.title = "Click to choose. Click again to send.";
          const optLabel = document.createElement("span");
          optLabel.className = "tool-elic-option-label";
          optLabel.textContent = optionLabel(i, value);
          option.appendChild(optLabel);
          const sendHint = document.createElement("span");
          sendHint.className = "tool-elic-option-send";
          sendHint.setAttribute("aria-hidden", "true");
          sendHint.innerHTML = icons.ICON_ARROW_RIGHT;
          option.appendChild(sendHint);
          option.addEventListener("click", () => {
            if (selectedIndex === i && !customMode) {
              if (requestSend) { requestSend(); }
              return;
            }
            selectedIndex = i;
            customMode = false;
            refreshSelection();
            emitChange();
          });
          options.push(option);
          group.appendChild(option);
        });
        let otherOption = null;
        if (allowCustom) {
          otherOption = document.createElement("button");
          otherOption.type = "button";
          otherOption.className = "tool-elic-option tool-elic-option-other";
          otherOption.setAttribute("role", "radio");
          otherOption.title = "Type your own answer.";
          const otherLabel = document.createElement("span");
          otherLabel.className = "tool-elic-option-label";
          otherLabel.textContent = "Other\u2026";
          otherOption.appendChild(otherLabel);
          otherOption.addEventListener("click", () => {
            customMode = true;
            selectedIndex = -1;
            refreshSelection();
            emitChange();
            if (customInput) { setTimeout(() => customInput.focus(), 0); }
          });
          group.appendChild(otherOption);
        }
        wrap.appendChild(group);
        if (allowCustom) { makeCustomInput(); }

        refreshSelection = () => {
          options.forEach((option, i) => {
            const on = selectedIndex === i && !customMode;
            option.classList.toggle("selected", on);
            option.setAttribute("aria-checked", on ? "true" : "false");
          });
          if (otherOption) {
            otherOption.classList.toggle("selected", customMode);
            otherOption.setAttribute("aria-checked", customMode ? "true" : "false");
          }
          if (customInput) { customInput.style.display = customMode ? "" : "none"; }
        };
        refreshSelection();
      } else {
        const select = document.createElement("select");
        select.className = "tool-elic-select";
        select.id = controlId;
        if (!isRequired || (selectedIndex < 0 && !customMode)) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = isRequired ? "Select\u2026" : "(none)";
          select.appendChild(opt);
        }
        prop.enum.forEach((value, i) => {
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = optionLabel(i, value);
          if (selectedIndex === i) { opt.selected = true; }
          select.appendChild(opt);
        });
        if (allowCustom) {
          const opt = document.createElement("option");
          opt.value = "__other__";
          opt.textContent = "Other\u2026";
          if (customMode) { opt.selected = true; }
          select.appendChild(opt);
        }
        wrap.appendChild(select);
        if (allowCustom) { makeCustomInput(); }

        refreshSelection = () => {
          if (customInput) { customInput.style.display = customMode ? "" : "none"; }
        };
        select.addEventListener("change", () => {
          if (select.value === "__other__") {
            customMode = true;
            selectedIndex = -1;
          } else if (select.value === "") {
            customMode = false;
            selectedIndex = -1;
          } else {
            customMode = false;
            selectedIndex = Number(select.value);
          }
          refreshSelection();
          emitChange();
          if (customMode && customInput) { setTimeout(() => customInput.focus(), 0); }
        });
        refreshSelection();
      }
    } else if (type === "number" || type === "integer") {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "tool-elic-input";
      input.id = controlId;
      if (typeof prop.minimum === "number") { input.min = String(prop.minimum); }
      if (typeof prop.maximum === "number") { input.max = String(prop.maximum); }
      if (type === "integer") { input.step = "1"; }
      if (stored !== undefined && stored !== null) { input.value = String(stored); }
      wrap.appendChild(input);
      getValue = () => {
        if (input.value === "") { return undefined; }
        const parsed = type === "integer" ? parseInt(input.value, 10) : parseFloat(input.value);
        return isNaN(parsed) ? undefined : parsed;
      };
      input.addEventListener("input", emitChange);
    } else {
      const input = document.createElement("input");
      input.type = _elicInputType(prop.format);
      input.className = "tool-elic-input";
      input.id = controlId;
      if (stored !== undefined && stored !== null) { input.value = String(stored); }
      wrap.appendChild(input);
      getValue = () => (input.value === "" ? undefined : input.value);
      input.addEventListener("input", emitChange);
    }
  }

  if (prop.description) {
    const desc = document.createElement("div");
    desc.className = "tool-elic-desc";
    desc.textContent = prop.description;
    wrap.appendChild(desc);
  }
  wrap.appendChild(errorLine);

  const validate = (show) => {
    const value = getValue();
    let error = "";
    if (isRequired && (value === undefined || value === "")) {
      error = "Required.";
    } else if ((type === "number" || type === "integer") && value !== undefined) {
      if (typeof prop.minimum === "number" && value < prop.minimum) {
        error = "Must be \u2265 " + prop.minimum + ".";
      } else if (typeof prop.maximum === "number" && value > prop.maximum) {
        error = "Must be \u2264 " + prop.maximum + ".";
      }
    } else if (type === "string" && typeof value === "string" && value) {
      if (prop.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        error = "Enter a valid email address.";
      } else if (prop.format === "uri" && !_isValidUri(value)) {
        error = "Enter a valid URL.";
      }
    }
    if (show) {
      if (error) {
        errorLine.textContent = error;
        errorLine.style.display = "";
        wrap.classList.add("invalid");
      } else {
        errorLine.style.display = "none";
        wrap.classList.remove("invalid");
      }
    }
    return !error;
  };

  return {
    name: fieldName,
    wrap: wrap,
    get: getValue,
    validate: validate,
    onChange: (handler) => changeHandlers.push(handler),
  };
}

/** Reads and validates every field, returning validity plus the content object. */
function _collectElicitation(controls, showErrors) {
  let valid = true;
  const content = {};
  controls.forEach((control) => {
    if (!control.validate(showErrors)) {
      valid = false;
    }
    const value = control.get();
    if (value !== undefined && value !== "") {
      content[control.name] = value;
    }
  });
  return { valid: valid, content: content };
}

/** Sends an accept if the form validates. */
function _submitElicitation(callID, controls) {
  const collected = _collectElicitation(controls, true);
  if (!collected.valid) {
    return;
  }
  _resolveElicitation(callID, "accept", collected.content);
}

/** Resolves an open elicitation with an action, returning the call to running. */
function _resolveElicitation(callID, action, content) {
  const runtime = _toolRuntime[callID];
  if (!runtime || !runtime.elicit) {
    return;
  }
  vscode.postMessage({
    type: "toolElicitResult",
    requestID: runtime.requestID,
    elicitationID: runtime.elicit.elicitationID,
    action: action,
    content: action === "accept" ? (content || {}) : undefined,
  });
  runtime.elicit = null;
  if (runtime.status === "running") {
    _replaceToolBlock(callID);
    _startToolTicker();
  }
}

/**
 * Builds the in-conversation elicitation form: a program asking the human for
 * input, shown where the pause originates. Provenance (who is asking) and a clear
 * decline/dismiss path are structural, not decorative: elicitation must never be
 * a trap. The three exits map 1:1 to the protocol (accept / decline / cancel).
 */
function _buildElicitationForm(call, assistantMessage, runtime) {
  const elicit = runtime.elicit;
  const schema = elicit.schema || { type: "object", properties: {} };
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  const form = document.createElement("div");
  form.className = "tool-elicitation";
  form.setAttribute("role", "group");

  const header = document.createElement("div");
  header.className = "tool-elicitation-header";
  const headerIcon = document.createElement("span");
  headerIcon.className = "tool-elicitation-icon";
  headerIcon.innerHTML = icons.ICON_QUESTION_CIRCLE;
  header.appendChild(headerIcon);
  const who = document.createElement("span");
  who.className = "tool-elicitation-who";
  who.textContent = _elicitationWho(call, assistantMessage);
  header.appendChild(who);
  form.setAttribute("aria-label", who.textContent);
  form.appendChild(header);

  if (elicit.message) {
    const messageEl = document.createElement("div");
    messageEl.className = "tool-elicitation-message";
    messageEl.textContent = elicit.message;
    form.appendChild(messageEl);
  }

  const fieldsWrap = document.createElement("div");
  fieldsWrap.className = "tool-elicitation-fields";
  form.appendChild(fieldsWrap);

  let controls = [];
  let sendButton;
  const requestSend = () => {
    if (sendButton && !sendButton.disabled) {
      _submitElicitation(call.id, controls);
    }
  };

  controls = Object.keys(properties).map((fieldName) => {
    const built = _buildElicitationField(fieldName, properties[fieldName] || {}, required.includes(fieldName), elicit, requestSend);
    fieldsWrap.appendChild(built.wrap);
    return built;
  });

  const bar = document.createElement("div");
  bar.className = "tool-elicitation-bar";
  const skipButton = document.createElement("button");
  skipButton.className = "tool-approval-button";
  skipButton.textContent = "Skip";
  skipButton.title = "Continue without answering this question.";
  skipButton.addEventListener("click", () => _resolveElicitation(call.id, "decline"));
  bar.appendChild(skipButton);
  sendButton = document.createElement("button");
  sendButton.className = "tool-approval-button primary";
  sendButton.textContent = "Send";
  sendButton.title = "Send your answer to the assistant.";
  sendButton.addEventListener("click", () => _submitElicitation(call.id, controls));
  bar.appendChild(sendButton);
  form.appendChild(bar);

  const revalidate = () => {
    sendButton.disabled = !_collectElicitation(controls, false).valid;
  };
  controls.forEach((control) => control.onChange(revalidate));
  revalidate();

  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target && event.target.tagName !== "TEXTAREA" && !event.shiftKey) {
      event.preventDefault();
      if (!sendButton.disabled) {
        _submitElicitation(call.id, controls);
      }
    }
  });

  return form;
}

/** Builds a quiet icon button for the tool-call block's action row. */
function _toolCallActionButton(iconHtml, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool-call-action";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = iconHtml;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** The JSON schema for a tool call, from the tool enabled at that point (or null). */
function _schemaForCall(assistantMessage, call) {
  if (!assistantMessage) {
    return null;
  }
  const entry = _findEnabledEntry(_enabledToolsAt(assistantMessage.id), call.name);
  return (entry && entry.inputSchema) || null;
}

/**
 * Autocompletion for the tool-argument JSON editor, driven by the tool's input
 * schema — mirroring the config editor's two modes: property names at a key
 * position, and enum/boolean values after a `"key":`.
 */
function _toolArgsAutocomplete(schema) {
  const properties = (schema && schema.properties) || {};
  const required = (schema && Array.isArray(schema.required)) ? schema.required : [];
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);

    // Value position: `"key": <prefix>` — offer enum/boolean values.
    const valueMatch = /"?([\w-]+)"?\s*:\s*("?)([^",}\]]*)$/.exec(textBefore);
    if (valueMatch) {
      const property = properties[valueMatch[1]];
      if (property) {
        let values = [];
        if (Array.isArray(property.enum)) {
          values = property.enum;
        } else if (property.type === "boolean") {
          values = [true, false];
        }
        if (values.length > 0) {
          const quote = property.type === "string" || (Array.isArray(property.enum) && typeof property.enum[0] === "string");
          const prefix = valueMatch[3];
          return {
            from: context.pos - prefix.length,
            options: values.map((value) => ({
              label: String(value),
              apply: quote ? JSON.stringify(String(value)) : String(value),
              type: "config-value",
            })),
            validFor: /^[^",}\]]*$/,
          };
        }
      }
    }

    // Key position: start of a line / after `{` or `,` — offer property names.
    const keyMatch = /(?:^|[{,])\s*("?)([\w-]*)$/.exec(textBefore);
    if (keyMatch && Object.keys(properties).length > 0) {
      let present = {};
      try {
        present = JSON.parse(context.state.doc.toString()) || {};
      } catch (e) {
        present = {};
      }
      const word = keyMatch[2];
      const options = Object.keys(properties)
        .filter((propertyName) => !(propertyName in present) || propertyName.indexOf(word) === 0)
        .map((propertyName) => {
          const property = properties[propertyName] || {};
          const detail = [property.type || "any"].concat(required.includes(propertyName) ? ["required"] : []).join(" \u00b7 ");
          return {
            label: propertyName,
            apply: JSON.stringify(propertyName) + ": ",
            type: "property",
            detail: detail,
            info: property.description || undefined,
          };
        });
      if (options.length > 0) {
        return {
          from: context.pos - (keyMatch[1].length + word.length),
          options: options,
          validFor: /^"?[\w-]*$/,
        };
      }
    }
    return null;
  };
}

/**
 * Swaps a tool call's argument viewer for an inline JSON editor (with schema
 * autocompletion), in place, so the surrounding turn and other blocks are
 * undisturbed. Saving validates the JSON and records it on the assistant turn.
 */
function _beginToolCallArgEdit(block, argsView, actions, assistantMessage, call) {
  actions.style.display = "none";
  argsView.style.display = "none";

  const editWrap = document.createElement("div");
  editWrap.className = "tool-call-arg-editor";

  const codeMirrorContainer = document.createElement("div");
  codeMirrorContainer.classList.add("codemirror-container");
  codeMirrorContainer.dataset.vscodeContext = JSON.stringify({ isEditor: true });
  editWrap.appendChild(codeMirrorContainer);

  const validity = document.createElement("div");
  validity.className = "tool-call-validity";
  editWrap.appendChild(validity);

  const bar = document.createElement("div");
  bar.className = "tool-call-edit-bar";
  editWrap.appendChild(bar);

  const submit = (content) => {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      validity.textContent = "Invalid JSON: " + error.message;
      validity.classList.add("invalid");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      validity.textContent = "Arguments must be a JSON object.";
      validity.classList.add("invalid");
      return;
    }
    _saveToolCallArgs(assistantMessage, call, parsed);
    argsView.firstChild.textContent = _formatToolArgs(parsed);
    // Signal that the shown result no longer matches the arguments; the Re-run
    // button beside it is the way to refresh.
    const statusLabel = block.querySelector(".tool-call-status-label");
    if (statusLabel && _findToolResult(call.id)) {
      statusLabel.textContent = "Edited \u00b7 run again";
    }
    close();
  };

  const editor = _renderEditor(
    codeMirrorContainer,
    "toolargs-" + call.id,
    _formatToolArgs(call.arguments),
    "Edit arguments as JSON\u2026",
    _toolArgsAutocomplete(_schemaForCall(assistantMessage, call)),
    submit
  );

  const cancelButton = document.createElement("button");
  cancelButton.className = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => close());
  bar.appendChild(cancelButton);

  const saveButton = document.createElement("button");
  saveButton.className = "button primary";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => submit(editor.state.doc.toString()));
  bar.appendChild(saveButton);

  function close() {
    editWrap.remove();
    argsView.style.display = "";
    actions.style.display = "";
  }

  block.insertBefore(editWrap, argsView.nextSibling);
  setTimeout(() => editor.focus(), 0);
}

/**
 * Records edited arguments on the assistant turn that emitted the call. The full
 * customFields object is sent because Edit actions replace it wholesale; the
 * bumped timestamp marks any existing result (and downstream) as stale.
 */
function _saveToolCallArgs(assistantMessage, call, newArgs) {
  const message = flatMessages[assistantMessage.id] || assistantMessage;
  const customFields = message.customFields ? { ...message.customFields } : {};
  const toolCalls = Array.isArray(customFields.toolCalls) ? customFields.toolCalls.map((existing) => ({ ...existing })) : [];
  const target = toolCalls.find((existing) => existing.id === call.id);
  if (!target) {
    return;
  }
  target.arguments = newArgs;
  customFields.toolCalls = toolCalls;
  message.customFields = customFields;
  message.timestamp = new Date().toISOString();
  call.arguments = newArgs; // keep the block's own copy in sync for a later re-run

  updateFlatMessages(message);
  vscode.postMessage({
    type: "editMessage",
    messageID: message.id,
    updates: { customFields: customFields },
  });
}

/**
 * Re-runs a single tool call with its current arguments, updating its result in
 * place. Unlike the automatic loop this never continues the conversation on its
 * own — it is a deliberate, contained action; the resulting staleness lets the
 * user decide whether to regenerate what follows.
 */
function _rerunToolCall(assistantMessage, call, statusLabel) {
  const message = flatMessages[assistantMessage.id] || assistantMessage;
  const entry = _findEnabledEntry(_enabledToolsAt(message.id), call.name);
  if (!entry) {
    if (statusLabel) {
      statusLabel.textContent = "Not enabled here";
    }
    return;
  }
  const requestID = "tool-" + Date.now() + "-" + _toolRequestCounter++;
  _pendingToolRequests[requestID] = { assistantID: message.id, call: call, rerun: true };
  _toolRuntime[call.id] = { requestID: requestID, assistantID: message.id, call: call, startedAt: Date.now(), status: "running", progress: null, elicit: null };
  _replaceToolBlock(call.id);
  _startToolTicker();
  vscode.postMessage({
    type: "executeTool",
    requestID: requestID,
    source: entry.source,
    server: entry.server,
    toolName: entry.name,
    arguments: call.arguments || {},
  });
}

/** Appends blocks for each tool call an assistant message emitted (if any). */
function _appendToolCallBlocks(messageContent, message) {
  const toolCalls = message.customFields && message.customFields.toolCalls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return;
  }
  for (const call of toolCalls) {
    messageContent.appendChild(_createToolCallBlock(call, message));
  }
  _appendToolOrchestrationBar(messageContent, message);
}

/**
 * Renders a tool-result node: the output fed back to the model for a tool call,
 * shown as its own card (distinct from a message bubble) so it stays visible and
 * editable rather than hidden runtime machinery.
 */
function _renderToolNode(messageNode, message, clipContent, editing) {
  const cf = message.customFields || {};
  const isError = Boolean(cf.isError);
  const stopped = Boolean(cf.stopped);
  const toolName = cf.toolName || "tool";

  const header = document.createElement("div");
  header.className = "tool-node-header";

  const icon = document.createElement("span");
  icon.className = "tool-node-icon" + (isError ? " tool-node-icon-error" : (stopped ? " tool-node-icon-stopped" : ""));
  icon.innerHTML = isError ? icons.ICON_TOOL_FAILED : (stopped ? icons.ICON_DASH_CIRCLE : icons.ICON_TOOL_SUCCESS);
  header.appendChild(icon);

  const name = document.createElement("span");
  name.className = "tool-node-name";
  name.textContent = toolName;
  header.appendChild(name);

  messageNode.appendChild(header);

  if (editing) {
    // Edit the result the same way a config node is edited: an inline editor
    // with Cancel/Done. A tool result is free-form text, so completion just
    // offers snippets (as message editing does). Saving marks downstream stale.
    const codeMirrorContainer = document.createElement("div");
    codeMirrorContainer.classList.add("codemirror-container");
    codeMirrorContainer.dataset.id = message.id;
    codeMirrorContainer.dataset.vscodeContext = JSON.stringify({ isEditor: true });
    messageNode.appendChild(codeMirrorContainer);

    const editor = _renderEditor(codeMirrorContainer, message.id, message.content || "", "Edit the tool result\u2026",
      (context) => {
        const before = context.matchBefore(/\/(\w*)|(\w+)/);
        if (!before) {
          return null;
        }
        const options = Object.entries(snippets).map(([completion, content]) => ({
          label: "/" + completion,
          apply: content,
          type: "text",
        }));
        return { from: before.from, options: options, validFor: /^(\/\w*|\w*)$/ };
      },
      (content) => {
        _handleMessageSubmit(content, message);
      });

    const operationBar = document.createElement("div");
    operationBar.classList.add("operation-bar");
    messageNode.appendChild(operationBar);

    // A left hint keeps the buttons right-aligned (the bar is space-between),
    // matching the config node's editing layout.
    const hint = document.createElement("div");
    hint.className = "validity-check";
    hint.textContent = "Editing tool result";
    operationBar.appendChild(hint);

    const buttonContainer = document.createElement("div");
    buttonContainer.classList.add("operation-group");
    operationBar.appendChild(buttonContainer);

    const cancelButtonElement = document.createElement("button");
    cancelButtonElement.className = "button";
    cancelButtonElement.textContent = "Cancel";
    cancelButtonElement.addEventListener("click", function () {
      messageNode.replaceWith(createMessageNode(message, false, false));
    });

    const saveButtonElement = document.createElement("button");
    saveButtonElement.className = "button primary";
    saveButtonElement.textContent = "Done";
    saveButtonElement.addEventListener("click", function () {
      _handleMessageSubmit(editor.state.doc.toString(), message);
    });

    buttonContainer.appendChild(cancelButtonElement);
    buttonContainer.appendChild(saveButtonElement);
    return;
  }

  const body = document.createElement("div");
  body.className = "tool-node-body markdown-content" + (isError ? " tool-node-body-error" : "");
  body.innerHTML = _renderMarkdown(message.content || "");
  messageNode.appendChild(body);
}

/**
 * Renders a '#tools' node: the set of tools enabled from this point onward,
 * shown as a quiet card (like a config card) so the .chat records exactly what
 * the model was offered.
 */
function _renderToolsNode(messageNode, message, clipContent, editing) {
  let enabled = [];
  try {
    const parsed = JSON.parse(message.content || "{}");
    if (Array.isArray(parsed.enabled)) {
      enabled = parsed.enabled;
    }
  } catch (e) {
    // Ignore a malformed tools node.
  }

  const header = document.createElement("div");
  header.className = "tools-card-header";
  const icon = document.createElement("span");
  icon.className = "tools-card-icon";
  icon.innerHTML = icons.ICON_TOOL;
  header.appendChild(icon);
  const title = document.createElement("span");
  title.className = "tools-card-title";
  title.textContent = enabled.length === 0 ? "No tools enabled" : "Tools \u00b7 " + enabled.length;
  header.appendChild(title);
  messageNode.appendChild(header);

  if (enabled.length > 0) {
    const list = document.createElement("div");
    list.className = "tools-card-list";
    for (const tool of enabled) {
      const item = document.createElement("div");
      item.className = "tools-card-item";

      const server = document.createElement("span");
      server.className = "tools-card-server";
      server.textContent = tool.server || tool.source || "";
      item.appendChild(server);

      const name = document.createElement("span");
      name.className = "tools-card-name";
      name.textContent = tool.name || tool.ref || "";
      item.appendChild(name);

      if (tool.readOnly) {
        const readonly = document.createElement("span");
        readonly.className = "tools-card-readonly";
        readonly.textContent = "read-only";
        item.appendChild(readonly);
      }
      list.appendChild(item);
    }
    messageNode.appendChild(list);
  }
}


// --- Tool-call orchestration ------------------------------------------------
// When an assistant turn asks to call tools, ICE (here in the webview) gates on
// approval, asks the host to execute each call, records each result as its own
// `tool` node, and then continues the conversation from there — a loop bounded
// by `_toolMaxAutoIterations` so it can never run away.

/** Sets a message's transient orchestration state and re-renders it. */
function _setToolState(messageID, state) {
  _toolOrchestration[messageID] = state;
  if (flatMessages[messageID]) {
    rerenderMessage(messageID);
  }
}

/** Clears a message's orchestration state (no re-render). */
function _clearToolState(messageID) {
  delete _toolOrchestration[messageID];
}

/** The tools enabled at a message: the nearest '#tools' node up its path. */
function _enabledToolsAt(messageID) {
  let enabled = [];
  for (const id of getPathWithMessage(messageID)) {
    const current = flatMessages[id];
    if (current && current.role === "#tools") {
      try {
        const parsed = JSON.parse(current.content || "{}");
        if (Array.isArray(parsed.enabled)) {
          enabled = parsed.enabled;
        }
      } catch (e) {
        // Ignore a malformed tools node.
      }
    }
    if (id === messageID) {
      break;
    }
  }
  return enabled;
}

/** Finds the enabled-tool entry a model-facing call name (`ref`) maps to. */
function _findEnabledEntry(enabled, ref) {
  return enabled.find((entry) => entry.ref === ref);
}

/** The deepest node in the tool-result chain hanging off an assistant turn. */
function _toolChainTail(assistantID) {
  let tail = assistantID;
  while (true) {
    const children = messageIDWithChildren[tail] || [];
    const toolChild = children
      .map((id) => flatMessages[id])
      .find((m) => m && m.role === "tool");
    if (!toolChild) {
      break;
    }
    tail = toolChild.id;
  }
  return tail;
}

/**
 * Decides what to do with an assistant turn that emitted tool calls: run them
 * automatically (when approval is bypassed or every pending call is read-only,
 * and the loop cap has not been reached), otherwise surface an approval or
 * "continue?" affordance. Calls already answered (e.g. after a reload) are left
 * untouched so re-opening a file never re-runs tools.
 */
function _maybeHandleToolCalls(message) {
  if (!message || message.role !== "assistant") {
    return;
  }
  const toolCalls = message.customFields && message.customFields.toolCalls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return;
  }
  const pending = toolCalls.filter((call) => !_findToolResult(call.id));
  if (pending.length === 0 || _toolOrchestration[message.id] === "running") {
    return;
  }

  const enabled = _enabledToolsAt(message.id);
  const allReadOnly = pending.every((call) => {
    const entry = _findEnabledEntry(enabled, call.name);
    return entry && entry.readOnly;
  });
  const needsApproval = !_toolAutoApprove && !allReadOnly;

  if (needsApproval) {
    _setToolState(message.id, "awaiting-approval");
    return;
  }
  if (_toolAutoRunCount >= _toolMaxAutoIterations) {
    _setToolState(message.id, "capped");
    return;
  }
  _runToolCalls(message, pending, enabled);
}

/** Requests execution of each pending tool call for an assistant turn. */
function _runToolCalls(message, pending, enabled) {
  _toolAutoRunCount++;
  for (const call of pending) {
    const entry = _findEnabledEntry(enabled, call.name);
    if (!entry) {
      // The tool is no longer enabled here; record an error result in its place.
      _upsertToolResult(message, call, true, `Tool "${call.name}" is not available.`);
      continue;
    }
    const requestID = "tool-" + Date.now() + "-" + _toolRequestCounter++;
    _pendingToolRequests[requestID] = { assistantID: message.id, call: call };
    _toolRuntime[call.id] = { requestID: requestID, assistantID: message.id, call: call, startedAt: Date.now(), status: "running", progress: null, elicit: null };
    vscode.postMessage({
      type: "executeTool",
      requestID: requestID,
      source: entry.source,
      server: entry.server,
      toolName: entry.name,
      arguments: call.arguments || {},
    });
  }
  _setToolState(message.id, "running");
  _startToolTicker();
  _maybeContinueAfterTools(message.id);
}

/** Handles a tool result from the host: records it, then maybe continues. */
function _handleToolResult(message) {
  const pending = _pendingToolRequests[message.requestID];
  if (!pending) {
    return;
  }
  delete _pendingToolRequests[message.requestID];
  delete _toolRuntime[pending.call.id];
  _stopToolTickerIfIdle();
  const assistant = flatMessages[pending.assistantID];
  if (!assistant) {
    return;
  }
  _upsertToolResult(assistant, pending.call, message.isError, message.text, { stopped: message.stopped, timedOut: message.timedOut });
  // A manual re-run is a contained action: it refreshes the result but never
  // drives the conversation forward on its own.
  if (!pending.rerun) {
    _maybeContinueAfterTools(pending.assistantID);
  }
}

/**
 * Records a tool call's result: updates the existing `tool` node in place when
 * one exists (a re-run), otherwise creates and persists a new node chained after
 * the assistant turn (the first run). `flags` marks a stopped / timed-out call so
 * it renders as a neutral user choice rather than an error.
 */
function _upsertToolResult(assistantMessage, call, isError, text, flags) {
  flags = flags || {};
  const buildFields = (base) => {
    const fields = { ...(base || {}), toolCallID: call.id, toolName: call.name, isError: Boolean(isError) };
    if (flags.stopped) { fields.stopped = true; } else { delete fields.stopped; }
    if (flags.timedOut) { fields.timedOut = true; } else { delete fields.timedOut; }
    return fields;
  };
  const existing = _findToolResult(call.id);
  if (existing) {
    existing.content = text || "";
    existing.customFields = buildFields(existing.customFields);
    existing.timestamp = new Date().toISOString();
    updateFlatMessages(existing);
    vscode.postMessage({
      type: "editMessage",
      messageID: existing.id,
      updates: { content: existing.content, customFields: existing.customFields },
    });
    renderConversation();
    return;
  }

  const node = {
    id: _freshID(),
    role: "tool",
    content: text || "",
    parentID: _toolChainTail(assistantMessage.id),
    timestamp: new Date().toISOString(),
    customFields: buildFields(null),
  };
  updateFlatMessages(node);
  addMessage(node);
  scanMessageTree();
  activePath = getPathWithMessage(node.id);
  renderConversation();
}

/**
 * Once every tool call for an assistant turn has a result (and nothing is still
 * executing), continues the conversation from the tool results so the model can
 * react — the auto-continue step of the loop.
 */
function _maybeContinueAfterTools(assistantID) {
  const assistant = flatMessages[assistantID];
  if (!assistant) {
    return;
  }
  const toolCalls = assistant.customFields && assistant.customFields.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return;
  }
  const allAnswered = toolCalls.every((call) => _findToolResult(call.id));
  const stillRunning = Object.values(_pendingToolRequests).some((req) => req.assistantID === assistantID);
  if (!allAnswered || stillRunning) {
    return;
  }

  // If the user stopped any call, don't drive the conversation forward on its
  // own; a Stop should feel like a stop. Offer an explicit Continue instead.
  const anyStopped = toolCalls.some((call) => {
    const result = _findToolResult(call.id);
    return result && result.customFields && result.customFields.stopped;
  });
  if (anyStopped) {
    _setToolState(assistantID, "stopped-continue");
    return;
  }

  _clearToolState(assistantID);
  const tail = flatMessages[_toolChainTail(assistantID)];
  if (tail) {
    sendMessage(tail, true);
  }
}

/** Renders the approval / continue affordance beneath tool calls. */
function _appendToolOrchestrationBar(messageContent, message) {
  const state = _toolOrchestration[message.id];
  if (!state) {
    return;
  }
  // A running turn now shows progress and Stop per call; no aggregate bar.
  if (state === "running") {
    return;
  }

  const toolCalls = (message.customFields && message.customFields.toolCalls) || [];

  // After the user stopped a call, offer an explicit Continue rather than
  // auto-continuing, so a Stop genuinely stops.
  if (state === "stopped-continue") {
    const bar = document.createElement("div");
    bar.className = "tool-approval-bar";
    const label = document.createElement("span");
    label.className = "tool-approval-label";
    label.textContent = "Stopped.";
    bar.appendChild(label);
    bar.appendChild(_toolBarButton("Continue", "primary", () => {
      _toolAutoRunCount = 0;
      _clearToolState(message.id);
      const tail = flatMessages[_toolChainTail(message.id)];
      if (tail) {
        sendMessage(tail, true);
      }
    }));
    bar.appendChild(_toolBarButton("Leave", "", () => {
      _clearToolState(message.id);
      rerenderMessage(message.id);
    }));
    messageContent.appendChild(bar);
    return;
  }

  const pending = toolCalls.filter((call) => !_findToolResult(call.id));
  if (pending.length === 0) {
    return;
  }

  const bar = document.createElement("div");
  bar.className = "tool-approval-bar";

  const label = document.createElement("span");
  label.className = "tool-approval-label";
  bar.appendChild(label);

  if (state === "capped") {
    label.textContent = "Paused after " + _toolMaxAutoIterations + " automatic tool rounds.";
    bar.appendChild(_toolBarButton("Continue", "primary", () => {
      _toolAutoRunCount = 0;
      _runToolCalls(message, pending, _enabledToolsAt(message.id));
    }));
    messageContent.appendChild(bar);
    return;
  }

  // awaiting-approval
  label.textContent = "Run " + pending.length + " tool call" + (pending.length > 1 ? "s" : "") + "?";
  bar.appendChild(_toolBarButton("Approve", "primary", () => {
    _runToolCalls(message, pending, _enabledToolsAt(message.id));
  }));
  bar.appendChild(_toolBarButton("Skip", "", () => {
    _clearToolState(message.id);
    rerenderMessage(message.id);
  }));
  messageContent.appendChild(bar);
}

/** Builds a small button for the tool approval bar. */
function _toolBarButton(text, variant, onClick) {
  const button = document.createElement("button");
  button.className = "tool-approval-button" + (variant ? " " + variant : "");
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Inserts (or updates) a '#tools' node holding the enabled tool set at the
 * current point in the conversation. Applies downward like a config node, so it
 * records exactly which tools the model is offered from here on.
 */
function _insertToolsNode(enabled) {
  const content = JSON.stringify({ enabled: enabled || [] });
  const lastMessage = activePath.length > 0 ? flatMessages[activePath[activePath.length - 1]] : null;

  if (lastMessage && lastMessage.role === "#tools") {
    // Replace the most recent tools node rather than stacking a duplicate.
    vscode.postMessage({ type: "editMessage", messageID: lastMessage.id, updates: { content } });
    lastMessage.content = content;
    updateFlatMessages(lastMessage);
    scanMessageTree();
    rerenderMessage(lastMessage.id);
    return;
  }

  const node = {
    id: _freshID(),
    role: "#tools",
    content: content,
    parentID: lastMessage ? lastMessage.id : null,
    timestamp: new Date().toISOString(),
  };
  updateFlatMessages(node);
  addMessage(node);
  scanMessageTree();
  activePath = getPathWithMessage(node.id);
  renderConversation();
}


/**
 * Renders the header of the conversation tree.
 * @param {HTMLElement} messageNode - The container node for the header.
 * @param {Object} message - The header message object to render.
 */
function _renderHeader(messageNode, message) {
  const contentObj = JSON.parse(message.content);
  const createdDate = new Date(contentObj.createdAt);
  const createdDateString = createdDate.toLocaleString();

  const creationDateElement = document.createElement("span");
  creationDateElement.classList.add("creation-date");
  creationDateElement.textContent = createdDateString;
  creationDateElement.title = "Created at " + createdDateString;
  messageNode.appendChild(creationDateElement);
}


/**
 * Creates a message node for rendering in the conversation.
 * @param {Object} message - The message object to create a node for.
 * @param {boolean} clipContent - Whether to clip the content of the message.
 * @param {boolean} editing - Whether the message is being edited.
 * @returns {HTMLElement} The created message node.
 */
function createMessageNode(message, clipContent = false, editing = false) {
  const messageNode = document.createElement("div");
  messageNode.dataset.id = message.id;
  messageNode.dataset.vscodeContext = JSON.stringify({
    webviewSection: "messageNode",
    messageRole: message.role
  });

  switch (message.role) {
    case "#config":
      messageNode.classList.add("config-content");
      _renderConfigNode(messageNode, message, clipContent, editing);
      break;
    case "#head":
      messageNode.classList.add("header-content");
      _renderHeader(messageNode, message);
      break;
    case "tool":
      messageNode.classList.add("tool-content");
      _renderToolNode(messageNode, message, clipContent, editing);
      break;
    case "#tools":
      messageNode.classList.add("tools-content");
      _renderToolsNode(messageNode, message, clipContent, editing);
      break;
    default:
      messageNode.classList.add("message-node");
      _renderBubbleMessage(messageNode, message, clipContent, editing);
  }

  return messageNode;
}


/**
 * Renders sibling messages of a given message.
 * @param {Object} message - The message object to render siblings for.
 * @returns {HTMLElement} The container element with rendered sibling messages.
 */
function renderSiblingMessagesOf(message) {
  const shadowSiblingMessageContainer = document.createElement("div");

  if (message.parentID !== null) {
    shadowSiblingMessageContainer.classList.add("shadow-message-container");
    if (message.role === "user") {
      shadowSiblingMessageContainer.classList.add("user");
    }
    const siblings = messageIDWithChildren[message.parentID];
    if (siblings && siblings.length > 1) {
      for (const siblingID of siblings) {
        if (siblingID !== message.id) {
          const siblingMessage = flatMessages[siblingID];
          const siblingMessageNode = createMessageNode(siblingMessage, true, false);
          siblingMessageNode.onclick = () => {
            activePath = getPathWithMessage(siblingID);
            renderConversation();
            shadowSiblingMessageContainer.remove();
          };
          // Hovering a version previews that branch's continuation (its
          // descendant sub-tree) in place of the current downstream messages,
          // without shifting the page. See _showBranchPreview.
          siblingMessageNode.addEventListener("pointerenter", () => {
            _showBranchPreview(message, siblingID);
          });
          shadowSiblingMessageContainer.appendChild(siblingMessageNode);
        }
      }
      // Leaving the strip entirely ends the preview; moving between versions
      // (staying inside the strip) keeps it up.
      shadowSiblingMessageContainer.addEventListener("pointerleave", () => {
        _scheduleBranchPreviewHide();
      });
    }
  }

  return shadowSiblingMessageContainer;
}


// --- Branch hover preview --------------------------------------------------
// When the Branches strip is expanded, hovering a sibling version previews that
// branch's continuation (its descendant sub-tree) laid out exactly over the
// current downstream region. The real messages stay in flow (just faded) so they
// hold the box open -> swapping versions never changes the page height and the
// viewport stays put. (Reuses the repo's "overlay-keeps-box" trick.)
let _branchPreview = null; // { overlay, sources, branchPointID, hoveredID, hideTimer }

function _branchPreviewMotionMs() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200;
}

/** Real downstream message containers: the active path after the branch point. */
function _downstreamContainersOf(branchPointID) {
  const index = activePath.indexOf(branchPointID);
  if (index === -1) {
    return [];
  }
  const containers = [];
  for (const id of activePath.slice(index + 1)) {
    const node = conversationContainer.querySelector(
      `.message-container[data-id="${id}"]`
    );
    if (node) {
      containers.push(node);
    }
  }
  return containers;
}

/** Fills the overlay with the hovered version's descendant sub-tree. */
function _fillBranchPreview(overlay, hoveredSiblingID) {
  overlay.innerHTML = "";
  const path = getPathWithMessage(hoveredSiblingID);
  const startIndex = path.indexOf(hoveredSiblingID) + 1;
  for (const id of path.slice(startIndex)) {
    const previewMessage = flatMessages[id];
    if (previewMessage) {
      overlay.appendChild(createMessageContainer(previewMessage, false, false));
    }
  }
  // Mask the bottom when the branch is taller than the reserved box.
  overlay.classList.toggle("clipped", overlay.scrollHeight > overlay.clientHeight + 1);
}

/** Gracefully fades the preview back to the current branch (used on strip exit). */
function _scheduleBranchPreviewHide() {
  if (!_branchPreview) {
    return;
  }
  if (_branchPreview.hideTimer) {
    clearTimeout(_branchPreview.hideTimer);
  }
  _branchPreview.overlay.classList.remove("visible");
  _branchPreview.sources.forEach((n) => n.classList.remove("branch-preview-source-hidden"));
  _branchPreview.hideTimer = setTimeout(
    () => _teardownBranchPreview(),
    _branchPreviewMotionMs()
  );
}

/** Immediately removes any preview overlay and restores the real messages. */
function _teardownBranchPreview() {
  if (!_branchPreview) {
    return;
  }
  const { overlay, sources, hideTimer } = _branchPreview;
  if (hideTimer) {
    clearTimeout(hideTimer);
  }
  sources.forEach((n) => n.classList.remove("branch-preview-source-hidden"));
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
  _branchPreview = null;
}

function _showBranchPreview(branchPointMessage, hoveredSiblingID) {
  const branchPointID = branchPointMessage.id;

  // Re-hovering the version already shown: just cancel any pending fade-out.
  if (
    _branchPreview &&
    _branchPreview.branchPointID === branchPointID &&
    _branchPreview.hoveredID === hoveredSiblingID
  ) {
    if (_branchPreview.hideTimer) {
      clearTimeout(_branchPreview.hideTimer);
      _branchPreview.hideTimer = null;
    }
    return;
  }

  // Switching versions within the same strip: swap content in the same box so
  // the reserved region (and thus the page height) never changes.
  if (_branchPreview && _branchPreview.branchPointID === branchPointID) {
    if (_branchPreview.hideTimer) {
      clearTimeout(_branchPreview.hideTimer);
      _branchPreview.hideTimer = null;
    }
    _branchPreview.hoveredID = hoveredSiblingID;
    _fillBranchPreview(_branchPreview.overlay, hoveredSiblingID);
    _branchPreview.overlay.classList.add("visible");
    _branchPreview.sources.forEach((n) => n.classList.add("branch-preview-source-hidden"));
    return;
  }

  // Fresh preview for a different branch point.
  _teardownBranchPreview();

  const sources = _downstreamContainersOf(branchPointID);
  if (sources.length === 0) {
    // No downstream region to reserve -> previewing would move the page, so skip.
    return;
  }

  const containerRect = conversationContainer.getBoundingClientRect();
  const firstRect = sources[0].getBoundingClientRect();
  const lastRect = sources[sources.length - 1].getBoundingClientRect();

  const overlay = document.createElement("div");
  overlay.className = "branch-preview-layer";
  overlay.style.top = `${firstRect.top - containerRect.top}px`;
  overlay.style.height = `${lastRect.bottom - firstRect.top}px`;
  conversationContainer.appendChild(overlay);

  _fillBranchPreview(overlay, hoveredSiblingID);
  sources.forEach((n) => n.classList.add("branch-preview-source-hidden"));

  _branchPreview = {
    overlay,
    sources,
    branchPointID,
    hoveredID: hoveredSiblingID,
    hideTimer: null,
  };

  // Fade in on the next frame so the opacity transition actually runs.
  requestAnimationFrame(() => {
    if (_branchPreview && _branchPreview.overlay === overlay) {
      overlay.classList.add("visible");
    }
  });
}


/**
 * Creates a container for a message in the conversation.
 * @param {Object} message - The message object to create a container for.
 * @param {boolean} editing - Whether the message is being edited.
 * @param {boolean} shouldAnimate - Whether the message should be animated when added.
 * @returns {HTMLElement} The created message container.
 */
function createMessageContainer(message, editing = false, shouldAnimate = false) {
  const messageContainer = document.createElement("div");
  messageContainer.classList.add("message-container");
  messageContainer.classList.add(message.role === "user" || message.role === "assistant" ? "bubble" : "card");
  messageContainer.classList.add(message.role);
  messageContainer.dataset.id = message.id;
  const messageNodesContainer = document.createElement("div");
  messageNodesContainer.classList.add("message-nodes-container");
  messageContainer.appendChild(messageNodesContainer);

  if (shouldAnimate) {
    messageContainer.classList.add("animated");
  } else {
    messageContainer.classList.add("static");
  }

  const messageNode = createMessageNode(message, false, editing);
  messageNodesContainer.appendChild(messageNode);

  // Selection affordance: a hover-revealed checkbox sitting just off the inner
  // edge of the bubble (right of assistant, left of user). Only real, selectable
  // messages get one (not the internal head, not the unsent draft).
  const selectable = message.role !== "#head" && !message.isShadow && flatMessages[message.id] !== undefined;
  if (selectable) {
    const check = document.createElement("button");
    check.className = "selection-check";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", "false");
    check.setAttribute("aria-label", "Select message");
    check.innerHTML = icons.ICON_CHECK_LG;
    // Don't let a checkbox press start a rubber-band or text selection.
    check.addEventListener("mousedown", (event) => event.stopPropagation());
    check.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = String(message.id);
      if (event.shiftKey && selectionAnchorID !== null) {
        _selectRange(selectionAnchorID, id, true);
      } else {
        _toggleMessageSelection(id);
      }
    });
    messageNodesContainer.appendChild(check);

    // Modifier-click accelerators that never interfere with plain text
    // selection: Cmd/Ctrl-click toggles, Shift-click extends a range (only once
    // a selection already exists, so Shift-click still extends text otherwise).
    messageContainer.addEventListener("click", (event) => {
      if (event.target.closest(".selection-check, .cm-editor, a, button")) {
        return;
      }
      const id = String(message.id);
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        _toggleMessageSelection(id);
      } else if (event.shiftKey && selectedMessageIDs.size > 0 && selectionAnchorID !== null) {
        event.preventDefault();
        const selection = window.getSelection && window.getSelection();
        if (selection && selection.removeAllRanges) {
          selection.removeAllRanges();
        }
        _selectRange(selectionAnchorID, id, false);
      }
    });
  }

  if (message.parentID) {
    const siblings = messageIDWithChildren[message.parentID];
    if (siblings && siblings.length > 1) {
      // If there are siblings (i.e. more than 1 child of the same parent)
      const siblingSwitcher = document.createElement("div");
      messageNodesContainer.appendChild(siblingSwitcher);

      siblingSwitcher.classList.add("sibling-switcher", "inactive");
      siblingSwitcher.textContent = "Branches";
      siblingSwitcher.onclick = () => {
        if (siblingSwitcher.classList.contains("inactive")) {
          siblingSwitcher.classList.remove("inactive");
          siblingSwitcher.classList.add("active");
          siblingSwitcher.textContent = "Collapse Branches";
          const shadowSiblingMessageContainer =
            renderSiblingMessagesOf(message);
          siblingSwitcher.insertAdjacentElement(
            "beforebegin",
            shadowSiblingMessageContainer
          );
        } else {
          _teardownBranchPreview();
          siblingSwitcher.classList.remove("active");
          siblingSwitcher.classList.add("inactive");
          siblingSwitcher.textContent = "Branches";
          messageContainer
            .querySelector(".shadow-message-container")
            .remove();
        }

        // Update marks
        _updateRulerMarks();
      };
    }
  }

  // Assistant replies carry a quiet metadata caption (model + short time, with
  // details on hover). It is appended last so the message node stays the
  // node-container's firstElementChild (delete/preview logic relies on that),
  // and CSS floats it just above the bubble — outside the message.
  if (message.role === "assistant" && !message.isShadow) {
    messageNodesContainer.appendChild(_createMessageMetaHeader(message));
  }

  return messageContainer;
}


/**
 * Re-renders a specific message in the conversation.
 * @param {string} messageID - The ID of the message to re-render.
 * @param {boolean} editing - Whether the message should be rendered in editing mode.
 */
function rerenderMessage(messageID, editing = false) {
  const message = flatMessages[messageID];
  const messageContainer = createMessageContainer(message, editing);
  const oldMessageContainer = document.querySelector(
    `.message-container[data-id="${messageID}"]`
  );
  oldMessageContainer.replaceWith(messageContainer);
}


/**
 * Renders an input shadow message (a message that is being edited but not yet submitted) for user input.
 * @param {string|null} parentMessageID - The ID of the parent message, if any.
 */
function _renderInputShadowMessage(parentMessageID) {
  const emptyUserMessage = {
    id: Date.now(),
    isShadow: true,
    role: "user",
    content: "",
    parentID: parentMessageID,
    timestamp: new Date().toISOString(),
  };
  const messageContainer = createMessageContainer(emptyUserMessage, true);
  conversationContainer.appendChild(messageContainer);

  if (currentProvider) { // Do not focus if there is no provider selected, because this dismisses the VSCode's quick pick menu
    focusMessageInput(emptyUserMessage.id);
  }
}


/**
 * Updates the ruler marks for configs and branches in the conversation.
 */
function _updateRulerMarks() {
  ruler.clear();

  if (conversationContainer.scrollHeight <= window.innerHeight) {
    // If the conversation fits in the viewport, no need to show the ruler
    return;
  }

  const forkNodes = document.querySelectorAll(".sibling-switcher");
  forkNodes.forEach(node => {
    ruler.addMark(node);
  });

  const configNodes = document.querySelectorAll(".config-content");
  configNodes.forEach(node => {
    ruler.addMark(node, "config");
  });
}

// --- Context checksum & staleness ------------------------------------------
// Each assistant reply stores (in customFields.metadata.contextChecksum) a hash
// of the exact conversation context it was generated from: the message trail
// sent to the model, minus the system prompt (which lives in config and carries
// volatile built-in variables like {{ DATE_TODAY }}). The webview owns this hash
// on both ends — it is computed when a message is sent (see sendMessage) and
// recomputed at render time — so the two can never disagree by construction. A
// reply is "stale" when its context no longer hashes to the stored value, i.e.
// an earlier message was edited after the reply was generated.
const _FNV_OFFSET = 0x811c9dc5;
const _FNV_PRIME = 0x01000193;

/** Folds a string into a running 32-bit FNV-1a hash (Math.imul => identical in every JS engine). */
function _fnv1aFold(hash, str) {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, _FNV_PRIME);
  }
  return hash;
}

/** Canonical, order-sensitive fragment for one message (role + content + attachment identities). */
function _messageChecksumFragment(message) {
  const attachments = (message.attachments || [])
    .map((a) => a.name + "\x1f" + a.url)
    .join("\x1d");
  return message.role + "\x00" + (message.content || "") + "\x00" + attachments + "\x1e";
}

/** Hex FNV-1a of an ordered list of context messages (meta roles skipped). */
function _computeContextChecksum(messages) {
  let hash = _FNV_OFFSET;
  for (const message of messages) {
    if (!message || message.role.startsWith("#")) {
      continue;
    }
    hash = _fnv1aFold(hash, _messageChecksumFragment(message));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Recomputes which assistant replies are "stale" — their upstream context was
 * edited after the reply was generated, so the reply may no longer reflect it.
 *
 * Primary signal is the stored context checksum. Because `activePath` is a single
 * root->leaf chain, a rolling FNV-1a hash of the non-meta messages seen so far
 * *is* each node's context hash, so one O(n) pass detects every mismatch. Replies
 * saved before this feature lack a checksum; those fall back to the timestamp
 * heuristic (an ancestor stamped later than the reply). Derived only — nothing
 * about staleness is written to the .chat file.
 */
function _computeStaleMessages() {
  const stale = new Set();
  let hash = _FNV_OFFSET;          // rolling hash of the non-meta context seen so far
  let maxAncestorTime = -Infinity; // fallback for checksum-less replies
  for (const id of activePath) {
    const message = flatMessages[id];
    if (!message) {
      continue;
    }
    const time = Date.parse(message.timestamp) || 0;
    if (message.role === "assistant") {
      const stored = message.customFields && message.customFields.metadata && message.customFields.metadata.contextChecksum;
      if (stored) {
        if ((hash >>> 0).toString(16).padStart(8, "0") !== stored) {
          stale.add(message.id);
        }
      } else if (maxAncestorTime > time) {
        stale.add(message.id);
      }
    }
    if (!message.role.startsWith("#")) {
      hash = _fnv1aFold(hash, _messageChecksumFragment(message));
    }
    if (time > maxAncestorTime) {
      maxAncestorTime = time;
    }
  }
  _staleMessageIDs = stale;
}

/**
 * Renders the entire conversation.
 * @param {boolean} shouldAnimateLastMessage - Whether to animate the last message when rendering.
 */
function renderConversation(shouldAnimateLastMessage = false) {
  _teardownBranchPreview();
  _computeStaleMessages();
  conversationContainer.innerHTML = "";
  // Render messages in the active path
  activePath.forEach((messageID) => {
    const message = flatMessages[messageID];
    const messageContainer = createMessageContainer(message, false, shouldAnimateLastMessage && messageID === activePath[activePath.length - 1]);
    conversationContainer.appendChild(messageContainer);
  });

  if (activePath.length > 0) {
    const lastMessage = flatMessages[activePath[activePath.length - 1]];
    if (lastMessage.role === "user") {
      // If the last message is a user message, re-render it in editing mode
      rerenderMessage(lastMessage.id, true);

      focusMessageInput(lastMessage.id);
    } else {
      // If the last message is not a user message, render an empty user message in editing mode
      _renderInputShadowMessage(lastMessage.id);
    }
  } else {
    // If there is no active path, render an empty user message
    _renderInputShadowMessage(null);
  }

  // Update branch marks
  _updateRulerMarks();

  // Surface non-blocking interleave suggestions and re-apply the selection.
  _renderInterleaveGhosts();
  _updateSelectionUI();

  // Re-place any pending "provider defaults changed" notice for this conversation.
  _renderConfigSyncNotice();
}


/**
 * Focuses the input of a specific message.
 * @param {string} messageID - The ID of the message to focus.
 */
function focusMessageInput(messageID) {
  const messageNode = document.querySelector(
    `.message-container[data-id="${messageID}"]`
  );
  if (messageNode) {
    const codeMirrorContainer = EditorView.findFromDOM(messageNode);
    if (codeMirrorContainer) {
      codeMirrorContainer.focus();
    }
  }
}


/**
 * Handles loading actions for the conversation.
 * @param {Array} actions - The actions to load.
 * @param {boolean} append - Whether to append the actions or replace existing ones.
 */
function handleLoadActions(actions, append = false) {
  if (!append) {
    // Clear the messages if not appending
    flatMessages = {};
  }

  actions.forEach((action) => {
    if (action.action === "Add") {
      updateFlatMessages(action);
    } else if (action.action === "Edit") {
      const message = flatMessages[action.id];
      updateFlatMessages({
        ...message,
        ...action
      });
    } else if (action.action === "Delete") {
      delete flatMessages[action.id];
    }
  });
  scanMessageTree();
  const lastMessage = getLastMessage();
  if (lastMessage) {
    activePath = getPathWithMessage(lastMessage.id);

    // Update provider
    const config = getMessageConfig(lastMessage.id);
    selectProvider(config.Provider);
  }
  renderConversation();
  console.log("activePath", activePath);
}


/**
 * Inserts a configuration update message into the conversation.
 * @param {string} parentID - The ID of the parent message.
 * @param {string|null} nextID - The ID of the next message.
 * @param {Object} content - The content of the configuration update.
 * @returns {string} The ID of the newly created configuration message.
 */
function insertConfigUpdate(parentID, nextID, content = {}) {
  const id = Date.now();
  const configMessage = {
    id: id,
    role: "#config",
    content: JSON.stringify(content),
    parentID: parentID,
    timestamp: new Date().toISOString(),
  };
  updateFlatMessages(configMessage);
  addMessage(configMessage);
  if (nextID) {
    flatMessages[nextID].parentID = id;
    updateFlatMessages(flatMessages[nextID]);
    vscode.postMessage({
      type: "editMessage",
      messageID: nextID,
      updates: {
        parentID: id,
      },
    });
  }
  return id;
}


/**
 * Handles updating the configuration in the conversation.
 * @param {Object} config - The new configuration to update.
 */
function handleUpdateConfig(config) {
  const lastMessage = activePath.length > 0 ? flatMessages[activePath[activePath.length - 1]] : null;
  if (lastMessage && lastMessage.role === "#config") { // If the last message is a config
    // Check if there are any changes
    const lastConfig = JSON.parse(lastMessage.content);
    let changed = false;
    for (let key in config) {
      if (config[key] !== lastConfig[key]) {
        changed = true;
        break;
      }
    }

    let newConfig = JSON.stringify({
      ...lastConfig,
      ...config
    });

    if (changed) {
      vscode.postMessage({
        type: "editMessage",
        messageID: lastMessage.id,
        updates: {
          content: newConfig,
        },
      });
    } else {
      return;
    }

    // Update the flat messages
    lastMessage.content = newConfig;
    updateFlatMessages(lastMessage);
    scanMessageTree();
    rerenderMessage(lastMessage.id);
  } else { // Create a new config message
    const configMessageID = insertConfigUpdate(lastMessage ? lastMessage.id : null, null, config);

    scanMessageTree();
    activePath = getPathWithMessage(configMessageID);
    renderConversation();
  }
}


/**
 * Adopts a provider for the conversation by snapshotting its resolved non-secret
 * defaults into a #config node at the current point. This is what keeps a .chat
 * file self-contained: once adopted, the conversation carries its own model,
 * temperature, system prompt, etc., so editing a *global* default later never
 * retroactively changes this (or any past) conversation. Secrets are never
 * snapshotted — they stay in the host's secret storage, referenced by provider id.
 *
 * Adopting a new or different provider captures its full default set; re-adopting
 * the same provider only fills keys the conversation doesn't already govern, so a
 * value the user has explicitly set is never clobbered.
 *
 * @param {string} providerID - The ID of the provider being adopted.
 */
function _adoptProvider(providerID) {
  if (!providerID) {
    return;
  }
  // Defaults ride along with the provider's config payload; wait for it so the
  // snapshot reflects the provider's real values rather than an empty set.
  _ensureProviderConfig(providerID, () => {
    const defaults = providerDefaults[providerID] || {};
    const leafID = activePath.length > 0 ? activePath[activePath.length - 1] : null;
    const inherited = leafID != null ? getMessageConfig(leafID) : {};
    const providerChanged = inherited.Provider !== providerID;

    const snapshot = { Provider: providerID };
    for (const key in defaults) {
      const value = defaults[key];
      if (value === undefined || value === null || value === "") {
        continue;
      }
      if (providerChanged || inherited[key] === undefined) {
        snapshot[key] = value;
      }
    }
    handleUpdateConfig(snapshot);
  });
}


// --- Provider defaults "sync into conversation" notice ---------------------
// Editing a provider's *global* defaults (via the config menu) does not touch an
// open conversation, whose config lives in its own #config nodes; that is what
// keeps .chat files self-contained. To bridge the two without either silently
// winning, a global change surfaces a quiet notice at the end of the conversation
// offering to apply the change here; applying materialises a #config node so the
// change becomes a visible, trackable, forkable part of this conversation.

/**
 * Handles a "provider defaults changed" signal from the host. Remembers the offer
 * and renders (or clears) the notice.
 * @param {string} providerID
 * @param {Object} changes Map of changed config key -> new value.
 */
function _handleGlobalConfigChanged(providerID, changes) {
  _pendingConfigSync = changes && Object.keys(changes).length > 0 ? { providerID, changes } : null;
  _renderConfigSyncNotice();
}

/**
 * The subset of the pending change that actually differs from what this
 * conversation already uses, or null when there is nothing worth offering (no
 * pending change, a different provider, or the values already match). Recomputed
 * on demand so the notice stays honest as the conversation changes.
 * @returns {Object|null}
 */
function _applicableConfigSyncChanges() {
  if (!_pendingConfigSync) {
    return null;
  }
  const { providerID, changes } = _pendingConfigSync;
  const leafID = activePath.length > 0 ? activePath[activePath.length - 1] : null;
  const effective = leafID != null ? getMessageConfig(leafID) : {};
  const conversationProvider = effective.Provider || currentProvider;
  if (conversationProvider !== providerID) {
    // The change is for a provider this conversation isn't using, so it is irrelevant here.
    return null;
  }
  const applicable = {};
  for (const key in changes) {
    if (key === "Provider") {
      continue;
    }
    const current = effective[key] == null ? "" : String(effective[key]);
    if (String(changes[key]) !== current) {
      applicable[key] = changes[key];
    }
  }
  return Object.keys(applicable).length > 0 ? applicable : null;
}

/** Renders the sync notice before the current editing message, or removes it. */
function _renderConfigSyncNotice() {
  const existing = document.getElementById("config-sync-notice");
  if (existing) {
    existing.remove();
  }
  const applicable = _applicableConfigSyncChanges();
  if (!applicable) {
    _pendingConfigSync = null;
    return;
  }
  const notice = _createConfigSyncNotice(applicable);
  // Sit just before the current editing message (the last message container),
  // matching where an applied #config node would be inserted.
  const containers = conversationContainer.querySelectorAll(":scope > .message-container");
  const anchor = containers.length > 0 ? containers[containers.length - 1] : null;
  if (anchor) {
    conversationContainer.insertBefore(notice, anchor);
  } else {
    conversationContainer.appendChild(notice);
  }
}

/**
 * Builds the notice element: a slider icon, a summary of the changed keys, and
 * Apply / Dismiss actions. Deliberately quiet so it informs without nagging.
 * @param {Object} changes The applicable change map.
 * @returns {HTMLElement}
 */
function _createConfigSyncNotice(changes) {
  const el = document.createElement("div");
  el.id = "config-sync-notice";
  el.className = "config-sync-notice";

  const icon = document.createElement("span");
  icon.className = "config-sync-icon";
  icon.innerHTML = icons.ICON_SLIDERS;
  el.appendChild(icon);

  const body = document.createElement("div");
  body.className = "config-sync-body";

  const title = document.createElement("div");
  title.className = "config-sync-title";
  title.textContent = "Provider defaults changed";
  body.appendChild(title);

  const detail = document.createElement("div");
  detail.className = "config-sync-detail";
  detail.textContent = `${Object.keys(changes).join(", ")}. Apply to this conversation?`;
  body.appendChild(detail);

  el.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "config-sync-actions";

  const dismissButton = document.createElement("button");
  dismissButton.className = "config-sync-button";
  dismissButton.textContent = "Dismiss";
  dismissButton.addEventListener("click", _dismissConfigSync);
  actions.appendChild(dismissButton);

  const applyButton = document.createElement("button");
  applyButton.className = "config-sync-button primary";
  applyButton.textContent = "Apply";
  applyButton.addEventListener("click", _applyConfigSync);
  actions.appendChild(applyButton);

  el.appendChild(actions);
  return el;
}

/**
 * Applies the pending change by inserting a #config node at the current point
 * (as one undo step), preserving any in-progress composer draft across the
 * re-render that the insertion triggers.
 */
function _applyConfigSync() {
  const applicable = _applicableConfigSyncChanges();
  _pendingConfigSync = null;
  const existing = document.getElementById("config-sync-notice");
  if (existing) {
    existing.remove();
  }
  if (!applicable) {
    return;
  }
  const draft = _captureComposerDraft();
  _asUndoTransaction(() => {
    handleUpdateConfig({ ...applicable });
  });
  _restoreComposerDraft(draft);
}

/** Dismisses the pending change without touching the conversation. */
function _dismissConfigSync() {
  _pendingConfigSync = null;
  const existing = document.getElementById("config-sync-notice");
  if (existing) {
    existing.remove();
  }
}

/** Reads the current composer draft text (the last editable message), if any. */
function _captureComposerDraft() {
  const containers = conversationContainer.querySelectorAll(":scope > .message-container");
  const last = containers.length > 0 ? containers[containers.length - 1] : null;
  if (!last) {
    return null;
  }
  const view = EditorView.findFromDOM(last);
  return view ? view.state.doc.toString() : null;
}

/** Restores a previously-captured composer draft into the current composer. */
function _restoreComposerDraft(text) {
  if (!text) {
    return;
  }
  const containers = conversationContainer.querySelectorAll(":scope > .message-container");
  const last = containers.length > 0 ? containers[containers.length - 1] : null;
  if (!last) {
    return;
  }
  const view = EditorView.findFromDOM(last);
  if (view) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    view.focus();
  }
}


/**
 * Gets the last message in the conversation.
 * @returns {Object} The last message object.
 */
function getLastMessage() {
  const lastMessage = Object.values(flatMessages).reduce(
    (lastMsg, msg) => {
      const lastMsgDate = new Date(lastMsg.timestamp);
      const msgDate = new Date(msg.timestamp);
      return msgDate > lastMsgDate ? msg : lastMsg;
    }, {
      timestamp: "0"
    }
  );
  return lastMessage;
}


/**
 * Handles updating a message in the conversation.
 * @param {Object} message - The message object to update.
 * @param {boolean} incomplete - Whether the message is incomplete.
 */
function handleUpdateMessage(message, incomplete = false) {
  message.incomplete = incomplete;
  updateFlatMessages(message);
  scanMessageTree();

  // If the message is not in the active path, update the active path
  if (!activePath.find((id) => id === message.id)) {
    activePath = getPathWithMessage(message.id);
    renderConversation(true);
  } else {
    // While streaming, patch the message in place instead of rebuilding the
    // whole container on every token. Falls back to a full re-render for the
    // final frame or whenever a structural change is required.
    if (incomplete && streamingRenderer.updateStreamingMessage(message)) {
      return;
    }
    rerenderMessage(message.id);
  }
  // Keep the "Thinking" typewriter running whenever a thinking label is shown.
  thinkingAnimator.ensureRunning();
}


/**
 * Shows a lightweight inline delete confirmation. The message content stays
 * visible (recognition over recall — the user can still see what they are about
 * to delete); a short prompt with Delete / Cancel actions is appended beneath
 * it. Cancelling just removes the prompt, and deletion is undoable, so the
 * confirmation stays deliberately light.
 * @param {string} messageID - The ID of the message to confirm deletion for.
 */
function showDeleteConfirmation(messageID) {
  const container = document.querySelector(
    `.message-container[data-id="${messageID}"]`
  );
  if (!container) {
    return;
  }
  const nodesContainer = container.querySelector(".message-nodes-container");
  const node = nodesContainer && nodesContainer.firstElementChild;
  if (!node) {
    return;
  }
  // Append inside the bubble content, or the config node itself.
  const surface = node.classList.contains("message-node") ?
    node.querySelector(".message-content") : node;
  if (!surface) {
    return;
  }
  // Don't stack a second confirmation if one is already showing.
  if (surface.querySelector(":scope > .delete-confirmation")) {
    return;
  }

  const confirmation = document.createElement("div");
  confirmation.className = "delete-confirmation";

  const label = document.createElement("span");
  label.className = "delete-confirmation-label";
  label.textContent = "Delete this message?";
  confirmation.appendChild(label);

  const actions = document.createElement("div");
  actions.className = "delete-confirmation-actions";

  const confirmButton = document.createElement("button");
  confirmButton.className = "delete-confirmation-button confirm";
  confirmButton.textContent = "Delete";
  confirmButton.addEventListener("click", function () {
    deleteMessage(messageID);
  });

  const cancelButton = document.createElement("button");
  cancelButton.className = "delete-confirmation-button cancel";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", function () {
    confirmation.remove();
  });

  actions.appendChild(confirmButton);
  actions.appendChild(cancelButton);
  confirmation.appendChild(actions);

  // Keep the original message visible and append the prompt beneath it.
  surface.appendChild(confirmation);

  // The prompt can sit below the fold on a long message — bring it into view
  // (and the entrance animation draws the eye) so the user notices it appear.
  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  confirmation.scrollIntoView({
    block: "nearest",
    behavior: reduceMotion ? "auto" : "smooth",
  });
}


/**
 * Deletes a message from the conversation.
 * @param {string} messageID - The ID of the message to delete.
 */
function deleteMessage(messageID) {
  const message = flatMessages[messageID];
  if (message && message.role === "#config") {
    // If the message is a config, check if it has next messages
    // If it has, link the next messages to the parent message
    const nextMessages = messageIDWithChildren[messageID];
    if (nextMessages && nextMessages.length > 0) {
      const parentMessage = flatMessages[message.parentID];
      if (parentMessage) {
        nextMessages.forEach((nextMessageID) => {
          const nextMessage = flatMessages[nextMessageID];
          nextMessage.parentID = parentMessage.id;
          updateFlatMessages(nextMessage);
        });
      }
    }
  }
  delete flatMessages[messageID];
  scanMessageTree();
  activePath = getPathWithMessage(message.parentID);
  renderConversation();
  vscode.postMessage({
    type: "deleteMessage",
    messageID: messageID,
  });
}


/**
 * Toggles the edit mode for a specific message.
 * @param {string} messageID - The ID of the message to toggle edit mode for.
 */
function toggleEdit(messageID) {
  const messageContainer = document.querySelector(
    `.message-container[data-id="${messageID}"]`
  );
  if (!messageContainer) {
    return;
  }
  const message = flatMessages[messageID];
  // The message node sits inside the .message-nodes-container wrapper (alongside
  // the selection checkbox, meta header and sibling switcher). Replace only that
  // node so the wrapper — and those siblings — survive the edit.
  const nodesContainer = messageContainer.querySelector(".message-nodes-container");
  const messageNode = nodesContainer ? nodesContainer.firstElementChild : messageContainer.children[0];
  if (!messageNode) {
    return;
  }
  messageNode.replaceWith(createMessageNode(message, false, true));

  focusMessageInput(messageID);
}


/**
 * Regenerates an assistant message in the conversation.
 * @param {string} messageID - The ID of the message to regenerate.
 */
function regenerateMessage(messageID) {
  const message = flatMessages[messageID];
  if (message && message.role === "assistant") {
    if (message.content.trim() === "") {
      // If the message is empty, delete it
      deleteMessage(messageID);
    }

    const parentMessage = flatMessages[message.parentID];
    if (parentMessage) {
      sendMessage(parentMessage);
    } else {
      vscode.postMessage({
        type: "error",
        error: "No parent message found for this message",
      });
    }
  } else {
    vscode.postMessage({
      type: "error",
      error: "Only assistant messages can be regenerated",
    });
  }
}


/**
 * Resends a user message in the conversation.
 * @param {string} messageID - The ID of the message to resend.
 */
function resendMessage(messageID) {
  const message = flatMessages[messageID];
  if (message && message.role === "user") {
    sendMessage(message);
  } else {
    vscode.postMessage({
      type: "error",
      error: "Only user messages can be resent",
    });
  }
}


// ============================================================================
// Message selection, cross-file copy/paste, and interleave suggestions.
// These let the user manipulate the chat history more freely: select ranges of
// messages, copy/paste them (round-tripping within ICE or as clean Markdown),
// and repair non-interleaved conversations via inline "ghost" suggestions.
// ============================================================================

/**
 * The selectable message IDs along the active path, in visual order (as strings).
 * Excludes the internal `#head` marker.
 * @returns {string[]}
 */
function _selectablePathIDs() {
  return activePath
    .map((id) => flatMessages[id])
    .filter((message) => message && message.role !== "#head")
    .map((message) => String(message.id));
}

/**
 * Orders a set of message IDs to follow their order along the active path.
 * @param {Array<string|number>} ids
 * @returns {string[]}
 */
function _orderIDsByPath(ids) {
  const wanted = new Set(ids.map(String));
  const ordered = activePath.map(String).filter((id) => wanted.has(id));
  // Keep any ids not on the active path (defensive) in their given order.
  ids.map(String).forEach((id) => {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  });
  return ordered;
}

/**
 * Reflects the current selection into the DOM and the selection action bar.
 */
function _updateSelectionUI() {
  // Prune selections that are no longer on the active path.
  const visible = new Set(_selectablePathIDs());
  for (const id of Array.from(selectedMessageIDs)) {
    if (!visible.has(id)) {
      selectedMessageIDs.delete(id);
    }
  }

  document.body.classList.toggle("selection-active", selectedMessageIDs.size > 0);

  document.querySelectorAll(".message-container").forEach((container) => {
    const id = container.dataset.id;
    const selected = selectedMessageIDs.has(id);
    container.classList.toggle("selected", selected);
    const check = container.querySelector(".selection-check");
    if (check) {
      check.classList.toggle("checked", selected);
      check.setAttribute("aria-checked", selected ? "true" : "false");
    }
  });

  _renderSelectionBar();
}

/**
 * Toggles a single message's selection.
 * @param {string|number} id
 */
function _toggleMessageSelection(id) {
  id = String(id);
  if (selectedMessageIDs.has(id)) {
    selectedMessageIDs.delete(id);
  } else {
    selectedMessageIDs.add(id);
  }
  selectionAnchorID = id;
  _updateSelectionUI();
}

/**
 * Selects a single message exclusively.
 * @param {string|number} id
 */
function _selectOnly(id) {
  id = String(id);
  selectedMessageIDs = new Set([id]);
  selectionAnchorID = id;
  _updateSelectionUI();
}

/**
 * Selects the contiguous range (along the active path) between anchor and id.
 * @param {string|number} anchorID
 * @param {string|number} id
 * @param {boolean} additive - Whether to keep the existing selection.
 */
function _selectRange(anchorID, id, additive) {
  const ids = _selectablePathIDs();
  const a = ids.indexOf(String(anchorID));
  const b = ids.indexOf(String(id));
  if (a === -1 || b === -1) {
    _toggleMessageSelection(id);
    return;
  }
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  if (!additive) {
    selectedMessageIDs = new Set();
  }
  for (let i = lo; i <= hi; i++) {
    selectedMessageIDs.add(ids[i]);
  }
  selectionAnchorID = String(id);
  _updateSelectionUI();
}

/**
 * "Select to Here": selects from the current anchor (or the top of the
 * conversation) down to the given message.
 * @param {string|number} id
 */
function _selectToHere(id) {
  let anchor = selectionAnchorID;
  if (anchor === null || !selectedMessageIDs.has(String(anchor))) {
    const ids = _selectablePathIDs();
    anchor = ids.length > 0 ? ids[0] : null;
  }
  if (anchor === null) {
    return;
  }
  _selectRange(anchor, id, false);
}

/**
 * Clears the current message selection.
 */
function _clearSelection() {
  if (selectedMessageIDs.size === 0) {
    return;
  }
  selectedMessageIDs = new Set();
  _updateSelectionUI();
}

/**
 * Resolves which messages an operation should act on: the whole selection when
 * the target is part of it, otherwise just the target (file-manager convention).
 * @param {string|number} targetID
 * @returns {string[]}
 */
function _selectionOrTargetIDs(targetID) {
  const target = String(targetID);
  if (selectedMessageIDs.size > 0 && selectedMessageIDs.has(target)) {
    return _orderIDsByPath(Array.from(selectedMessageIDs));
  }
  return [target];
}


// --- Clipboard serialization -------------------------------------------------

function _utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function _base64ToUtf8(base64) {
  return decodeURIComponent(escape(atob(base64)));
}

/**
 * Renders a single message as clean Markdown for a transcript.
 * @param {Object} message
 * @returns {string}
 */
function _messageToMarkdown(message) {
  let header;
  if (message.role === "user") {
    header = "**User**";
  } else if (message.role === "assistant") {
    header = "**Assistant**";
  } else if (message.role === "#config") {
    header = "**Configuration**";
  } else {
    header = `**${message.role}**`;
  }

  let body;
  if (message.role === "#config") {
    let config = {};
    try {
      config = JSON.parse(message.content || "{}");
    } catch (e) {
      config = {};
    }
    const keys = Object.keys(config);
    body = keys.length > 0 ?
      keys.map((key) => `- **${key}:** ${String(config[key]).replace(/\n+/g, " ")}`).join("\n") :
      "_(empty configuration)_";
  } else {
    body = (message.content || "").trim() || "_(empty)_";
  }

  let out = `${header}\n\n${body}`;
  if (message.attachments && message.attachments.length > 0) {
    const names = message.attachments.map((attachment) => attachment.name).join(", ");
    out += `\n\n*Attachments: ${names}*`;
  }
  return out;
}

/**
 * Builds the clipboard text for a set of messages.
 * @param {Array<string|number>} ids
 * @param {boolean} rich - When true, embeds structured ICE data for round-tripping.
 * @returns {string}
 */
function _buildClipboardPayload(ids, rich) {
  const ordered = _orderIDsByPath(ids);
  const messages = ordered.map((id) => flatMessages[id]).filter(Boolean);
  const markdown = messages.map(_messageToMarkdown).join("\n\n---\n\n");
  if (!rich) {
    return markdown;
  }
  const payload = {
    v: 1,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments || undefined,
      customFields: message.customFields || undefined,
      parentID: message.parentID,
      timestamp: message.timestamp,
    })),
  };
  const encoded = _utf8ToBase64(JSON.stringify(payload));
  // The structured data lives in a leading HTML comment so it is invisible in
  // rendered Markdown but lets ICE reconstruct the exact messages on paste.
  return `<!-- ${ICE_CLIPBOARD_MARKER} ${encoded} -->\n\n${markdown}`;
}

/**
 * Copies the given messages to the clipboard.
 * @param {Array<string|number>} ids
 * @param {boolean} rich
 */
function _copyIDs(ids, rich) {
  const messages = ids.map((id) => flatMessages[id]).filter(Boolean);
  if (messages.length === 0) {
    return;
  }
  const text = _buildClipboardPayload(ids, rich);
  const label = messages.length === 1 ?
    "Copied 1 message" :
    `Copied ${messages.length} messages`;
  vscode.postMessage({ type: "setClipboard", text, label });
}

function _copySelection(rich) {
  _copyIDs(_orderIDsByPath(Array.from(selectedMessageIDs)), rich);
}


// --- Paste / insert ----------------------------------------------------------

/**
 * Requests the host clipboard contents.
 * @returns {Promise<string>}
 */
function _readClipboard() {
  return new Promise((resolve) => {
    const requestID = "clip-" + (_clipboardRequestCounter++);
    _pendingClipboardRequests[requestID] = resolve;
    vscode.postMessage({ type: "readClipboard", requestID });
  });
}

/**
 * Parses an ICE clipboard payload out of arbitrary clipboard text.
 * @param {string} text
 * @returns {Array<Object>|null} The imported messages, or null when absent.
 */
function _parseClipboardMessages(text) {
  if (typeof text !== "string") {
    return null;
  }
  const match = text.match(/<!--\s*ICE-MESSAGES:v1\s+([A-Za-z0-9+/=]+)\s*-->/);
  if (!match) {
    return null;
  }
  try {
    const payload = JSON.parse(_base64ToUtf8(match[1]));
    if (payload && Array.isArray(payload.messages)) {
      return payload.messages;
    }
  } catch (e) {
    console.error("Failed to parse ICE clipboard payload", e);
  }
  return null;
}

/**
 * Wraps a set of host-persisted actions so they undo/redo as a single step.
 * @param {Function} run - Performs the mutations (which post addMessage/editMessage/deleteMessage).
 */
function _asUndoTransaction(run) {
  vscode.postMessage({ type: "beginTransaction" });
  try {
    run();
  } finally {
    vscode.postMessage({ type: "endTransaction" });
  }
}

/**
 * Briefly highlights messages (e.g. just-pasted ones) and scrolls the first into
 * view, so the user can see exactly where an operation landed.
 * @param {Array<string|number>} ids
 */
function _flashMessages(ids) {
  if (!ids || ids.length === 0) {
    return;
  }
  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const first = document.querySelector(`.message-container[data-id="${ids[0]}"]`);
  if (first) {
    first.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }
  ids.forEach((id) => {
    const element = document.querySelector(`.message-container[data-id="${id}"]`);
    if (element) {
      element.classList.remove("just-changed");
      // Force reflow so the animation restarts if the class was just removed.
      void element.offsetWidth;
      element.classList.add("just-changed");
      setTimeout(() => element.classList.remove("just-changed"), 1800);
    }
  });
}

/**
 * Reads the clipboard and inserts its messages after the given target message.
 * @param {string|number|null} targetID
 */
async function _pasteMessagesAfter(targetID) {
  const text = await _readClipboard();
  const imported = _parseClipboardMessages(text);
  if (imported && imported.length > 0) {
    _insertImportedMessages(targetID, imported);
  } else if (typeof text === "string" && text.trim().length > 0) {
    // No ICE payload — insert the raw clipboard text as a single user message.
    _insertImportedMessages(targetID, [{
      id: -1,
      role: "user",
      content: text.trim(),
      parentID: null,
      timestamp: new Date().toISOString(),
    }]);
  } else {
    vscode.postMessage({ type: "error", error: "Clipboard is empty" });
  }
}

/**
 * Inserts imported messages as a new branch grafted after the target message,
 * remapping IDs and preserving the internal parent/child structure.
 * @param {string|number|null} targetID
 * @param {Array<Object>} imported
 */
function _insertImportedMessages(targetID, imported) {
  let graftParentID = targetID != null && flatMessages[targetID] ? flatMessages[targetID].id : null;
  if (graftParentID === null) {
    const head = Object.values(flatMessages).find((message) => message.role === "#head");
    graftParentID = head ? head.id : null;
  }

  const importedIDs = new Set(imported.map((message) => String(message.id)));
  const idMap = {};
  imported.forEach((message) => {
    idMap[String(message.id)] = _freshID();
  });

  // Add parents before children so the persisted action log stays consistent.
  const added = new Set();
  const remaining = imported.slice();
  const newIDs = [];
  let lastNewID = null;
  let guard = 0;
  _asUndoTransaction(() => {
    while (remaining.length > 0 && guard++ < 100000) {
      let progressed = false;
      for (let i = 0; i < remaining.length; i++) {
        const message = remaining[i];
        const originalParent = message.parentID === null || message.parentID === undefined ?
          null : String(message.parentID);
        const parentInImport = originalParent !== null && importedIDs.has(originalParent);
        if (parentInImport && !added.has(originalParent)) {
          continue; // Wait until this message's parent has been added.
        }
        const newMessage = {
          id: idMap[String(message.id)],
          role: message.role,
          content: message.content || "",
          parentID: parentInImport ? idMap[originalParent] : graftParentID,
          timestamp: new Date().toISOString(),
        };
        if (message.attachments) {
          newMessage.attachments = message.attachments;
        }
        if (message.customFields) {
          newMessage.customFields = message.customFields;
        }
        updateFlatMessages(newMessage);
        addMessage(newMessage);
        added.add(String(message.id));
        newIDs.push(newMessage.id);
        lastNewID = newMessage.id;
        remaining.splice(i, 1);
        i--;
        progressed = true;
      }
      if (!progressed) {
        break; // Broken parent references — stop rather than loop forever.
      }
    }
  });

  scanMessageTree();
  if (lastNewID !== null) {
    activePath = getPathWithMessage(lastNewID);
  }
  renderConversation();

  // Make it obvious where the messages landed.
  const visibleNewIDs = newIDs.filter((id) => activePath.map(String).includes(String(id)));
  _flashMessages(visibleNewIDs.length > 0 ? visibleNewIDs : newIDs);
}


// --- Interleave verification (non-blocking suggestions) ----------------------

function _oppositeRole(role) {
  return role === "user" ? "assistant" : "user";
}

/**
 * Inserts dashed "ghost" suggestions wherever the active path is not properly
 * interleaved (two adjacent messages of the same conversational role). These
 * never block anything — they simply offer a one-click fix.
 */
function _renderInterleaveGhosts() {
  const isConversational = (role) => role === "user" || role === "assistant";
  for (let i = 1; i < activePath.length; i++) {
    const previous = flatMessages[activePath[i - 1]];
    const current = flatMessages[activePath[i]];
    if (!previous || !current) {
      continue;
    }
    if (isConversational(previous.role) && isConversational(current.role) && previous.role === current.role) {
      const containerCurrent = conversationContainer.querySelector(
        `.message-container[data-id="${current.id}"]`
      );
      if (containerCurrent) {
        const ghost = _createGhostMessage(previous.id, current.id, _oppositeRole(previous.role));
        containerCurrent.insertAdjacentElement("beforebegin", ghost);
      }
    }
  }
}

/**
 * Creates a dashed ghost placeholder for a missing message between two
 * same-role messages.
 * @param {string|number} afterID - The message the missing one would follow.
 * @param {string|number} beforeID - The message the missing one would precede.
 * @param {string} missingRole - The role of the missing message.
 * @returns {HTMLElement}
 */
function _createGhostMessage(afterID, beforeID, missingRole) {
  const container = document.createElement("div");
  // Deliberately not a ".message-container" — ghosts have their own styling and
  // must not inherit the bubble entrance transforms (which hide them off-screen
  // under prefers-reduced-motion).
  container.className = "ghost-message bubble " + missingRole;
  container.dataset.ghost = "true";

  const bubble = document.createElement("div");
  bubble.className = "ghost-bubble";
  bubble.setAttribute("role", "button");
  bubble.tabIndex = 0;
  const label = missingRole === "assistant" ? "Missing assistant reply" : "Missing user message";
  bubble.setAttribute("aria-label", label + ". Click to add one.");

  const labelElement = document.createElement("span");
  labelElement.className = "ghost-label";
  labelElement.textContent = label;
  bubble.appendChild(labelElement);

  const actions = document.createElement("div");
  actions.className = "ghost-actions";

  const addAction = document.createElement("span");
  addAction.className = "ghost-action ghost-action-add";
  addAction.innerHTML = icons.ICON_PLUS + `<span>Add ${missingRole === "assistant" ? "reply" : "message"}</span>`;
  actions.appendChild(addAction);

  const mergeAction = document.createElement("span");
  mergeAction.className = "ghost-action ghost-action-merge";
  mergeAction.innerHTML = icons.ICON_MERGE + "<span>Merge</span>";
  const afterMessage = flatMessages[afterID];
  mergeAction.title = "Merge these two " + (afterMessage ? afterMessage.role : "") + " messages into one";
  actions.appendChild(mergeAction);

  bubble.appendChild(actions);
  container.appendChild(bubble);

  const doAdd = (event) => {
    event.stopPropagation();
    _insertMessageBetween(afterID, beforeID, missingRole);
  };
  const doMerge = (event) => {
    event.stopPropagation();
    _mergeMessages(afterID, beforeID);
  };
  bubble.addEventListener("click", doAdd);
  bubble.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      doAdd(event);
    }
  });
  addAction.addEventListener("click", doAdd);
  mergeAction.addEventListener("click", doMerge);

  return container;
}

/**
 * Inserts a new, empty message of the given role between a parent and child,
 * then opens it for editing.
 * @param {string|number} parentID
 * @param {string|number} childID
 * @param {string} role
 */
function _insertMessageBetween(parentID, childID, role) {
  const id = _freshID();
  const message = {
    id,
    role,
    content: "",
    parentID: Number(parentID),
    timestamp: new Date().toISOString(),
  };

  _asUndoTransaction(() => {
    updateFlatMessages(message);
    addMessage(message);

    const child = flatMessages[childID];
    if (child) {
      child.parentID = id;
      updateFlatMessages(child);
      vscode.postMessage({ type: "editMessage", messageID: child.id, updates: { parentID: id } });
    }
  });

  scanMessageTree();
  activePath = getPathWithMessage(id);
  renderConversation();
  toggleEdit(id);
}

/**
 * Merges the second message into the first (concatenating content and
 * attachments) and re-parents the second's children onto the first.
 * @param {string|number} firstID
 * @param {string|number} secondID
 */
function _mergeMessages(firstID, secondID) {
  const first = flatMessages[firstID];
  const second = flatMessages[secondID];
  if (!first || !second) {
    return;
  }

  first.content = ((first.content || "") + "\n\n" + (second.content || "")).trim();
  if (second.attachments && second.attachments.length > 0) {
    first.attachments = (first.attachments || []).concat(second.attachments);
  }

  _asUndoTransaction(() => {
    updateFlatMessages(first);
    vscode.postMessage({
      type: "editMessage",
      messageID: first.id,
      updates: { content: first.content, attachments: first.attachments || [] },
    });

    const children = messageIDWithChildren[secondID] || [];
    children.forEach((childID) => {
      const child = flatMessages[childID];
      if (child) {
        child.parentID = Number(firstID);
        updateFlatMessages(child);
        vscode.postMessage({ type: "editMessage", messageID: child.id, updates: { parentID: Number(firstID) } });
      }
    });

    delete flatMessages[secondID];
    vscode.postMessage({ type: "deleteMessage", messageID: secondID });
  });

  scanMessageTree();
  activePath = getPathWithMessage(firstID);
  renderConversation();
}

/**
 * Deletes multiple messages, re-parenting any surviving descendants around the
 * deleted set so nothing is unintentionally orphaned.
 * @param {Array<string|number>} ids
 */
function _deleteMessages(ids) {
  const deleteSet = new Set(ids.map(String));
  deleteSet.forEach((id) => {
    const message = flatMessages[id];
    if (message && message.role === "#head") {
      deleteSet.delete(id);
    }
  });
  if (deleteSet.size === 0) {
    return;
  }

  const survivingParent = (parentID) => {
    let current = parentID;
    while (current !== null && current !== undefined && deleteSet.has(String(current))) {
      const parent = flatMessages[current];
      current = parent ? parent.parentID : null;
    }
    return current === undefined ? null : current;
  };

  // Pick a reasonable place to land the active path after deletion.
  let landingID = null;
  for (const id of deleteSet) {
    const message = flatMessages[id];
    if (message) {
      landingID = survivingParent(message.parentID);
      break;
    }
  }

  _asUndoTransaction(() => {
    Object.values(flatMessages).forEach((message) => {
      if (deleteSet.has(String(message.id))) {
        return;
      }
      if (message.parentID !== null && message.parentID !== undefined && deleteSet.has(String(message.parentID))) {
        const newParent = survivingParent(message.parentID);
        message.parentID = newParent;
        updateFlatMessages(message);
        vscode.postMessage({ type: "editMessage", messageID: message.id, updates: { parentID: newParent } });
      }
    });

    deleteSet.forEach((id) => {
      delete flatMessages[id];
      vscode.postMessage({ type: "deleteMessage", messageID: id });
    });
  });

  scanMessageTree();
  if (landingID !== null && flatMessages[landingID]) {
    activePath = getPathWithMessage(landingID);
  } else {
    const last = getLastMessage();
    activePath = last && last.id ? getPathWithMessage(last.id) : [];
  }
  renderConversation();
}


// --- Selection action bar ----------------------------------------------------

/**
 * Shows/updates the floating selection action bar (created lazily).
 */
function _renderSelectionBar() {
  let bar = document.getElementById("selection-bar");
  const count = selectedMessageIDs.size;
  if (count === 0) {
    if (bar) {
      bar.classList.remove("visible", "confirming");
    }
    return;
  }
  if (!bar) {
    bar = _createSelectionBar();
    document.body.appendChild(bar);
  }
  bar.querySelector(".selection-bar-count").textContent =
    count === 1 ? "1 selected" : `${count} selected`;
  bar._confirmLabel.textContent =
    count === 1 ? "Delete this message?" : `Delete ${count} messages?`;
  bar.classList.remove("confirming");
  bar.classList.add("visible");
}

/**
 * Builds the selection action bar element.
 * @returns {HTMLElement}
 */
function _createSelectionBar() {
  const bar = document.createElement("div");
  bar.id = "selection-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Selected messages");

  const count = document.createElement("span");
  count.className = "selection-bar-count";
  bar.appendChild(count);

  const addButton = (parent, icon, text, title, className) => {
    const button = document.createElement("button");
    button.className = "selection-bar-button" + (className ? " " + className : "");
    button.title = title;
    button.innerHTML = icon + (text ? `<span>${text}</span>` : "");
    parent.appendChild(button);
    return button;
  };

  const actions = document.createElement("div");
  actions.className = "selection-bar-actions";
  bar.appendChild(actions);

  // Merged copy control: a split button whose main action copies for ICE
  // (round-trippable), with a caret revealing the Markdown-only variant for
  // pasting outside ICE.
  const copyGroup = document.createElement("div");
  copyGroup.className = "selection-bar-copy";

  const closeCopyMenu = () => {
    copyGroup.classList.remove("open");
    copyCaret.setAttribute("aria-expanded", "false");
  };

  const copyMain = document.createElement("button");
  copyMain.className = "selection-bar-button primary selection-bar-copy-main";
  copyMain.title = "Copy the selected messages (paste back into ICE, or as Markdown elsewhere)";
  copyMain.innerHTML = icons.ICON_CLIPBOARD + "<span>Copy</span>";
  copyMain.addEventListener("click", () => { _copySelection(true); closeCopyMenu(); });
  copyGroup.appendChild(copyMain);

  const copyCaret = document.createElement("button");
  copyCaret.className = "selection-bar-button selection-bar-copy-caret";
  copyCaret.title = "More copy options";
  copyCaret.setAttribute("aria-haspopup", "true");
  copyCaret.setAttribute("aria-expanded", "false");
  copyCaret.setAttribute("aria-label", "More copy options");
  copyCaret.innerHTML = icons.ICON_CARET_DOWN;
  copyCaret.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = copyGroup.classList.toggle("open");
    copyCaret.setAttribute("aria-expanded", open ? "true" : "false");
  });
  copyGroup.appendChild(copyCaret);

  const menu = document.createElement("div");
  menu.className = "selection-bar-menu";
  menu.setAttribute("role", "menu");
  const addMenuItem = (icon, title, description, rich) => {
    const item = document.createElement("button");
    item.className = "selection-bar-menu-item";
    item.setAttribute("role", "menuitem");
    item.innerHTML = icon + `<span class="selection-bar-menu-text">${title}<small>${description}</small></span>`;
    item.addEventListener("click", () => { _copySelection(rich); closeCopyMenu(); });
    menu.appendChild(item);
  };
  addMenuItem(icons.ICON_CLIPBOARD, "Copy for ICE", "Round-trips when pasted back", true);
  addMenuItem(icons.ICON_MARKDOWN, "Copy as Markdown", "Clean text for pasting elsewhere", false);
  copyGroup.appendChild(menu);

  // Close the menu when clicking anywhere outside the split button.
  document.addEventListener("click", (event) => {
    if (!copyGroup.contains(event.target)) {
      closeCopyMenu();
    }
  });

  actions.appendChild(copyGroup);

  addButton(actions, icons.ICON_TRASH, "Delete", "Delete selected messages", "danger")
    .addEventListener("click", () => bar.classList.add("confirming"));
  addButton(actions, icons.ICON_XMARK, "", "Clear selection (Esc)", "icon-only")
    .addEventListener("click", () => _clearSelection());

  const confirm = document.createElement("div");
  confirm.className = "selection-bar-confirm";
  const confirmLabel = document.createElement("span");
  confirmLabel.className = "selection-bar-confirm-label";
  confirm.appendChild(confirmLabel);
  bar._confirmLabel = confirmLabel;
  addButton(confirm, icons.ICON_TRASH, "Delete", "Confirm deletion", "danger")
    .addEventListener("click", () => {
      const ids = Array.from(selectedMessageIDs);
      bar.classList.remove("confirming");
      _deleteMessages(ids);
      _clearSelection();
    });
  addButton(confirm, "", "Cancel", "Keep the selected messages")
    .addEventListener("click", () => bar.classList.remove("confirming"));
  bar.appendChild(confirm);

  return bar;
}


// --- Rubber-band (marquee) selection -----------------------------------------
(function _installRubberBand() {
  let active = false;
  let moved = false;
  let downClientX = 0;
  let downClientY = 0;
  let startX = 0;
  let startY = 0; // Content coordinates, relative to conversationContainer.
  let additive = false;
  let baseSelection = null;
  let marquee = null;
  const THRESHOLD = 4;

  function contentPoint(clientX, clientY) {
    const rect = conversationContainer.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function isEmptyAreaTarget(target) {
    if (!target) {
      return false;
    }
    const scroll = document.getElementById("conversation-scroll-container");
    if (target === conversationContainer || target === scroll) {
      return true;
    }
    // The container itself (the empty region beside a bubble), but not its
    // descendants — those own their text selection and controls.
    return Boolean(target.classList && target.classList.contains("message-container") && !target.dataset.ghost);
  }

  function onMouseDown(event) {
    if (event.button !== 0 || !isEmptyAreaTarget(event.target)) {
      return;
    }
    active = true;
    moved = false;
    additive = event.shiftKey || event.metaKey || event.ctrlKey;
    baseSelection = new Set(selectedMessageIDs);
    downClientX = event.clientX;
    downClientY = event.clientY;
    const point = contentPoint(event.clientX, event.clientY);
    startX = point.x;
    startY = point.y;
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  }

  function onMouseMove(event) {
    if (!active) {
      return;
    }
    if (!moved) {
      if (Math.abs(event.clientX - downClientX) + Math.abs(event.clientY - downClientY) < THRESHOLD) {
        return;
      }
      moved = true;
      document.body.classList.add("rubber-banding");
      marquee = document.createElement("div");
      marquee.className = "selection-marquee";
      conversationContainer.appendChild(marquee);
    }
    event.preventDefault();

    const point = contentPoint(event.clientX, event.clientY);
    const x1 = Math.min(startX, point.x);
    const y1 = Math.min(startY, point.y);
    const x2 = Math.max(startX, point.x);
    const y2 = Math.max(startY, point.y);
    marquee.style.left = x1 + "px";
    marquee.style.top = y1 + "px";
    marquee.style.width = (x2 - x1) + "px";
    marquee.style.height = (y2 - y1) + "px";

    const next = additive ? new Set(baseSelection) : new Set();
    let lastHit = null;
    document.querySelectorAll(".message-container").forEach((element) => {
      const id = element.dataset.id;
      if (!id || element.dataset.ghost) {
        return;
      }
      const message = flatMessages[id];
      if (!message || message.role === "#head") {
        return;
      }
      const top = element.offsetTop;
      const left = element.offsetLeft;
      const bottom = top + element.offsetHeight;
      const right = left + element.offsetWidth;
      if (left < x2 && right > x1 && top < y2 && bottom > y1) {
        next.add(String(id));
        lastHit = String(id);
      }
    });
    selectedMessageIDs = next;
    if (lastHit !== null) {
      selectionAnchorID = lastHit;
    }
    _updateSelectionUI();
  }

  function onMouseUp() {
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    document.body.classList.remove("rubber-banding");
    if (marquee) {
      marquee.remove();
      marquee = null;
    }
    if (active && !moved && !additive) {
      // A plain click on empty space clears the selection.
      _clearSelection();
    }
    active = false;
  }

  document.addEventListener("mousedown", onMouseDown);
})();


/**
 * Performs a context menu operation on a message.
 * @param {string} operation - The operation to perform.
 * @param {string} subOperation - The sub-operation to perform, if applicable.
 */
function contextMenuOperation(operation, subOperation) {
  let messageID;
  let attachmentID;

  // Recursively find the message node from the `contextMenuTargetElement` or its parent elements
  let currentCheckElement = contextMenuTargetElement;
  while (currentCheckElement) {
    if (currentCheckElement.classList.contains("message-container") || currentCheckElement.classList.contains("message-node")) {
      messageID = currentCheckElement.dataset.id;
      break;
    }

    if (currentCheckElement.classList.contains("file")) {
      attachmentID = currentCheckElement.dataset.attachmentID;
    }

    currentCheckElement = currentCheckElement.parentElement;
    console.log("Current check element", currentCheckElement);
  }

  if (!messageID) {
    console.error("No message node found in the cursor hover elements");
    return;
  }

  switch (operation) {
    case "fork":
      const message = flatMessages[messageID];
      const newMessage = {
        ...message,
        id: Date.now(),
        timestamp: new Date().toISOString(),
      };
      updateFlatMessages(newMessage);
      scanMessageTree();
      activePath = getPathWithMessage(newMessage.id);
      renderConversation();

      addMessage(newMessage);
      break;
    case "delete":
      showDeleteConfirmation(messageID);
      break;
    case "toggleEdit":
      toggleEdit(messageID);
      break;
    case "regenerate":
      regenerateMessage(messageID);
      break;
    case "resend":
      resendMessage(messageID);
      break;
    case "copy":
    case "copyRich":
      _copyIDs(_selectionOrTargetIDs(messageID), true);
      break;
    case "copyMarkdown":
      _copyIDs(_selectionOrTargetIDs(messageID), false);
      break;
    case "copyPlainText":
      vscode.postMessage({
        type: "setClipboard",
        text: flatMessages[messageID].content,
      });
      break;
    case "toggleSelect":
      _toggleMessageSelection(messageID);
      break;
    case "selectToHere":
      _selectToHere(messageID);
      break;
    case "paste":
      _pasteMessagesAfter(messageID);
      break;
    case "insertConfigUpdate":
      const position = subOperation;
      let parentID;
      let nextID;
      if (position === "before") {
        parentID = flatMessages[messageID].parentID;
        nextID = messageID;
      } else if (position === "after") {
        parentID = messageID;
        const currentMessageIndexInPath = activePath.findIndex((id) => String(id) === messageID);
        if (currentMessageIndexInPath !== -1 && currentMessageIndexInPath < activePath.length - 1) {
          // TODO: Fix this
          nextID = activePath[currentMessageIndexInPath + 1];
        } else {
          nextID = null;
        }
      } else {
        console.error("Unknown position", position);
        return;
      }
      console.log(activePath);
      console.log("Inserting config update before", parentID, "next", nextID);
      if (!flatMessages[parentID]) {
        vscode.postMessage({
          type: "error",
          error: "Unable to insert config update, parent message not found",
        });
        return;
      }
      const id = insertConfigUpdate(parentID, nextID);
      scanMessageTree();
      activePath = getPathWithMessage(id);
      renderConversation();
      toggleEdit(id);
      break;
    case "revealAttachment":
      if (attachmentID) {
        let attachments = [];
        if (_editingMessageAttachments[messageID]) {
          attachments = _editingMessageAttachments[messageID];
        } else {
          attachments = flatMessages[messageID].attachments;
        }
        const attachment = attachments.find(
          (attachment) => String(attachment.id) === attachmentID
        );
        if (attachment) {
          vscode.postMessage({
            type: "revealFile",
            path: attachment.url,
          });
        } else {
          console.error("Attachment not found", attachmentID);
        }
      } else {
        console.error("No attachment ID found");
      }
      break;
    case "removeAttachment":
      if (attachmentID) {
        let attachments;
        let isShadow = false;
        if (_editingMessageAttachments[messageID]) {
          // If the message is a shadow message, get the attachments from the editing attachments
          attachments = _editingMessageAttachments[messageID];
          isShadow = true;
        } else {
          attachments = flatMessages[messageID].attachments;
        }
        const attachmentIndex = attachments.findIndex(
          (attachment) => String(attachment.id) === attachmentID
        );
        if (attachmentIndex !== -1) {
          attachments.splice(attachmentIndex, 1);
          if (!isShadow) {
            // Save the attachment changes if the message is not a shadow message
            vscode.postMessage({
              type: "editMessage",
              messageID: messageID,
              updates: {
                attachments: attachments,
              },
            });
          }
          updateAttachments(messageID, attachments, false);
        } else {
          console.error("Attachment not found", attachmentID);
        }
      } else {
        console.error("No attachment ID found");
      }
      break;
    case "createSnippet":
      const editor = EditorView.findFromDOM(document.querySelector(`.message-container[data-id="${messageID}"]`));
      if (editor) {
        const selectedText = editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to);
        vscode.postMessage({
          type: "createSnippet",
          content: selectedText,
        });
        console.log("Selected text", selectedText);
      }
      break;
    default:
      console.error("Unknown context menu operation", operation);
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "loadActions":
      handleLoadActions(message.actions);
      break;
    case "appendAction":
      handleLoadActions(message.actions, true);
      break;
    case "updateMessage":
      handleUpdateMessage(message.message, message.incomplete);
      if (!message.incomplete) {
        _maybeHandleToolCalls(message.message);
      }
      break;
    case "toolResult":
      _handleToolResult(message);
      break;
    case "toolProgress":
      _handleToolProgress(message);
      break;
    case "toolElicit":
      _handleToolElicit(message);
      break;
    case "toolSettings":
      _toolAutoApprove = Boolean(message.autoApprove);
      _toolMaxAutoIterations = message.maxAutoIterations || 8;
      break;
    case "availableTools": {
      _availableTools = message.tools || [];
      const toolWaiters = _availableToolsWaiters;
      _availableToolsWaiters = [];
      toolWaiters.forEach((cb) => { try { cb(_availableTools); } catch (e) { console.error(e); } });
      if (_toolsPopoverRefresh) {
        try { _toolsPopoverRefresh(); } catch (e) { console.error(e); }
      }
      break;
    }
    case "availableToolsInvalidated":
      // The set of tools (e.g. MCP servers) changed; drop the cache and, if the
      // picker is open, refetch so it reflects the change immediately.
      _availableTools = null;
      if (_toolsPopoverRefresh) {
        _ensureAvailableTools(function () {});
      }
      break;
    case "insertToolsNode":
      _insertToolsNode(message.enabled);
      break;
    case "deleteMessage":
      deleteMessage(message.messageID);
      break;
    case "contextMenuOperation":
      contextMenuOperation(message.operation, message.subOperation);
      break;
    case "selectProvider":
      currentProvider = message.providerID;
      _adoptProvider(message.providerID);
      break;
    case "progress":
      setProgressIndicator(message.text, message.cancelableRequestID);
      break;
    case "undo":
    case "redo":
      if (globalUndoLock) {
        console.log("Global undo lock is active, ignoring undo/redo");
      } else {
        console.log("Undo/Redo", message.type);
        vscode.postMessage({
          type: message.type,
        });
      }
      break;
    case "addAttachments":
      const messageID = message.messageID;
      const attachmentMetas = message.attachmentMetas;
      updateAttachments(messageID, attachmentMetas, true);
      break;
    case "providerIDs":
      availableProviders = message.providerIDs;
      break;
    case "providerConfig":
      providerConfigKeys[message.providerID] = message.configKeys;
      providerOptions[message.providerID] = message.options || {};
      providerDefaults[message.providerID] = message.defaults || {};
      // Wake anything waiting on this provider's config/options (e.g. a composer
      // quick-tune bar rendered before the payload arrived).
      if (_providerConfigWaiters[message.providerID]) {
        const waiters = _providerConfigWaiters[message.providerID];
        delete _providerConfigWaiters[message.providerID];
        waiters.forEach((cb) => {
          try { cb(); } catch (e) { console.error(e); }
        });
      }
      break;
    case "providerOptions": {
      const resolver = _pendingOptionRequests[message.requestID];
      if (resolver) {
        delete _pendingOptionRequests[message.requestID];
        if (message.error) {
          resolver.reject(new Error(message.error));
        } else {
          resolver.resolve(_normalizeOptions(message.options));
        }
      }
      break;
    }
    case "globalConfigChanged":
      // The user edited this provider's global defaults; offer to bring the
      // changes into the open conversation (see _handleGlobalConfigChanged).
      _handleGlobalConfigChanged(message.providerID, message.changes);
      break;
    case "loadSnippets":
      snippets = message.snippets;
      break;
    case "clipboardContent": {
      const resolver = _pendingClipboardRequests[message.requestID];
      if (resolver) {
        delete _pendingClipboardRequests[message.requestID];
        resolver(message.text);
      }
      break;
    }
    case "pasteAtEnd": {
      const lastID = activePath.length > 0 ? activePath[activePath.length - 1] : null;
      _pasteMessagesAfter(lastID);
      break;
    }
    case "showErrorOverlay":
      const errorID = message.errorID;
      const detail = message.detail;

      switch (errorID) {
        case "corruptedChatFile":
          showErrorOverlay("This file is corrupted and cannot be opened", icons.ICON_FOLDER_X, detail);
          break;
        case "fileNotFound":
          showErrorOverlay("File not found", icons.ICON_FOLDER_QUESTION, detail);
          break;
        default:
          showErrorOverlay("Unknown error", icons.ICON_EXCLAMATION_OCTAGON, detail);
      }
      break;
    default:
      console.error("Unknown message type", message.type);
  }
});

document.addEventListener('keydown', function (event) {
  // Escape clears an active message selection (without stealing Escape from
  // editors or menus when nothing is selected).
  if (event.key === "Escape" && selectedMessageIDs.size > 0) {
    _clearSelection();
  }
});

document.addEventListener('contextmenu', function (event) {
  contextMenuTargetElement = event.target;
  vscode.postMessage({
    type: "contextMenu",
  });
});

document.addEventListener('DOMContentLoaded', () => {
  const scrollContainer = document.getElementById('conversation-scroll-container');
  const conversationContainer = document.getElementById('conversation-container');
  const backToBottomBtn = document.getElementById('back-to-bottom');
  const goBackBtn = document.getElementById('go-back');

  let lastScrollTop = 0;
  let savedScrollPosition = null;
  let savedScrollPositionResetTimeout = null;

  function getVisibleElementInfo() {
    const elements = Array.from(conversationContainer.children);
    const containerRect = scrollContainer.getBoundingClientRect();

    for (let elem of elements) {
      const rect = elem.getBoundingClientRect();
      
      // Check if the element is at least partially visible
      if (rect.top < containerRect.bottom && rect.bottom > containerRect.top) {
        // Calculate the relative position within the element
        const relativeOffset = scrollContainer.scrollTop - elem.offsetTop;
        return { messageID: elem.dataset.id, relativeOffset: relativeOffset };
      }
    }
    return null;
  }

  function updateButtonVisibility() {
    const scrollActionThreshold = -window.innerHeight * 0.9;
    // If the user has scrolled up, show the back to bottom button
    if (scrollContainer.scrollTop < scrollActionThreshold) {
      backToBottomBtn.classList.add('visible');
    } else {
      backToBottomBtn.classList.remove('visible');
    }

    if (savedScrollPosition) {
      // Check if the scroll offset is greater than one screen height, and the user is scrolling up
      if (scrollContainer.scrollTop <= scrollActionThreshold && lastScrollTop > scrollContainer.scrollTop) {
        // Reset the saved scroll position
        savedScrollPosition = null;
      } else {
        // Show the go back button
        goBackBtn.classList.add('visible');
      }
    } else {
      goBackBtn.classList.remove('visible');
    }

    lastScrollTop = scrollContainer.scrollTop;
  }

  scrollContainer.addEventListener('scroll', updateButtonVisibility);

  backToBottomBtn.addEventListener('click', () => {
    savedScrollPosition = getVisibleElementInfo();
    
    if (savedScrollPositionResetTimeout) {
      clearTimeout(savedScrollPositionResetTimeout);
    }
    savedScrollPositionResetTimeout = setTimeout(() => {
      savedScrollPosition = null;
      updateButtonVisibility();
    }, 5 * 60 * 1000);  // Clear the saved scroll position after 5 minutes

    console.log('Saved scroll position:', savedScrollPosition);
    scrollContainer.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
    updateButtonVisibility();
  });

  goBackBtn.addEventListener('click', () => {
    if (savedScrollPosition) {
      const { messageID, relativeOffset } = savedScrollPosition;
      savedScrollPosition = null;
      
      const element = document.querySelector(`.message-container[data-id="${messageID}"]`);
      if (!element) {
        console.error('Cannot find element to scroll back to; messageID:', messageID);
        return;
      }

      const scrollOffset = element.offsetTop + relativeOffset;
      // Scroll to the calculated offset
      scrollContainer.scrollTo({
        top: scrollOffset,
        behavior: 'smooth'
      });

      updateButtonVisibility();
    }
  });
});


/**
 * Sends a message in the conversation.
 * @param {Object} leafMessage - The leaf message object to send.
 */
function sendMessage(leafMessage, isToolContinuation = false) {
  // A normal (user-initiated) send resets the automatic tool-round counter; a
  // tool continuation keeps counting so the loop cap can eventually pause it.
  if (!isToolContinuation) {
    _toolAutoRunCount = 0;
  }
  const fullPath = getPathWithMessage(leafMessage.id);
  const leafMessageIndex = fullPath.indexOf(leafMessage.id);
  const path = fullPath.slice(0, leafMessageIndex + 1);
  const config = getMessageConfig(leafMessage.id);
  const contextMessages = path.map((id) => flatMessages[id]);
  vscode.postMessage({
    type: "sendMessage",
    config: config,
    messageTrail: contextMessages,
    // Hash of the exact context this reply is generated from, stored on the
    // reply so later edits upstream can be detected (see _computeStaleMessages).
    contextChecksum: _computeContextChecksum(contextMessages),
  });
}


/**
 * Adds a new message to the conversation.
 * @param {Object} message - The message object to add.
 */
function addMessage(message) {
  vscode.postMessage({
    type: "addMessage",
    message: message,
  });
}


/**
 * Selects a provider for the conversation.
 * @param {string} providerID - The ID of the provider to select.
 */
function selectProvider(providerID) {
  currentProvider = providerID;
  vscode.postMessage({
    type: "selectProvider",
    providerID: providerID,
  });
}
