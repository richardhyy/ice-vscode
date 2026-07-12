# Chat Providers

ICE supports multiple LLM providers out of the box, giving you flexibility in choosing the AI model that best suits your needs.

## Built-in Providers

- VS Code Language Models (the models already available in VS Code, such as GitHub Copilot, with **no API key to enter**)
- OpenAI (GPT models, e.g. GPT-4o, GPT-4o mini)
- Anthropic (Claude models, e.g. Claude Sonnet 4.5, Claude Opus 4.1)
- Google (Gemini models, e.g. Gemini 2.5 Flash, Gemini 2.5 Pro)
- Poe (hundreds of models and bots through a single key)

## VS Code Language Models (no API key)

The **VS Code Language Models** provider talks to the models you already have inside VS Code, for example your GitHub Copilot subscription or any model contributed by another extension. VS Code owns the authentication, so there is nothing to paste: no API key, no endpoint.

- Select **VS Code Language Models** from the provider picker. The first time ICE sends a message, VS Code asks for your permission to use the model; choose **Allow**.
- Open the provider settings to pick a specific **Model** from the ones VS Code offers, or leave it blank to let ICE choose one for you. The list updates to match what you have installed and are signed in to.
- If the list is empty, sign in to GitHub Copilot (or install an extension that provides language models) and try again.
- Tool calling is supported, so this provider works with ICE's tools and MCP servers just like the others.

> This provider requires VS Code 1.95 or newer.

## Using Providers

1. Create a new `.chat` file or start an Instant Chat session.
2. Select your desired provider from the dropdown menu.
3. Enter your API key when prompted (first-time use only). The VS Code Language Models provider needs no key: VS Code manages access for you.

## Custom Providers

ICE allows you to create custom JavaScript-based providers for additional LLMs or API services. To add a custom provider:

1. Open the provider picker.
2. Click "Open Custom Provider Folder".
3. Paste your custom provider scripts (.js) into the "providers" directory.

For more information on creating custom providers, see [Custom Providers](custom-providers.md).

!> **Security Warning**: Chat providers can execute arbitrary code and may expose API keys to third parties. Only use providers from trusted sources, and always review the code before running.

## Switching Providers

You can switch between providers mid-conversation using inline configuration. This allows you to take advantage of the strengths of different models within a single chat session.
