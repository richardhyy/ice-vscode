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

    message = {
      id: _freshID(),
      role: "user",
      content,
      attachments: _editingMessageAttachments[shadowId],
      parentID: parentID,
      timestamp: new Date().toISOString(),
    };

    if (configDiff) {
      // Insert the config node and the user message as one undoable step.
      _asUndoTransaction(() => {
        const configID = insertConfigUpdate(parentID, null, configDiff);
        message.parentID = configID;
        addMessage(message);
      });
    } else {
      addMessage(message);
    }

    delete _composerQuickConfig[shadowId];
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

  _ensureProviderConfig(providerID, () => {
    // The editor may have been dismissed while the payload was in flight.
    if (!bar.isConnected) {
      return;
    }
    const meta = providerOptions[providerID] || {};
    const quickKeys = Object.keys(meta).filter((key) => meta[key] && meta[key].quick);
    if (quickKeys.length === 0) {
      bar.remove();
      return;
    }

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
  const message = flatMessages[messageID];
  // Get first child of the message node
  const messageNode = messageContainer.children[0];
  const messageContentEditing = createMessageNode(message, false, true);
  messageNode.replaceWith(messageContentEditing);

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
      break;
    case "deleteMessage":
      deleteMessage(message.messageID);
      break;
    case "contextMenuOperation":
      contextMenuOperation(message.operation, message.subOperation);
      break;
    case "selectProvider":
      currentProvider = message.providerID;
      handleUpdateConfig({
        Provider: currentProvider
      });
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
function sendMessage(leafMessage) {
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
