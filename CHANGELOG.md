# Change Log

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
