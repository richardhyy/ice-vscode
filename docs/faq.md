# Frequently Asked Questions (FAQ)

## General Questions

### Q: What is ICE and how is it different from other LLM chat interfaces?
A: ICE (Integrated Conversational Environment) is a VSCode extension that allows you to interact with various LLMs directly within your development environment. Unlike standalone chat interfaces, ICE integrates with your coding environment, supports multiple providers, and allows for advanced conversation management and editing.

### Q: Is ICE free to use?
A: Yes, ICE itself is free and open-source. However, you'll need your own API keys for the LLM providers you want to use, which may have associated costs.

## Setup and Configuration

### Q: How do I set up API keys for different providers?
A: When you first use a provider, ICE will prompt you to enter the necessary API key(s). These are securely stored in VSCode's built-in secret storage. You can also manage these in the extension settings.

### Q: Can I use ICE offline?
A: ICE requires an internet connection to communicate with LLM providers. However, you can view and edit saved `.chat` files offline.

### Q: How do I create a custom provider?
A: You can create custom providers using JavaScript. Check the [Custom Providers](custom-providers.md) guide for detailed instructions.

## Usage

### Q: How do I start a new chat?
A: You can either create a new `.chat` file in VSCode, or use the "ICE: Instant Chat" command from the Command Palette.

### Q: Can I use multiple LLM providers in the same conversation?
A: Yes, you can switch providers mid-conversation using inline configuration. This allows you to leverage different models' strengths within a single chat session.

### Q: How do I save my conversations?
A: Conversations are automatically saved as `.chat` files. Instant Chat sessions are saved in the configured Instant Chat Session Folder.

### Q: Can I edit past messages or AI responses?
A: Yes, you can edit both your messages and AI responses by right-clicking on a message and selecting "Edit".

## Features

### Q: What is forking and how do I use it?
A: Forking allows you to create alternative paths in a conversation. Right-click on a message and select "Duplicate" to create a new branch from that point.

### Q: How do message snippets work?
A: Message snippets are shortcuts for frequently used text. Create them by selecting text, right-clicking, and choosing "Create Snippet". Use them by typing `/` followed by the snippet name.

### Q: Can I use ICE with my team?
A: Yes, ICE's `.chat` files can be version-controlled and shared, making it great for team collaboration. However, each team member will need to set up their own API keys.

## Troubleshooting

### Q: What should I do if I'm getting API errors?
A: First, check that your API key is correct and has sufficient credits. If the problem persists, check the provider's status page for any ongoing issues.

### Q: ICE isn't working after an update. What should I do?
A: Try reloading VSCode. If the issue persists, check the GitHub issues page for any known problems with the latest version, or consider rolling back to a previous version temporarily.

### Q: Why am I getting errors with some built-in providers?
A: Some built-in providers, such as Anthropic and Poe, may not be fully up-to-date or thoroughly tested. This is because the project's main contributor has been denied service or faced prohibitively expensive subscription costs for these providers. As a result, these integrations might not work as expected. If you have access to these services and are willing to help, please consider testing and updating these providers. You can contribute your findings or improvements through the project's GitHub repository.

### Q: How can I report a bug or request a feature?
A: Please submit an issue on our GitHub repository. Be sure to provide as much detail as possible, including steps to reproduce for bugs.

## Privacy and Security

### Q: Is my conversation data stored anywhere besides my local machine?
A: ICE only stores conversation data locally as `.chat` files. However, remember that the content of your conversations is sent to the LLM providers' servers when you interact with them.

### Q: How secure are my API keys?
A: ICE uses VSCode's built-in secret storage to securely store your API keys.
