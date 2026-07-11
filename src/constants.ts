/**
 * Centralised constants shared across the extension-host modules.
 * Keeping these in one place avoids magic strings scattered through the codebase
 * and makes the meaning of each special value explicit.
 */

/** Internal "head" marker stored as the first action of every chat history file. */
export const ROLE_HEAD = '#head';

/** Inline configuration message role. */
export const ROLE_CONFIG = '#config';

/** Standard conversational roles. */
export const ROLE_USER = 'user';
export const ROLE_ASSISTANT = 'assistant';

/**
 * Tool-result role. A `tool` node holds the output of an MCP tool call and is
 * fed back to the model (so it is NOT a meta role). It links to the call it
 * answers via `customFields.toolCallID`.
 */
export const ROLE_TOOL = 'tool';

/**
 * Inline tool-enablement role (meta, '#'-prefixed). A '#tools' node records the
 * set of tools offered to the model from that point onward; like '#config' it is
 * dropped from the conversational trail and resolved into the request instead.
 */
export const ROLE_TOOLS = '#tools';

/**
 * Meta roles are prefixed with '#' and are never sent to a provider as
 * conversational content (e.g. '#head', '#config').
 */
export function isMetaRole(role: string): boolean {
  return role.startsWith('#');
}

/** Global-state key holding the id of the most recently used provider. */
export const STATE_KEY_PREVIOUS_PROVIDER_ID = 'chatView.previousProviderID';

/** Suffix identifying a built-in (bundled) provider id. */
export const BUILT_IN_SUFFIX = '@built-in';

/** File extension used for persisted chat sessions. */
export const CHAT_FILE_EXTENSION = '.chat';
