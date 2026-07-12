// ==ICETool==
// @name         ask_user
// @description  Ask the user a short clarifying question and wait for their reply. Use when the request is ambiguous or the choice is genuinely the user's to make. Do not use for anything you can determine yourself.
// ==/ICETool==

'use strict';

/**
 * A built-in ICE tool that lets the model pause mid-turn to ask the human a
 * clarifying question, then continue with the answer. It owns no logic of its
 * own: it renders the question as a form (ICE's elicitation capability, via
 * `context.elicit`) and returns whatever the human supplies as the tool result.
 *
 * There is nothing MCP-specific here. Elicitation is an ordinary ICE tool
 * capability; this tool simply uses it directly. The question shown to the user
 * is the model's, so the form reads as "the assistant is asking".
 */
module.exports = {
  // Asking a question changes nothing, so the call never needs approval and the
  // user sees the question immediately rather than an "Approve this tool?" gate.
  readOnly: true,

  arguments: {
    question: {
      type: 'string',
      description: 'The clarifying question to show the user.',
    },
    options: {
      type: 'array',
      optional: true,
      items: { type: 'string' },
      description: 'If the answer is one of a fixed set, list the choices to offer.',
    },
  },

  async call({ question, options }, context) {
    if (typeof question !== 'string' || !question.trim()) {
      throw new Error('`question` is required.');
    }

    // A list of choices becomes a single-select; otherwise a free-text field.
    // With options we pass a ready JSON schema (used as-is) carrying `allowCustom`
    // so the form also offers an "Other" answer, keeping the user in control
    // rather than boxed into the model's suggestions.
    const fields = Array.isArray(options) && options.length
      ? {
          type: 'object',
          properties: {
            choice: {
              type: 'string',
              enum: options.map(String),
              allowCustom: true,
            },
          },
          required: ['choice'],
        }
      : { answer: { type: 'string', description: 'Your answer.' } };

    const { action, content } = await context.elicit(question.trim(), fields);

    if (action === 'decline') {
      return 'The user chose not to answer.';
    }
    if (action !== 'accept') {
      return 'The user dismissed the question.';
    }

    const answer = content && (content.choice != null ? content.choice : content.answer);
    const text = answer == null ? '' : String(answer).trim();
    return text || '(the user left the answer blank)';
  },
};
