# Custom Providers

ICE allows you to create custom providers to integrate additional LLMs or API services. This guide will walk you through the process of creating your own provider, from a simple example to more advanced implementations.

## Basic Structure

Custom providers in ICE are JavaScript files with a specific structure. They start with a metadata block and include a main process handler.

### Metadata Block

The metadata block defines the provider's properties and configuration:

```javascript
// ==ICEProvider==
// @name                My Custom Provider
// @version             1.0
// @description         A simple custom provider for ICE
// @author              Your Name
// @license             MIT
// @variableRequired    APIKey
// @variableOptional    Temperature=0.7
// ==/ICEProvider==
```

### Process Handler

The main logic of your provider is handled in a process message listener:

```javascript
process.on('message', (message) => {
  // Handle incoming messages here
});
```

## Simple Example: Echo Provider

Let's start with a simple provider that echoes the user's input:

```javascript
// ==ICEProvider==
// @name                Echo Provider
// @version             1.0
// @description         A simple provider that echoes user input
// @author              Your Name
// @license             MIT
// ==/ICEProvider==

process.on('message', (message) => {
  if (message.type === 'getCompletion') {
    const userMessage = message.messageTrail[message.messageTrail.length - 1].content;
    const response = `Echo: ${userMessage}`;
    
    process.send({
      type: 'done',
      requestID: message.requestID,
      finalText: response
    });
  }
});
```

This provider simply takes the last message from the user and echoes it back.

## Advanced Example: API Integration

Now, let's create a more advanced provider that integrates with an external API:

```javascript
// ==ICEProvider==
// @name                Weather API Provider
// @version             1.0
// @description         Provides weather information using a weather API
// @author              Your Name
// @license             MIT
// @variableRequired    APIKey
// @variableRequired    City
// ==/ICEProvider==

const https = require('https');

process.on('message', (message) => {
  if (message.type === 'getCompletion') {
    const config = message.config;
    const apiKey = config.APIKey;
    const city = config.City;

    const url = `https://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${city}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const weatherData = JSON.parse(data);
          const response = `Current weather in ${city}: ${weatherData.current.condition.text}, Temperature: ${weatherData.current.temp_c}°C`;

          process.send({
            type: 'done',
            requestID: message.requestID,
            finalText: response
          });
        } catch (error) {
          process.send({
            type: 'error',
            requestID: message.requestID,
            error: 'Failed to parse weather data'
          });
        }
      });
    }).on('error', (error) => {
      process.send({
        type: 'error',
        requestID: message.requestID,
        error: `Error fetching weather data: ${error.message}`
      });
    });
  }
});
```

This provider integrates with a weather API to provide current weather information for a specified city.

## Best Practices

1. **Error Handling**: Always include proper error handling to provide meaningful feedback to users.
2. **Configuration**: Use the metadata block to define required and optional variables.
3. **Async Operations**: For API calls or other asynchronous operations, ensure you're properly handling promises or callbacks.
4. **Security**: Never expose sensitive information like API keys in your provider code.

## Testing Your Provider

1. Save your provider script in the ICE providers directory.
2. Restart VSCode or reload the ICE extension.
3. Create a new chat and select your custom provider from the list.

## Advanced Topics

- **Streaming Responses**: Implement the `stream` message type for real-time responses.
- **Attachment Handling**: The `@_needAttachmentPreprocessing` and `@_attachmentFilter` metadata in the provider script allow for handling of file attachments. This enables multimodal interactions, such as image analysis or document processing, when supported by the underlying API.
- **Custom UI**: Utilize the `variableSecure` and `variableRequired` metadata for tailored configuration UI.

For more complex implementations, refer to the built-in providers in the ICE repository as examples.

## Note About Attachment Handling

ICE implements a default attachment handling mechanism for providers that don't explicitly support attachments. This behavior ensures maximum compatibility across different providers. Here's how it works:

1. **Path Resolution**: Attachment URLs are converted to absolute paths if they're not already in a valid format (data URLs or http URLs).

2. **Preprocessing Option**: Providers can opt out of attachment preprocessing by setting `_needAttachmentPreprocessing` to false in their metadata.

3. **Text File Handling**: For text files, the content is read and inserted directly into the message content, wrapped with the filename as XML-like tags.

4. **Binary File Handling**: Binary files are not sent directly. Instead, a placeholder message is inserted, and a warning is shown to the user.

5. **Base64 Encoded Data**: If an attachment is provided as a base64 encoded data URL, it's decoded before processing.

This default behavior allows for handling of text-based attachments across providers, while gracefully managing unsupported binary files. It ensures that even providers without native attachment support can work with text-based file content within the message context.

For providers that implement their own attachment handling (like the OpenAI Compatible provider example), this default preprocessing is skipped, allowing for more specialized handling of various file types, including images and other binary formats when supported by the underlying API.
