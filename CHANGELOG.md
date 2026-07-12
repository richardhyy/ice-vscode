# Change Log

## [0.7.1] - 2026-07-12

### Added
- New built-in tools for working with your conversations:
  - `recall`: search your saved conversations (the other `.chat` files in the workspace) by message text or file name, optionally within a date range. It is read-only and stays under your control: nothing reaches the model until you review the matches and approve what to share.
  - `session_messages`: find, read, edit, or delete messages in the current conversation. Changes are applied by the editor, shown in place, and undoable in a single step.
- Tool elicitation: a tool can pause to ask you a short question mid-answer and continue with your reply, shown as a form. A built-in `ask_user` tool uses this directly.
- Progress and cancellation for tool calls: long-running tools can report progress, and you can stop a tool call that is in flight.
- After you re-run a tool, ICE now offers to let the model respond, or respond again when the result changed since its last reply.

### Changed
- Redesigned the response-cancellation experience into a single quiet progress pill with a clear Stop button that respects reduced-motion settings.

### Fixed
- Fixed a visual balance issue with the composer's tools button.

## [0.7.0] - 2026-07-12

Since 0.6.0, this release adds tool calling with the Model Context Protocol, reasoning display, per-message metadata, richer message editing, and a redesigned provider configuration experience.

### Added
- Tool calling: models can call tools and use the results in their answer.
  - Native JavaScript tools you can open, read, and edit, in the same spirit as providers. A built-in `fetch_url` tool ships with ICE.
  - Model Context Protocol (MCP) support: connect stdio or HTTP MCP servers through the `ice.mcpServers` setting and expose their tools to the model.
  - Tool selection for a conversation is recorded as an editable, forkable node in the `.chat` file.
  - Tool calls ask for approval by default, and every call and result is recorded as a node. Settings control auto-approval (`ice.tools.autoApprove`) and how many consecutive tool rounds run before pausing (`ice.tools.maxAutoIterations`).
  - New commands: "ICE: Enable Tools" and "ICE: Add MCP Server".
- Reasoning (thinking) output is streamed and shown for providers that expose it.
- Per-message metadata: each reply shows the model and time, with a hover popover for provider, token usage, temperature, and system prompt. A quiet indicator flags replies whose context has since changed.
- Multi-select messages with copy, paste, and insert, including copy and paste between different `.chat` files.
- Branch switching preview: hovering a sibling branch previews its continuation before you switch.
- Provider option selection and a composer quick-tune bar for adjusting per-message settings (for example the model) inline.
- Service presets for the OpenAI-compatible provider (OpenAI, Ollama, LM Studio, OpenRouter, Groq, DeepSeek, and more) with an optional custom Base URL.

### Changed
- Redesigned the OpenAI-compatible provider configuration around friendly presets and a clearer configuration menu; global configuration changes can be synced into an open conversation.
- Removed the custom message-variable substitution (the old `$name` config token and `{{name}}` placeholders in user messages). System prompt environment variables (such as `{{DATE_TODAY}}`) are unchanged.
- Refreshed the built-in providers and removed the redundant Zhipu provider.
- Replaced the double delete confirmation with a lighter inline prompt.
- Streaming replies now render incrementally, updating in place as text arrives instead of re-rendering on every token, with quiet typing and thinking feedback that respects reduced-motion settings.

### Fixed
- Provider HTTP errors are no longer silently dropped. The error is shown and recorded on the reply itself, so it persists in the `.chat` file.
- Improved text contrast in configuration nodes to meet WCAG AA.

## [0.6.0] - 2024-07-22

### Added
- New navigation buttons in chat view:
  - "Go back" button to restore previous scroll position
  - "Back to bottom" button for quick navigation to the latest message
- Message variable support for placeholders in prompts
- Environment variable support for system prompts
- Ruler with position markers for improved conversation navigation

### Changed
- Updated command names for message operations to improve clarity:
  - "Duplicate" -> "Fork"
  - "Toggle Edit" -> "Edit"
- Refined config node insertion process to re-link messages instead of creating new branches

### Improved
- Configuration editor selection color for better visibility

### Known Issues
- Ctrl+C/V (or Command+C/V) for copy/paste may not work after using the context menu in ICE. This is a known *VSCode issue* that will be fixed in a future update. Workaround: Click outside the chat view and then back inside to restore copy/paste functionality.

## [0.5.1] - 2024-07-14
### Changed
- Improved handling of empty messages
- Improved attachment scroll behavior and message content width
- Improved word wrapping message content when view width is small
- Enabled find widget in chat view
- Improved copy button icon color
- Improved UI style for backquotes, links, and code blocks
- Improved HTML/custom tag rendering in messages
- Improved editor text color and selection color for dark themes

### Fixed
- Most recent Instant Chat file not correctly identified
- Editor cursor might not be visible when using dark theme
- Done button not working for config editor

## [0.5.0] - 2024-07-11
### Added
- Support for showing the previously used provider at the top of the provider list when starting a new chat
- Configuration option for automatically selecting the previously used provider when starting a new chat
- Configuration option for customizing Instant Chat's session folder path

### Changed
- Important popups, such as the provider selection and API key input, will now persist even if the user clicks outside of them

### Fixed
- Improved stability of the OpenAI-compatible provider when streaming responses

## [0.4.4] - 2024-05-05
### Changed
- Improved editor scrolling behavior for a better composition experience
- Updated the press-down feedback for editor action buttons

## [0.4.3] - 2024-04-09
### Added
- Support for custom API URL for built-in Anthropic provider

### Fixed
- Issue where the context menu may not target the correct chat message on Windows and split view

## [0.4.2] - 2024-04-09
### Fixed
- Issue where the submit button did not work in the chat view

## [0.4.1] - 2024-04-08
### Changed
- Renamed the project from "FlowChat" to "ICE" (Integrated Conversational Environment)

### Reasons for the name change
- Avoid potential trademark conflicts with an existing commercial product named "FlowChat"

## [0.4.0] - 2024-04-08
### Added
- Message snippets for quickly inserting prompts

### Changed
- Improved color palette for better integration with VSCode themes
- Replaced plain text editor with feature-rich CodeMirror editor for better message composition experience

## [0.3.1] - 2024-04-02
### Fixed
- Chat providers not self-contained which prevented some providers from working

### Changed
- Improved Anthropic Claude provider's error handling
- OpenAI provider now has better compatibility with third-party API providers

## [0.3.0] - 2024-04-02
### Added
- Attachment support for chat messages

### Fixed
- Issue where the chat view would be reloaded when switching back from other panels

## [0.2.2] - 2024-03-29
### Fixed
- Issue where some tags were not rendered correctly in the chat view

## [0.2.1] - 2024-03-29
### Fixed
- Issue where custom tags were not being properly rendered in the chat view
- Configuration values with multiple lines are no longer displayed with extra spaces

## [0.2.0] - 2024-03-29
### Added
- Ability to quickly edit and switch between configurations in the chat view
- Instant Chat feature for quickly chatting with LLMs
- Google Gemini provider
- ZHIPU GLM provider

### Changed
- Improved configuration initialization experience
- Improved code block scrolling behavior
- Enhanced error handling and chat provider variable prompt logic

### Fixed
- Issue where empty assistant messages were not deleted when regenerating responses
- Display issues with configuration update cards for better readability

## [0.1.0] - 2024-03-23
### Added
- Initial release of ICE VSCode extension
- Basic chat functionality with OpenAI, Anthropic, and Poe providers
- Persist conversations as `.chat` YAML files
- Custom provider support
