// ==ICEProvider==
// @name                VS Code Language Models
// @version             1.0
// @description         Chat with the language models already available in VS Code, such as GitHub Copilot or models contributed by other extensions. VS Code manages the sign-in, so there is no API key to paste.
// @author              ICE
// @license             Apache-2.0
// @_runtime            vscode-lm
// @_needAttachmentPreprocessing  true
// @_attachmentFilter   { "Text & code": ["txt", "md", "markdown", "json", "yaml", "yml", "js", "ts", "jsx", "tsx", "py", "java", "c", "h", "cpp", "cs", "go", "rs", "rb", "php", "swift", "kt", "html", "css", "scss", "csv", "xml", "toml", "ini", "sh", "sql", "log"], "Others": ["*"] }
// @variableOptional    Model
// @variableRequired    SystemPrompt=You are a helpful assistant. Current date: {{ DATE_TODAY }}
// @variableOptional    Temperature
// @variableDynamic     Model
// @variableHelp        Model         Pick from the language models available in VS Code. The list depends on what you have installed and are signed in to (for example GitHub Copilot). Leave blank to let ICE choose one for you.
// @variableHelp        SystemPrompt  Sent as an initial instruction. VS Code language models have no separate system role, so this is delivered as the first message.
// @variableHelp        Temperature   Optional sampling temperature. Leave blank to use the model's default. Not every model honors this setting.
// @quickOption         Model
// @supportsTools       true
// ==/ICEProvider==

// This provider is special: it runs in-process inside the ICE extension host
// (see src/vscodeLmProvider.ts), not as a forked child process like the other
// providers. That is because VS Code's language model API (`vscode.lm`) is only
// available in the extension host, so the actual completion, option listing and
// cancellation are handled there.
//
// This file exists only to declare the configuration header above, which ICE
// parses statically to list and configure the provider. The guard below is
// defensive: if this script is ever launched as a child process by mistake, it
// answers requests with a clear error instead of hanging silently.
if (typeof process !== 'undefined' && typeof process.send === 'function') {
  const unavailable =
    'The "VS Code Language Models" provider runs inside the ICE extension host and cannot run as a separate process. Please update ICE.';

  process.on('message', (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    const requestID = message.requestID;
    if (message.type === 'getCompletion') {
      process.send({ type: 'error', requestID, error: unavailable });
    } else if (message.type === 'listOptions') {
      process.send({ type: 'optionsError', requestID, variableName: message.variableName, error: unavailable });
    }
  });
}
