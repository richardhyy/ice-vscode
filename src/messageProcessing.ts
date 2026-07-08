import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import { ChatMessage } from './chatHistoryManager';
import { ROLE_CONFIG, ROLE_USER, isMetaRole } from './constants';

const isBinaryFileSync = require('isbinaryfile').isBinaryFileSync;

/** Matches template variables of the form `{{ name }}` or `{{name}}`. */
const VARIABLE_PATTERN = /{{\s*([^\s]+)\s*}}/g;

/**
 * Builds the message trail that will be sent to a provider:
 * - collects `$`-prefixed variables declared in `#config` messages,
 * - substitutes `{{ variable }}` placeholders inside user messages,
 * - drops meta messages (roles prefixed with '#').
 */
export function resolveMessageTrailVariables(rawMessageTrail: ChatMessage[]): ChatMessage[] {
  const messageTrail: ChatMessage[] = [];
  const variableValueMap = new Map<string, string>();

  for (const m of rawMessageTrail) {
    if (m.role === ROLE_CONFIG) {
      // Extract the variables from the config message.
      const config: any = yaml.load(m.content);
      if (config) {
        for (const key of Object.keys(config)) {
          if (!key.startsWith('$')) {
            continue;
          }
          variableValueMap.set(key.substring(1), config[key]);
        }
      }
    } else if (!isMetaRole(m.role)) {
      // Fill variables in the message content.
      const newMessage = { ...m };
      if (m.role === ROLE_USER) {
        newMessage.content = m.content.replace(VARIABLE_PATTERN, (match: string, variableName: string) => {
          return variableValueMap.get(variableName) || match;
        });
      }
      messageTrail.push(newMessage);
    }
  }

  return messageTrail;
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
