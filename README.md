# FlowChat 

FlowChat is a flexible, easy-to-use VSCode extension that allows users to experiment with conversational AI using various large language models (LLMs). With FlowChat, you can easily chat with LLMs, manage conversation histories, and even create custom LLM integrations.

## Features

- Chat with built-in LLM providers (API keys required):
  - OpenAI
  - Anthropic
  - Poe
- Persist chat histories as `.chat` files (YAML format) 
  - Easily manage and share conversations
  - Add chat histories to version control
- Fork conversations to explore different paths
  - Edit both user and LLM messages
  - Changes are saved to the `.chat` file
- Create custom LLM providers using JavaScript
- Configure API keys and settings for built-in providers

## Requirements

To use FlowChat with the built-in LLM providers, you'll need to provide your own API keys. When you send your first message, FlowChat will prompt you to enter the necessary configuration details.

## Extension Settings

FlowChat exposes the following configuration options:

- `flowchat.openai.apiKey`: Your OpenAI API key
- `flowchat.anthropic.apiKey`: Your Anthropic API key
- `flowchat.poe.apiKey`: Your Poe API key

You can also view the script for a built-in provider by clicking the provider name in the VSCode status bar, selecting "Configure", and then "Open Provider Script".

## Creating Custom Providers

FlowChat supports custom LLM providers written in JavaScript. Provider scripts use a format similar to Tampermonkey to declare configuration entries. 

_(Include example provider script if available)_

## Known Issues

As FlowChat is in early development, you may encounter bugs or instability. If you experience any issues, please file a report on the GitHub repository. Pull requests are also welcome!

## Planned Enhancements

- In context updating of provider configuration
- Search, tagging, and filtering of chat histories
- Visualization of conversation trees
- Rendering performance optimizations
- UI improvements

## Release Notes

### 0.1.0

- Initial release of FlowChat
- Basic chat functionality with OpenAI, Anthropic, and Poe providers
- Persist conversations as `.chat` YAML files
- Custom provider support

---

## Contributing

If you'd like to contribute to FlowChat, please submit a pull request on GitHub. For major changes, please open an issue first to discuss the proposed changes.

**Enjoy using FlowChat to explore the world of conversational AI!**
