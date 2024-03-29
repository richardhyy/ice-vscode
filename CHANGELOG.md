# Change Log

All notable changes to the "flowchat" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
- Initial release of FlowChat VSCode extension
- Basic chat functionality with OpenAI, Anthropic, and Poe providers
- Persist conversations as `.chat` YAML files
- Custom provider support
