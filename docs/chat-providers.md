# Chat Providers

ICE supports multiple LLM providers out of the box, giving you flexibility in choosing the AI model that best suits your needs.

## Built-in Providers

- OpenAI (GPT models, e.g. GPT-3.5, GPT-4)
- Anthropic (Claude models, e.g. Claude-3 series, Claude-3.5-Sonnet)
- Google (Gemini models)
- ZHIPU AI (GLM models)
- Poe (Various models)

## Using Providers

1. Create a new `.chat` file or start an Instant Chat session.
2. Select your desired provider from the dropdown menu.
3. Enter your API key when prompted (first-time use only).

## Custom Providers

ICE allows you to create custom JavaScript-based providers for additional LLMs or API services. To add a custom provider:

1. Open the provider picker.
2. Click "Open Custom Provider Folder".
3. Paste your custom provider scripts (.js) into the "providers" directory.

For more information on creating custom providers, see [Custom Providers](custom-providers.md).

!> **Security Warning**: Chat providers can execute arbitrary code and may expose API keys to third parties. Only use providers from trusted sources, and always review the code before running.

## Switching Providers

You can switch between providers mid-conversation using inline configuration. This allows you to take advantage of the strengths of different models within a single chat session.
