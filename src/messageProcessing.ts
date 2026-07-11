import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatMessage } from './chatHistoryManager';
import { isMetaRole, ROLE_TOOLS } from './constants';
import { ToolDefinition } from './providerManager';

const isBinaryFileSync = require('isbinaryfile').isBinaryFileSync;

/**
 * Builds the message trail that will be sent to a provider by dropping meta
 * messages (roles prefixed with '#', e.g. '#config'/'#head'). Those messages
 * configure the request but are never part of the conversation sent to the
 * model. Each surviving message is shallow-copied so later processing steps
 * (e.g. attachment inlining) never mutate the caller's objects.
 */
export function buildProviderMessageTrail(rawMessageTrail: ChatMessage[]): ChatMessage[] {
  return rawMessageTrail
    .filter(m => !isMetaRole(m.role))
    .map(m => ({ ...m }));
}

/**
 * Normalises attachment URLs to absolute paths and, when `needPreprocess` is set,
 * inlines readable text attachments into the message content (skipping binaries).
 *
 * A provider can opt out of preprocessing by setting `_needAttachmentPreprocessing`
 * to `false`, in which case it is expected to handle attachments itself.
 */
export function preprocessAttachments(messageTrail: ChatMessage[], chatFilePath: string, needPreprocess: boolean): ChatMessage[] {
  return messageTrail.map(message => {
    if (message.attachments) {
      message.attachments = message.attachments.map(attachment => {
        // Convert relative attachment URLs to absolute paths.
        if (attachment.url.startsWith('data:') || attachment.url.startsWith('http')) {
          return attachment;
        }
        return {
          ...attachment,
          url: attachment.url.startsWith('http') || fs.existsSync(attachment.url)
            ? attachment.url
            : path.join(path.dirname(chatFilePath), attachment.url),
        };
      });
    }

    if (needPreprocess && message.attachments) {
      // Preprocess the attachment: skip binary files; read text files and insert
      // their content into the message body for maximum provider compatibility.
      for (const attachment of message.attachments) {
        let fileBuffer;

        if (attachment.url.startsWith('data:')) {
          // Base64 encoded data.
          const base64Data = attachment.url.split(',')[1];
          fileBuffer = Buffer.from(base64Data, 'base64');
        } else {
          fileBuffer = fs.readFileSync(attachment.url);
        }

        const isBinary = isBinaryFileSync(fileBuffer);
        if (!isBinary) {
          message.content = `<${attachment.name}>\n${fileBuffer}\n</${attachment.name}>\n${message.content}`;
        } else {
          message.content = `<${attachment.name}>\nUnsupported attachment\n</${attachment.name}>\n${message.content}`;
          vscode.window.showWarningMessage(`Attachment ${attachment.name} is a binary file and cannot be sent.`);
        }
      }

      delete message.attachments;
    }

    return message;
  });
}

/**
 * A tool enabled for a conversation, as stored inside a '#tools' node. `ref` is
 * the unique, model-facing name the provider sends to the model; `server` + `name`
 * identify the MCP server and tool to actually invoke when the model calls `ref`.
 * `inputSchema` is snapshotted so the .chat records exactly what the model saw.
 */
export interface EnabledTool {
  server: string;
  name: string;
  ref: string;
  description?: string;
  inputSchema?: any;
  readOnly?: boolean;
}

/**
 * Resolves the set of tools enabled at the end of a message trail. Each '#tools'
 * node states the full active set from that point onward, so the nearest one wins
 * (a later node fully replaces an earlier one, mirroring how the composer
 * materialises the complete current selection). Malformed nodes are ignored.
 */
export function resolveEnabledTools(messageTrail: ChatMessage[]): EnabledTool[] {
  let enabled: EnabledTool[] = [];
  for (const message of messageTrail) {
    if (message.role === ROLE_TOOLS) {
      try {
        const parsed = JSON.parse(message.content || '{}');
        if (Array.isArray(parsed.enabled)) {
          enabled = parsed.enabled;
        }
      } catch {
        // Ignore a malformed tools node rather than failing the whole request.
      }
    }
  }
  return enabled;
}

/**
 * Translates the conversation's enabled tools into the provider-facing tool
 * definitions handed to `getCompletion`. The model-facing `name` is the `ref`, so
 * tool calls can be mapped back to their server + tool for execution.
 */
export function toolDefinitionsFromEnabled(enabled: EnabledTool[]): ToolDefinition[] {
  return enabled.map((tool) => ({
    name: tool.ref,
    description: tool.description,
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  }));
}
