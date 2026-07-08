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
