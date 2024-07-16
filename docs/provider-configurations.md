# Built-in Provider Configurations

ICE comes with several built-in providers, each with its own set of configuration options. Understanding these configurations allows you to fine-tune your interactions with different LLM providers. This guide will explain the common configuration variables using the OpenAI Compatible provider as an example.

## OpenAI Compatible Provider Configuration

The OpenAI Compatible provider is designed to work with OpenAI's API and similar services. Here are the key configuration variables:

### Required Variables

- `APIKey`: Your authentication key for the API service. This is crucial for accessing the LLM.

- `APIHost`: The hostname of the API server (e.g., `api.openai.com`). This allows you to use alternative hosts that are compatible with the OpenAI API format.

- `APIPath`: The specific endpoint path for chat completions (e.g., `/v1/chat/completions`). This may vary depending on the API service you're using.

- `Model`: The specific language model to use (e.g., `gpt-3.5-turbo`). Different models have different capabilities and performance characteristics.

- `MaxTokensToSample`: The maximum number of tokens the model should generate in its response. This helps control the length of the output.

- `SystemPrompt`: A prompt that sets the behavior or role of the AI assistant. This helps define the context and personality of the AI's responses.

### Optional Variables

- `Temperature`: A value between 0 and 1 that controls the randomness of the model's output. Higher values (e.g., 0.8) make the output more random, while lower values (e.g., 0.2) make it more focused and deterministic.

- `LogitBias`: A JSON object that allows you to adjust the likelihood of specific tokens appearing in the output. This can be used to encourage or discourage certain words or phrases.

- `AdditionalHeaders`: A JSON object specifying any additional HTTP headers to include in the API request. This can be useful for custom authentication schemes or other API-specific requirements.

## Understanding Configuration Variables

### API Configuration
- `APIKey`, `APIHost`, and `APIPath` work together to establish the connection to the LLM service. They determine where the requests are sent and how they're authenticated.

### Model Behavior
- `Model` selects the specific AI model to use. Different models can have varying capabilities, knowledge cutoff dates, and performance characteristics.
- `SystemPrompt` sets the initial context for the AI, effectively giving it a "personality" or role to assume during the conversation.

### Output Control
- `MaxTokensToSample` limits the length of the AI's responses. This is useful for controlling costs and ensuring concise answers.
- `Temperature` affects the creativity and randomness of the output. Lower values are better for factual or predictable responses, while higher values can lead to more creative or diverse outputs.
- `LogitBias` allows fine-grained control over the model's token selection process, which can be used to guide the style or content of the output.

### Advanced Usage
- `AdditionalHeaders` provides flexibility for working with different API implementations or adding custom metadata to requests.

## Best Practices

1. **API Key Security**: Always keep your `APIKey` secure and never share it publicly.

2. **Customization**: Experiment with different `SystemPrompt` values to tailor the AI's behavior to your specific use case.

3. **Performance Tuning**: Adjust `Temperature` and `MaxTokensToSample` to balance between response quality, length, and generation speed.

4. **Cost Management**: Be mindful of the `MaxTokensToSample` setting, as higher values can increase API usage and costs.

5. **Compatibility**: When using alternative API hosts, ensure that the `Model` specified is supported by that service.
