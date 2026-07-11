# Built-in Provider Configurations

ICE comes with several built-in providers, each with its own set of configuration options. Understanding these configurations allows you to fine-tune your interactions with different LLM providers. This guide will explain the common configuration variables using the OpenAI Compatible provider as an example.

## OpenAI Compatible Provider Configuration

The OpenAI Compatible provider is designed to work with OpenAI's API and similar services. Here are the key configuration variables:

### Required Variables

- `APIKey`: Your authentication key for the API service. Local presets such as **Ollama** and **LM Studio** don't need a key — enter any placeholder (for example `ollama`) if you're prompted for one.

- `Preset`: The API service to connect to. Rather than hand-assembling a host and path, pick a well-known OpenAI-compatible service and ICE fills in the correct endpoint for you. See [Presets](#presets) below.

- `Model`: The specific language model to use (e.g., `gpt-4o-mini`). Different models have different capabilities and performance characteristics. This field can list the models your endpoint advertises — pick one from the list, or type any model id.

- `MaxTokensToSample`: The maximum number of tokens the model should generate in its response. This helps control the length of the output.

- `SystemPrompt`: A prompt that sets the behavior or role of the AI assistant. This helps define the context and personality of the AI's responses.

### Presets

The `Preset` variable selects a well-known OpenAI-compatible service, so you no longer have to configure a host, path, and headers by hand. Just pick the service you use:

| Preset | Endpoint | API key |
| --- | --- | --- |
| `OpenAI` | `https://api.openai.com/v1` | Required |
| `Ollama` | `http://localhost:11434/v1` | Not needed (local) |
| `LM Studio` | `http://localhost:1234/v1` | Not needed (local) |
| `OpenRouter` | `https://openrouter.ai/api/v1` | Required |
| `Groq` | `https://api.groq.com/openai/v1` | Required |
| `DeepSeek` | `https://api.deepseek.com/v1` | Required |
| `Together` | `https://api.together.xyz/v1` | Required |
| `Mistral` | `https://api.mistral.ai/v1` | Required |
| `xAI` | `https://api.x.ai/v1` | Required |
| `Fireworks` | `https://api.fireworks.ai/inference/v1` | Required |
| `Perplexity` | `https://api.perplexity.ai` | Required |
| `Custom` | Set `BaseURL` yourself | Depends on service |

For any endpoint not listed — a self-hosted server, a proxy, or a new service — choose `Custom` and set the `BaseURL` optional variable (see below).

### Optional Variables

- `BaseURL`: The OpenAI-style base URL for your endpoint (e.g., `https://api.openai.com/v1`), including the version segment but *not* `/chat/completions`. This is used **only when `Preset` is `Custom`**. A recognized preset always supplies its own endpoint, so a leftover `BaseURL` can never silently shadow the service you picked. Setting `BaseURL` in the config menu automatically switches `Preset` to `Custom` so your endpoint takes effect.

- `Temperature`: A value between 0 and 1 that controls the randomness of the model's output. Higher values (e.g., 0.8) make the output more random, while lower values (e.g., 0.2) make it more focused and deterministic.

- `LogitBias`: A JSON object that allows you to adjust the likelihood of specific tokens appearing in the output. This can be used to encourage or discourage certain words or phrases.

- `AdditionalHeaders`: A JSON object specifying any additional HTTP headers to include in the API request. This can be useful for custom authentication schemes (e.g., OpenRouter's ranking headers) or other API-specific requirements.

## Understanding Configuration Variables

### API Configuration
- `APIKey`, `Preset`, and (optionally) `BaseURL` work together to establish the connection to the LLM service. The `Preset` picks a known endpoint and is authoritative when recognized; choose `Custom` and set `BaseURL` to point at your own service; `APIKey` authenticates the request. Local presets need no key.

### Model Behavior
- `Model` selects the specific AI model to use. Different models can have varying capabilities, knowledge cutoff dates, and performance characteristics.
- `SystemPrompt` sets the initial context for the AI, effectively giving it a "personality" or role to assume during the conversation.

### Output Control
- `MaxTokensToSample` limits the length of the AI's responses. This is useful for controlling costs and ensuring concise answers.
- `Temperature` affects the creativity and randomness of the output. Lower values are better for factual or predictable responses, while higher values can lead to more creative or diverse outputs.
- `LogitBias` allows fine-grained control over the model's token selection process, which can be used to guide the style or content of the output.

### Advanced Usage
- `BaseURL` (with `Preset` set to `Custom`) lets you point the provider at any OpenAI-compatible endpoint that isn't a built-in preset — a self-hosted server, a corporate proxy, or a brand-new service.
- `AdditionalHeaders` provides flexibility for working with different API implementations or adding custom metadata to requests.

## Best Practices

1. **API Key Security**: Always keep your `APIKey` secure and never share it publicly.

2. **Customization**: Experiment with different `SystemPrompt` values to tailor the AI's behavior to your specific use case.

3. **Performance Tuning**: Adjust `Temperature` and `MaxTokensToSample` to balance between response quality, length, and generation speed.

4. **Cost Management**: Be mindful of the `MaxTokensToSample` setting, as higher values can increase API usage and costs.

5. **Compatibility**: Pick the `Preset` that matches your service, or choose `Custom` and set `BaseURL` for anything else. Either way, make sure the `Model` you specify is offered by that service.

> **Upgrading from an older version?** The connection is now configured with `Preset` and `BaseURL` instead of `APIHost` and `APIPath`. Providers that used the default OpenAI endpoint keep working unchanged. If you previously pointed `APIHost` at a custom or self-hosted service, pick the matching preset (or `Custom` + `BaseURL`) once to restore it. Inline `#config` blocks that still set `APIHost`/`APIPath` continue to work.
