# Change Log

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
