const icons = require('./icons.js');
const marked = require('marked');
import { Ruler } from './widgets/ruler.js';
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { autocompletion } from "@codemirror/autocomplete";

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
let currentProvider = null;
let availableProviders = [];
let providerConfigKeys = {}; // {providerID: [configKey1, configKey2, ...]}
let snippets = {}; // {completion: content}

let globalUndoLock = null;
let contextMenuTargetElement = null;

let _editingMessageAttachments = {}; // {messageID: [attachment1, attachment2, ...]}


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
    message = {
      id: Date.now(),
      role: "user",
      content,
      attachments: _editingMessageAttachments[message.id],
      parentID: message.parentID,
      timestamp: new Date().toISOString(),
    };
    addMessage(message);
  } else {
    // Edit the message if it's an existing message
    message.content = content;
    message.attachments = _editingMessageAttachments[message.id] || [];
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

    let variableKeys = [];
    if (message.role === "user") {  // Only user messages can have variables
      const configObj = getMessageConfig(message.isShadow ? message.parentID : message.id);
      variableKeys = Object.keys(configObj).filter((key) => key.startsWith("$")).map((key) => key.slice(1));
    }

    console.log("Config keys", variableKeys);

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
      const before = context.matchBefore(/\/(\w*)|(\{\{?\s*\w*)|(\$\w*)|(\w+)/);
      if (!before) {
        return null;
      }
    
      const options = [
        ...Object.entries(snippets).map(([completion, content]) => ({
          label: "/" + completion,
          apply: content,
          type: "text",
        })),
        ...variableKeys.map((key) => ({
          label: "{{ " + key + " }}",
          apply: "{{ " + key + " }}",
          type: "variable",
        }))
      ];
      
      const value = {
        from: before.from,
        options: options,
        validFor: /^(\/\w*|\{\{?\s*\w*|\$\w*|\w*)$/,
      };
      console.log("Autocompletion value", value);
      return value;
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

      // Attachment list
      messageContent.appendChild(attachmentContainer);
      updateAttachments(message.id, message.attachments || [], false, attachmentContainer);
    }
  } else { // Not editing
    let renderedContent = _renderMarkdown(message.content + (message.content.length === 0 ? (message.incomplete ? "..." : "(empty)") : ""));
    const markdownContent = document.createElement("div");
    markdownContent.classList.add("markdown-content");
    if (message.content.length === 0) {
      markdownContent.classList.add("empty");
    }
    messageContent.appendChild(markdownContent);
    if (clipContent) {
      const clippedContent = document.createElement("div");
      clippedContent.classList.add("clipped-content");
      clippedContent.innerHTML = renderedContent;
      markdownContent.appendChild(clippedContent);
    } else {
      if (message.role === "user") {
        const config = getMessageConfig(message.id);
        const variableKeyValueMap = Object.entries(config).filter(([key, value]) => key.startsWith("$")).map(([key, value]) => [key.slice(1), value]);
        
        function processVariables(content, isCodeBlock) {
          const variableRegex = /{{\s*([^\s]+)\s*}}/g;
          return content.replace(variableRegex, (match, variableName) => {
            if (variableKeyValueMap.find(([key, value]) => key === variableName)) {
              if (isCodeBlock) {
                // For code blocks, we don't add any HTML, just return the original match
                return match;
              } else {
                // For non-code blocks, we use the HTML structure
                return `<span class="variable-wrapper" title="${match}"><span class="variable-delimiter">{{</span><span class="variable-placeholder">${variableName}</span><span class="variable-delimiter">}}</span></span>`;
              }
            } else {
              return match;
            }
          });
        }
        
        const codeBlockRegex = /(<pre><code[^>]*>)([\s\S]*?)(<\/code><\/pre>)/gi;
        
        renderedContent = renderedContent.replace(codeBlockRegex, (match, openTag, codeContent, closeTag) => {
          // For code blocks, we process variables but don't add HTML structure
          const processedCodeContent = processVariables(codeContent, true);
          // We still wrap the content in preserve-whitespace, but don't add any other HTML
          return `${openTag}<span class="preserve-whitespace">${processedCodeContent}</span>${closeTag}`;
        });
        
        // Process variables outside of code blocks
        renderedContent = processVariables(renderedContent, false);
      }
      markdownContent.innerHTML = renderedContent;
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

  function createKeyToken(key, group, type, detail = undefined) {
    const tokenElement = document.createElement("span");
    tokenElement.classList.add("config-key-token");
    tokenElement.textContent = key;
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
    });
    configKeyContainer.appendChild(tokenElement);

    result.push({
      label: key + " = ",
      apply: key + " = ",
      type: type,
      detail: detail
    });
  }

  // Add variable prefix key
  createKeyToken("$", "New Variable", "syntax", "New variable");

  // Add variables
  for (let key in getMessageConfig(messageID)) {
    if (key.startsWith("$")) {
      createKeyToken(key, "Variable", "variable");
    }
  }

  for (let group of Object.keys(providerConfigKeys[providerID])) {
    for (let key of providerConfigKeys[providerID][group]) {
      if (config[key] === undefined) {
        createKeyToken(key, group, `config-key-${group}`);
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
        if (key.startsWith("$")) {
          keyElement.classList.add("variable-name");
        }
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
          shadowSiblingMessageContainer.appendChild(siblingMessageNode);
        }
      }
    }
  }

  return shadowSiblingMessageContainer;
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

/**
 * Renders the entire conversation.
 * @param {boolean} shouldAnimateLastMessage - Whether to animate the last message when rendering.
 */
function renderConversation(shouldAnimateLastMessage = false) {
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
    // If the message is in the active path, rerender the message
    rerenderMessage(message.id);
  }
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
      vscode.postMessage({
        type: "confirmAction",
        message: `Are you sure to delete this message? (${flatMessages[
          messageID
        ].content.substring(0, 20)}...)`,
        onConfirm: {
          type: "deleteMessage",
          messageID: messageID,
        },
      });
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
      vscode.postMessage({
        type: "setClipboard",
        text: flatMessages[messageID].content,
      });
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
      break;
    case "loadSnippets":
      snippets = message.snippets;
      break;
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
  vscode.postMessage({
    type: "sendMessage",
    config: config,
    messageTrail: path.map((id) => flatMessages[id]),
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
