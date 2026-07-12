import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';
import html from '../webview/chatview.html';
import { Provider, ProviderManager, ProviderCompletionMeta } from './providerManager';
import { Attachment, ChatAction, ChatHistoryManager, ChatMessage } from './chatHistoryManager';
import { InstantChatManager } from './instantChatManager';
import { SnippetManager } from './snippetManager';
import { ROLE_ASSISTANT, STATE_KEY_PREVIOUS_PROVIDER_ID } from './constants';
import { preprocessAttachments, buildProviderMessageTrail, resolveEnabledTools, toolDefinitionsFromEnabled } from './messageProcessing';
import { ToolManager, ToolExecResult } from './toolManager';

/** Setting key holding the user's MCP server declarations (read by the MCP tool). */
const MCP_SERVERS_SETTING = 'ice.mcpServers';

/** A single MCP server declaration, as written under `ice.mcpServers`. */
interface McpServerConfig {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: { [key: string]: string };
  url?: string;
  headers?: { [key: string]: string };
}

let extensionContext: vscode.ExtensionContext;
let chatViewProvider: ChatViewProvider;
let instantChatManager: InstantChatManager;
let statusBarItem: vscode.StatusBarItem;
let snippetManager: SnippetManager;
let toolManager: ToolManager;
// Tool scripts the user has added from a file this session (absolute paths).
const extraToolSources = new Set<string>();

function postMessageToCurrentWebview(message: any) {
  if (chatViewProvider.activeWebview) {
    chatViewProvider.activeWebview.webview.postMessage(message);
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  snippetManager = new SnippetManager(context);
  chatViewProvider = new ChatViewProvider(context);
  instantChatManager = new InstantChatManager(context);

  // ICE's native tool substrate: tools are self-describing JS scripts run in
  // child processes (see ToolManager / tools/). MCP is not special — it is just
  // the built-in `MCP` dynamic-source tool, which owns the MCP SDK in its own
  // process and reads its servers from the `ice.mcpServers` setting.
  toolManager = new ToolManager(context);
  context.subscriptions.push({ dispose: () => toolManager.dispose() });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(MCP_SERVERS_SETTING)) {
        // The MCP tool re-reads the setting on demand; just refresh any open
        // composer tool picker so newly added/edited servers show up.
        postMessageToCurrentWebview({ type: 'availableToolsInvalidated' });
      }
      if (event.affectsConfiguration('ice.tools')) {
        postMessageToCurrentWebview({
          type: 'toolSettings',
          autoApprove: getConfigurationValue<boolean>('tools.autoApprove') === true,
          maxAutoIterations: getConfigurationValue<number>('tools.maxAutoIterations') ?? 8,
        });
      }
    })
  );

  context.subscriptions.push(vscode.commands.registerCommand('chat-view.open', openChatView));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('chat-view.editor', chatViewProvider, {
    webviewOptions: {
      retainContextWhenHidden: true,
      enableFindWidget: true,
    },
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('ice.instantChat.new', async () => {
      const chatFilePath = instantChatManager.createNewInstantChat();
      openChatView(vscode.Uri.file(chatFilePath));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ice.instantChat.resume', async () => {
      const chatFilePath = instantChatManager.getLastInstantChat();
      if (chatFilePath) {
        openChatView(vscode.Uri.file(chatFilePath));
      } else {
        vscode.window.showInformationMessage(
          `Could not find any previous Instant Chat sessions in ${instantChatManager.getInstantChatFolder()}`, 
          'Start New Instant Chat')
        .then((value) => {
          if (value === 'Start New Instant Chat') {
            vscode.commands.executeCommand('ice.instantChat.new');
          }
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ice.downloadProvider', async () => {
      const url = await vscode.window.showInputBox({ prompt: 'Enter provider URL' });
      if (url) {
        try {
          // await providerManager.downloadProvider(url);
          vscode.window.showInformationMessage('Provider downloaded successfully');
        } catch (e: any) {
          vscode.window.showErrorMessage('Failed to download provider: ' + e.message);
        }
      }
    })
  );

  context.subscriptions.push(vscode.commands.registerCommand('chat-view.provider.open-panel', async () => {
    await chatViewProvider.showProviderPicker(false);
  }));

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(comments-view-icon) Chat Provider';
  statusBarItem.command = 'chat-view.provider.open-panel';
  statusBarItem.tooltip = 'Configure ICE Chat Providers';
  context.subscriptions.push(statusBarItem);

  // Register simple context-menu commands that just forward an operation to the
  // active webview. Kept as a table to avoid repetitive registration boilerplate.
  const contextMenuCommands: { command: string; operation: string; subOperation?: string }[] = [
    { command: 'chat-view.message.fork', operation: 'fork' },
    { command: 'chat-view.message.toggleEdit', operation: 'toggleEdit' },
    { command: 'chat-view.message.regenerate', operation: 'regenerate' },
    { command: 'chat-view.message.resend', operation: 'resend' },
    { command: 'chat-view.message.insertConfigUpdate.before', operation: 'insertConfigUpdate', subOperation: 'before' },
    { command: 'chat-view.message.insertConfigUpdate.after', operation: 'insertConfigUpdate', subOperation: 'after' },
    { command: 'chat-view.message.copy', operation: 'copyRich' },
    { command: 'chat-view.message.copyMarkdown', operation: 'copyMarkdown' },
    { command: 'chat-view.message.copyPlainText', operation: 'copyPlainText' },
    { command: 'chat-view.message.select', operation: 'toggleSelect' },
    { command: 'chat-view.message.selectToHere', operation: 'selectToHere' },
    { command: 'chat-view.message.paste', operation: 'paste' },
    { command: 'chat-view.message.attachment.reveal', operation: 'revealAttachment' },
    { command: 'chat-view.message.attachment.remove', operation: 'removeAttachment' },
    { command: 'chat-view.message.editor.createSnippet', operation: 'createSnippet' },
  ];
  for (const { command, operation, subOperation } of contextMenuCommands) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      postMessageToCurrentWebview({ type: 'contextMenuOperation', operation, subOperation });
    }));
  }

  // "Paste Messages" from the command palette inserts at the end of the
  // conversation (the context-menu variant inserts after the clicked message).
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.paste', () => {
    postMessageToCurrentWebview({ type: 'pasteAtEnd' });
  }));

  // Deletion is confirmed with a lightweight inline prompt inside the webview
  // (and is undoable), so the command just forwards the operation.
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.delete', () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'delete' });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.editor.manageSnippets', async () => {
    await snippetManager.showSnippetPicker();

    if (chatViewProvider.activeWebview) {
      // Update the snippets in the chat view
      chatViewProvider.loadSnippets(chatViewProvider.activeWebview);
    }
  }));

  // Handle undo/redo
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.undo', async () => {
    postMessageToCurrentWebview({ type: 'undo' });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('chat-view.redo', async () => {
    postMessageToCurrentWebview({ type: 'redo' });
  }));

  // Enable tools for the current conversation from a QuickPick, inserting a
  // '#tools' node with the selection. A command-based alternative to the composer
  // Tools control. Built-in tools include the `MCP` dynamic source, so MCP server
  // tools appear here automatically once servers are configured.
  context.subscriptions.push(vscode.commands.registerCommand('ice.tools.enable', async () => {
    const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
    type ToolPick = vscode.QuickPickItem & { entry: any };
    const items: ToolPick[] = [];

    for (const identity of toolManager.listBuiltInTools()) {
      try {
        const definitions = await toolManager.resolveToolDefinitions(identity.source, undefined);
        for (const definition of definitions) {
          items.push({
            label: definition.name,
            description: definition.sourceLabel || 'built-in',
            detail: definition.description,
            entry: { source: identity.source, name: definition.name, ref: sanitize(definition.name), description: definition.description, inputSchema: definition.inputSchema, readOnly: definition.readOnly },
          });
        }
      } catch (error: any) {
        console.error(`Failed to load tool ${identity.source}:`, error && error.message);
      }
    }

    if (items.length === 0) {
      vscode.window.showInformationMessage('No tools available. Built-in tools ship with ICE; add MCP servers with "ICE: Add MCP Server".');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Enable tools for this conversation',
      placeHolder: 'Select the tools to offer the model',
      canPickMany: true,
    });
    if (!picked || picked.length === 0) {
      return;
    }
    postMessageToCurrentWebview({ type: 'insertToolsNode', enabled: picked.map((item) => item.entry) });
    vscode.window.showInformationMessage(`Enabled ${picked.length} tool(s) for this conversation.`);
  }));

  // Guided MCP server setup so users don't have to hand-write settings JSON.
  context.subscriptions.push(vscode.commands.registerCommand('ice.mcp.addServer', async () => {
    const presets = [
      { label: '$(beaker) Everything (demo & test server)', detail: 'Simple tools like echo and add — ideal for trying tool calling. Needs Node.', key: 'everything' },
      { label: '$(folder) Filesystem', detail: 'Read and write files under a folder you choose. Needs Node.', key: 'filesystem' },
      { label: '$(database) Memory', detail: 'A simple knowledge-graph memory store. Needs Node.', key: 'memory' },
      { label: '$(edit) Custom…', detail: 'Open settings.json to configure a server by hand.', key: 'custom' },
    ];
    const picked = await vscode.window.showQuickPick(presets, { title: 'Add an MCP server', placeHolder: 'Choose a server to add' });
    if (!picked) {
      return;
    }
    if (picked.key === 'custom') {
      await vscode.commands.executeCommand('workbench.action.openSettingsJson');
      return;
    }

    let serverConfig: McpServerConfig;
    if (picked.key === 'filesystem') {
      const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Expose this folder', title: 'Filesystem server: choose a folder to expose',
      });
      if (!folders || folders.length === 0) {
        return;
      }
      // Pin an exact version rather than floating `latest`: `npx` would otherwise
      // download and run whatever is newest at launch, so a compromised release
      // could execute with the user's privileges. Users can bump it in settings.
      serverConfig = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.7.10', folders[0].fsPath] };
    } else if (picked.key === 'memory') {
      serverConfig = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2026.7.4'] };
    } else {
      serverConfig = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything@2026.7.4'] };
    }

    // Merge into the user's servers under a unique name.
    const configuration = vscode.workspace.getConfiguration();
    const servers = { ...(configuration.get<{ [id: string]: McpServerConfig }>(MCP_SERVERS_SETTING) || {}) };
    let name = picked.key;
    for (let n = 2; servers[name]; n++) {
      name = `${picked.key}-${n}`;
    }
    servers[name] = serverConfig;
    await configuration.update(MCP_SERVERS_SETTING, servers, vscode.ConfigurationTarget.Global);

    // Verify by asking the MCP tool to list its tools (it connects on demand and
    // reads the setting we just wrote), then report how many the new server gave.
    const prefix = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
    try {
      const definitions = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to MCP server "${name}"…` },
        () => toolManager.resolveToolDefinitions('MCP', undefined)
      );
      const count = definitions.filter((definition) => definition.name.startsWith(prefix)).length;
      postMessageToCurrentWebview({ type: 'availableToolsInvalidated' });
      if (count > 0) {
        vscode.window.showInformationMessage(`Added "${name}" — ${count} tool(s) available. Open a chat and click Tools to enable them.`);
      } else {
        vscode.window.showWarningMessage(`Added "${name}", but no tools were found — it may have failed to connect. Check the extension host log and your settings.`);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Added "${name}", but listing its tools failed: ${error && error.message ? error.message : error}`);
    }
  }));
}

export function getConfigurationValue<T>(key: string): T | undefined {
  return vscode.workspace.getConfiguration('ice').get<T>(key);
}

/** Collects the tools the composer can offer: built-in, user file tools, and MCP. */
/** Collects the tools the composer can offer: built-in (incl. the MCP source) and user file tools. */
async function gatherAvailableTools(chatDir: string): Promise<any[]> {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const tools: any[] = [];
  const seenRefs = new Set<string>();

  const pushDefinitions = (source: string, sourceLabel: string, definitions: any[]) => {
    for (const definition of definitions) {
      const ref = sanitize(definition.name);
      // Defensive de-duplication: never surface the same tool twice even if a
      // source hands back duplicates.
      if (seenRefs.has(ref)) {
        continue;
      }
      seenRefs.add(ref);
      // A dynamic source (e.g. MCP) can label each tool with its own group and a
      // friendly display title.
      tools.push({ source, name: definition.name, ref, title: definition.title, description: definition.description, inputSchema: definition.inputSchema, readOnly: definition.readOnly, sourceLabel: definition.sourceLabel || sourceLabel });
    }
  };

  for (const identity of toolManager.listBuiltInTools()) {
    try {
      pushDefinitions(identity.source, 'built-in', await toolManager.resolveToolDefinitions(identity.source, chatDir));
    } catch (error: any) {
      console.error(`Failed to load tool ${identity.source}:`, error && error.message);
    }
  }

  for (const absolutePath of extraToolSources) {
    try {
      const relative = path.relative(chatDir, absolutePath);
      const source = !relative.startsWith('..') && !path.isAbsolute(relative) ? './' + relative : absolutePath;
      pushDefinitions(source, path.basename(absolutePath), await toolManager.resolveToolDefinitions(source, chatDir));
    } catch (error: any) {
      console.error(`Failed to load tool ${absolutePath}:`, error && error.message);
    }
  }

  return tools;
}

class ProviderQuickPickerItem implements vscode.QuickPickItem {
  kind?: vscode.QuickPickItemKind | undefined;
  
  constructor(public readonly label: string, public readonly description: string, public readonly detail: string | undefined, public readonly provider: Provider | undefined, kind?: vscode.QuickPickItemKind) {
    this.label = label;
    this.description = description;
    this.detail = detail;
    this.provider = provider;
    this.kind = kind;
  }
}

class QuickPickerSeparator implements vscode.QuickPickItem {
  kind?: vscode.QuickPickItemKind | undefined;

  constructor(public readonly label: string = '') { 
    this.label = label;
    this.kind = vscode.QuickPickItemKind.Separator;
  }
}

class ChatViewProvider implements vscode.CustomReadonlyEditorProvider {
  private readonly providerManager: ProviderManager;
  private currentProvider: Provider | null = null;
  activeWebview: vscode.WebviewPanel | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.providerManager = new ProviderManager(context);
  }

  selectProvider(provider: Provider) {
    this.currentProvider = provider;
    const label = this.currentProvider.info['name'] || this.currentProvider.id;
    updateProviderStatusBar(label);
    postMessageToCurrentWebview({ type: 'selectProvider', providerID: this.currentProvider.id });
    this.context.globalState.update(STATE_KEY_PREVIOUS_PROVIDER_ID, this.currentProvider.id);
  }

  async showProviderPicker(showPreviousProvider: boolean) {
    const providers = await this.providerManager.getProviderIDs();
    const providerItems: ProviderQuickPickerItem[] = await Promise.all(
      providers.map(async (providerID) => {
        const provider = await this.providerManager.getProviderByID(providerID);
        if (provider) {
          const label = (this.currentProvider?.id === provider.id ? '$(check) ' : '') + (provider.info['name'] || provider.id);
          return new ProviderQuickPickerItem(label, provider.info['name'] ? ` (${provider.id})` : '', provider.info['description'], provider);
        }
        return new ProviderQuickPickerItem(providerID, 'Provider not found', providerID, undefined);
      })
    );
  
    const items: vscode.QuickPickItem[] = providerItems.filter((item) => item.provider !== undefined);
  
    items.unshift({ kind: vscode.QuickPickItemKind.Separator, label: 'Available Providers' });

    // Option to open custom provider folder
    const customProviderFolder = path.join(this.context.globalStorageUri.fsPath, 'providers');
    const openCustomProviderFolderLabel = '$(file-directory) Open Custom Provider Folder';
    items.unshift({
      label: openCustomProviderFolderLabel,
      description: 'Open the custom provider folder',
      detail: undefined,
      provider: undefined,
    } as ProviderQuickPickerItem);

    if (this.currentProvider) {
      items.unshift({
        label: `$(gear) Configure ${this.currentProvider.info['name'] || this.currentProvider.id}`,
        description: 'Configure the current provider',
        detail: this.currentProvider.id,
        provider: this.currentProvider,
      } as ProviderQuickPickerItem);

      if (showPreviousProvider) {
        items.unshift(new QuickPickerSeparator());
        items.unshift({
          label: `$(arrow-right) ${this.currentProvider.info['name'] || this.currentProvider.id}`,
          description: 'Previously selected provider',
          detail: this.currentProvider.id,
          provider: this.currentProvider,
        } as ProviderQuickPickerItem);
      }
    }
  
    const selectedItem = await vscode.window.showQuickPick(items, {
      title: 'Select a chat provider',
      placeHolder: this.currentProvider?.info['name'] || 'No provider selected',
      ignoreFocusOut: true,
    });
  
    if (selectedItem) {
      if ('provider' in selectedItem) {
        const selectedProvider = selectedItem as ProviderQuickPickerItem;
        if (selectedProvider.provider) {
          if (selectedItem.label.startsWith('$(gear) Configure')) {
            await this.configureProvider(this.currentProvider!.id);
          } else {
            this.selectProvider(selectedProvider.provider);
          }
        } else if (selectedItem.label === openCustomProviderFolderLabel) {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(customProviderFolder));
        } 
      }
    }
  }

  /**
   * Opens the provider configuration menu (editing the provider's *global*
   * defaults) and, if anything changed, invites the active conversation to adopt
   * those changes. The invitation is surfaced inside the chat as a quiet notice
   * the user can apply (materialising a #config node) or dismiss, bridging the
   * global defaults and the per-conversation config without either silently
   * overriding the other.
   */
  async configureProvider(providerID: string) {
    const changes = await this.providerManager.openProviderConfig(providerID);
    if (this.activeWebview && changes && Object.keys(changes).length > 0) {
      this.activeWebview.webview.postMessage({ type: 'globalConfigChanged', providerID, changes });
    }
  }

  async loadSnippets(webviewPanel: vscode.WebviewPanel): Promise<void> {
    const snippets = snippetManager.getAllSnippets();
    webviewPanel.webview.postMessage({ type: 'loadSnippets', snippets: snippets });
  }

  private async loadChatHistory(webviewPanel: vscode.WebviewPanel, chatHistoryManager: ChatHistoryManager): Promise<void> {
    const actions: ChatAction[] = await chatHistoryManager.loadActionHistory();
    webviewPanel.webview.postMessage({ type: 'loadActions', actions: actions });
  }

  public async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => { } };
  }

  public async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
    showICECopyPasteIssueNotification(this.context);
    
    await this.providerManager.loadProviders();

    if (!this.currentProvider) {
      // Load the previous provider if current provider is not set
      const previousProviderID = this.context.globalState.get<string>(STATE_KEY_PREVIOUS_PROVIDER_ID);
      if (previousProviderID) {
        this.providerManager.getProviderByID(previousProviderID).then((provider) => {
          if (provider) {
            console.log('Previous provider found:', provider.id);
            this.currentProvider = provider;
            updateProviderStatusBar(provider.info['name'] || provider.id);
          } else {
            console.log('Previous provider not found:', previousProviderID);
          }
        });
      }
    }

    const chatFilePath = document.uri.fsPath;
    const chatHistoryManager = new ChatHistoryManager(chatFilePath);
    
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'webview'))]
    };

    webviewPanel.onDidChangeViewState(e => {
      if (webviewPanel.active && webviewPanel.visible) {
        this.activeWebview = webviewPanel;
        statusBarItem.show();

        this.loadSnippets(webviewPanel);
      } else if (this.activeWebview === webviewPanel) {
        this.activeWebview = null;
        statusBarItem.hide();
      }
    });

    this.activeWebview = webviewPanel;
    statusBarItem.show();

    webviewPanel.webview.html = this.getWebViewContent(webviewPanel.webview);

    // Check if the file exists
    if (!fs.existsSync(chatFilePath)) {
      webviewPanel.webview.postMessage({ type: 'showErrorOverlay', errorID: 'fileNotFound', detail: chatFilePath });
      return;
    }

    try {
      await this.loadChatHistory(webviewPanel, chatHistoryManager);
    } catch (e: any) {
      webviewPanel.webview.postMessage({ type: 'showErrorOverlay', errorID: 'corruptedChatFile', detail: e.message });
      return;
    }

    this.loadSnippets(webviewPanel);

    // Push the current tool settings so the webview's orchestration knows whether
    // to auto-approve tool calls and where the auto-continue loop cap sits.
    webviewPanel.webview.postMessage({
      type: 'toolSettings',
      autoApprove: getConfigurationValue<boolean>('tools.autoApprove') === true,
      maxAutoIterations: getConfigurationValue<number>('tools.maxAutoIterations') ?? 8,
    });

    let providerExecuting: Provider | null = null;
    // In-flight tool calls for this webview, so a `cancelTool` can abort the right
    // one and an elicitation response can be routed back to the awaiting call.
    const toolAborters = new Map<string, AbortController>();
    const toolElicitations = new Map<string, (response: { action: string; content?: any }) => void>();

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'addMessage':
          // Save the message
          await chatHistoryManager.addMessage(message.message);
          break;
        case 'sendMessage':
          const configOverride = message.config;
          const providerID = configOverride?.Provider || this.currentProvider?.id;

          if (providerID === undefined) {
            vscode.window.showErrorMessage('Please select a provider before sending a message.');
          }

          const provider = await this.providerManager.getProviderByID(providerID);

          if (!provider) {
            vscode.window.showErrorMessage(`Provider ${providerID} not found. Please select a different provider.`);
            break;
          }

          updateProviderStatusBar(provider?.info['name'] || provider?.id);

          // Drop meta messages before handing the trail to the provider.
          const messageTrail = buildProviderMessageTrail(message.messageTrail);

          // Resolve the tools enabled at this point (from '#tools' nodes) into the
          // provider-facing definitions the model is offered this turn.
          const enabledTools = resolveEnabledTools(message.messageTrail);
          const toolDefinitions = toolDefinitionsFromEnabled(enabledTools);

          // Process the message attachments before passing to the provider
          const needPreprocess = (provider?.info['_needAttachmentPreprocessing'] || 'true') === 'true';
          const processedMessageTrail = preprocessAttachments(messageTrail, chatFilePath, needPreprocess);
          const latestMessage = processedMessageTrail[processedMessageTrail.length - 1];

          // Snapshot the reply's metadata. `model` is a best-effort guess now
          // (the provider may report the real one on completion); `contextChecksum`
          // is computed by the webview over the exact context sent (see
          // sendMessage) so staleness can be detected after later edits. The
          // datetime is the message timestamp; config is derived from #config
          // nodes, so neither is duplicated here.
          const responseModel = configOverride?.Model || provider?.info?.['name'] || providerID;
          const replyMetadata: Record<string, any> = { model: responseModel };
          if (typeof message.contextChecksum === 'string') {
            replyMetadata.contextChecksum = message.contextChecksum;
          }

          let newMessage: ChatMessage = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            role: ROLE_ASSISTANT,
            content: '',
            parentID: latestMessage.id,
            timestamp: new Date().toISOString(),
            customFields: { metadata: replyMetadata },
          };

          await chatHistoryManager.addMessage(newMessage, false);

          webviewPanel.webview.postMessage({ type: 'updateMessage', message: newMessage, incomplete: true });
          webviewPanel.webview.postMessage({ type: 'progress', text: 'Sending Message' });

          if (provider) {
            try {
              providerExecuting = provider;
              const requestID = await provider.getCompletion(
                processedMessageTrail,
                configOverride,
                toolDefinitions,
                (partialText: string, reasoningText?: string) => {
                  // Streaming message from provider
                  if (reasoningText) {
                    newMessage.customFields = newMessage.customFields || {};
                    newMessage.customFields.reasoning = (newMessage.customFields.reasoning || '') + reasoningText;
                  }
                  newMessage.content += partialText;
                  webviewPanel.webview.postMessage({ type: 'updateMessage', message: newMessage, incomplete: true });
                  webviewPanel.webview.postMessage({ type: 'progress', text: 'Text Completion in Progress', cancelableRequestID: requestID });
                },
                async (finalText: string, meta?: ProviderCompletionMeta) => {
                  // Streaming completed. Fold in whatever the provider optionally
                  // reported (real model, token usage, any extra metadata) over the
                  // earlier best-effort snapshot.
                  newMessage.customFields = newMessage.customFields || {};
                  const metadata = (newMessage.customFields.metadata = newMessage.customFields.metadata || {});
                  if (meta?.extra && typeof meta.extra === 'object') {
                    Object.assign(metadata, meta.extra);
                  }
                  if (meta?.model) {
                    metadata.model = meta.model;
                  }
                  if (meta?.usage) {
                    metadata.usage = meta.usage;
                  }

                  // Persist any tool calls the model emitted so they render as
                  // editable blocks and can later be executed and answered.
                  if (meta?.toolCalls && meta.toolCalls.length > 0) {
                    newMessage.customFields.toolCalls = meta.toolCalls;
                  }
                  const hasToolCalls = Boolean(meta?.toolCalls && meta.toolCalls.length > 0);

                  if (meta?.error) {
                    // Record the failure on the reply itself so it is visible in the
                    // conversation and persisted to the .chat file, not just shown in
                    // a transient notification. Any partial content that streamed
                    // before the error is kept as-is, so the error is never mistaken
                    // for model output.
                    metadata.error = meta.error;
                    await chatHistoryManager.addMessage(newMessage);
                    webviewPanel.webview.postMessage({ type: 'updateMessage', message: newMessage });
                  } else if ((finalText && finalText.trim()) || hasToolCalls) {
                    // A tool-call turn can carry no text; still persist it so the
                    // call blocks are recorded and can be acted on.
                    if (finalText && finalText.trim()) {
                      newMessage.content = finalText;
                    }
                    await chatHistoryManager.addMessage(newMessage);
                    webviewPanel.webview.postMessage({ type: 'updateMessage', message: newMessage });
                  }
                  webviewPanel.webview.postMessage({ type: 'progress', text: undefined });

                  // Clear the provider executing
                  providerExecuting = null;
                }
              );
              webviewPanel.webview.postMessage({ type: 'progress', text: 'Waiting for Response', cancelableRequestID: requestID });
            } catch (e: any) {
              vscode.window.showErrorMessage('Error executing provider: ' + e.message);
              webviewPanel.webview.postMessage({ type: 'progress', text: undefined });
            }
          }

          break;
        case 'editMessage':
          await chatHistoryManager.editMessage(message.messageID, message.updates);
          break;
        case 'deleteMessage':
          await chatHistoryManager.deleteMessage(message.messageID);
          break;
        case 'beginTransaction':
          // Group the actions of a compound operation into a single undo step.
          chatHistoryManager.beginTransaction();
          break;
        case 'endTransaction':
          chatHistoryManager.endTransaction();
          break;
        case 'selectProvider':
          let providerDisplay: Provider | undefined;
          if (message.providerID) {
            providerDisplay = await this.providerManager.getProviderByID(message.providerID);
            if (providerDisplay) {
              updateProviderStatusBar(providerDisplay.info['name'] || providerDisplay.id);
              this.currentProvider = providerDisplay;
              this.context.globalState.update(STATE_KEY_PREVIOUS_PROVIDER_ID, this.currentProvider.id);
            } else {
              updateProviderStatusBar(message.providerID, 'Provider not found');
              this.currentProvider = null;
            }
          } else {
            // No provider selected, show the provider picker
            if (getConfigurationValue('usePreviousProviderForNewChat') === true && this.currentProvider) {
              // Use the previous provider for new chat
              this.selectProvider(this.currentProvider);
            } else {
              // Show the previously selected provider for quick access
              this.showProviderPicker(true);
            }
          }
          break;
        case 'setClipboard':
          await vscode.env.clipboard.writeText(message.text);
          if (message.label) {
            vscode.window.showInformationMessage(message.label);
          } else {
            vscode.window.showInformationMessage('Copied to clipboard: ' + message.text.substr(0, 20) + (message.text.length > 20 ? '...' : ''));
          }
          break;
        case 'readClipboard':
          const clipboardText = await vscode.env.clipboard.readText();
          webviewPanel.webview.postMessage({ type: 'clipboardContent', requestID: message.requestID, text: clipboardText });
          break;
        case 'error':
          vscode.window.showErrorMessage(message.error);
          break;
        case 'undo':
          const newActions = await chatHistoryManager.undo();
          if (newActions) {
            webviewPanel.webview.postMessage({ type: 'loadActions', actions: newActions });
          } else {
            console.log('No actions to undo');
          }
          break;
        case 'redo':
          const redoneActions = await chatHistoryManager.redo();
          if (redoneActions) {
            webviewPanel.webview.postMessage({ type: 'appendAction', actions: redoneActions });
          } else {
            console.log('No actions to redo');
          }
          break;
        case 'selectAttachment':
          const targetProviderID = message.providerID || this.currentProvider?.id;
          const targetProvider = await this.providerManager.getProviderByID(targetProviderID);
          let filter = undefined;
          if (targetProvider && targetProvider.info['_attachmentFilter']) {
            filter = JSON.parse(targetProvider.info['_attachmentFilter']);
          }

          const attachmentPath = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: 'Select',
            filters: filter,
          });
          if (attachmentPath && attachmentPath.length > 0) {
            let attachmentMetas = [];

            for (const attachment of attachmentPath) {
              const basename = path.basename(attachment.fsPath);
              const dirname = path.dirname(attachment.fsPath);
              let meta: Attachment = {
                id: Date.now() * 100 + Math.floor(Math.random() * 100),
                name: basename,
                url: '',
              };
              
              if (!dirname.startsWith(path.dirname(chatFilePath))) { // Check if the attachment is outside the current folder
                // Prompt the user to for copy to `.chat/attachments` folder, or save the absolute path, or save the BASE64 encoded data in the chat file
                const action = await vscode.window.showQuickPick(
                  ['Copy to ./.chat/attachments', 'Save Absolute Path', 'Save BASE64 Encoded Data', 'Skip'],
                  { 
                    placeHolder: 'Select an action for the attachment',
                    title: `${basename} is outside the chat folder`,
                    ignoreFocusOut: true,
                  }
                );
                if (action === 'Copy to ./.chat/attachments') {
                  const attachmentFolder = path.join(path.dirname(chatFilePath), '.chat', 'attachments', path.basename(chatFilePath, '.chat'));
                  if (!fs.existsSync(attachmentFolder)) {
                    fs.mkdirSync(attachmentFolder, { recursive: true });
                  }
                  const newAttachmentPath = path.join(attachmentFolder, basename);
                  fs.copyFileSync(attachment.fsPath, newAttachmentPath);

                  // Update the final URL to the new and relative path
                  meta.url = path.relative(path.dirname(chatFilePath), newAttachmentPath);
                } else if (action === 'Save Absolute Path') {
                  // Save the absolute path
                  meta.url = attachment.fsPath;
                } else if (action === 'Save BASE64 Encoded Data') {
                  // Save the BASE64 encoded data
                  const fileMimeType = mime.lookup(attachment.fsPath) || 'application/octet-stream';
                  const encoded = fs.readFileSync(attachment.fsPath).toString('base64');
                  meta.url = `data:${fileMimeType};base64,${encoded}`;
                } else {
                  // Skip the attachment
                  continue;
                }
              } else {
                // Save the relative path
                meta.url = path.relative(path.dirname(chatFilePath), attachment.fsPath);
              }
              attachmentMetas.push(meta);
            }

            webviewPanel.webview.postMessage({ type: 'addAttachments', messageID: message.messageID, attachmentMetas: attachmentMetas });
          }
          break;
        case 'revealFile':
          let revealPath = message.path;
          if (!path.isAbsolute(revealPath)) {
            revealPath = path.join(path.dirname(chatFilePath), revealPath);
          }
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(revealPath));
          break;
        case 'cancelRequest':
          if (providerExecuting) {
            await providerExecuting.requestCancel(message.requestID);
            providerExecuting = null;
          }
          break;
        case 'fetchProviderIDs':
          const providerIDs = await this.providerManager.getProviderIDs();
          webviewPanel.webview.postMessage({ type: 'providerIDs', providerIDs: providerIDs });
          break;
        case 'fetchProviderConfig':
          const providerEntity = await this.providerManager.getProviderByID(message.providerID);
          if (!providerEntity) {
            vscode.window.showErrorMessage(`Provider ${message.providerID} not found.`);
            break;
          }
          webviewPanel.webview.postMessage({ type: 'providerConfig', providerID: message.providerID, configKeys: providerEntity.configKeys, options: providerEntity.options, defaults: await this.providerManager.getNonSecretDefaults(message.providerID) });
          break;
        case 'fetchProviderOptions': {
          // Ask a provider to list selectable values for a config variable (e.g.
          // available models). Runs off the webview's request id so several
          // controls can resolve independently; errors are reported back so the
          // control can fall back to its static options.
          const optionsProvider = await this.providerManager.getProviderByID(message.providerID);
          if (!optionsProvider) {
            webviewPanel.webview.postMessage({ type: 'providerOptions', requestID: message.requestID, variableName: message.variableName, error: `Provider ${message.providerID} not found.` });
            break;
          }
          try {
            const options = await optionsProvider.listOptions(message.variableName, message.config || {});
            webviewPanel.webview.postMessage({ type: 'providerOptions', requestID: message.requestID, providerID: message.providerID, variableName: message.variableName, options });
          } catch (e: any) {
            webviewPanel.webview.postMessage({ type: 'providerOptions', requestID: message.requestID, providerID: message.providerID, variableName: message.variableName, error: e.message });
          }
          break;
        }
        case 'executeTool': {
          // Every tool runs through the tool substrate. New enabled entries name a
          // `source` (for MCP tools, the `MCP` dynamic source). Older chats stored
          // MCP calls with `server`/`toolName` instead, translated into a call on
          // the MCP source so they keep working.
          const sanitize = (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
          const chatDir = path.dirname(chatFilePath);
          const requestID: string = message.requestID;

          // Wire this call's live capabilities: a cancellation signal the webview's
          // Stop drives, progress relayed to the call's block, and elicitation
          // requests surfaced as an in-conversation form whose answer flows back.
          const controller = new AbortController();
          if (requestID) {
            toolAborters.set(requestID, controller);
          }
          const timeoutSeconds = getConfigurationValue<number>('tools.timeoutSeconds') ?? 60;
          const execOptions = {
            signal: controller.signal,
            timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
            onProgress: (progress: any) => {
              webviewPanel.webview.postMessage({ type: 'toolProgress', requestID, progress });
            },
            onElicit: (request: { elicitationID: string; message: string; schema: any }) => {
              return new Promise<{ action: string; content?: any }>((resolveElicit) => {
                toolElicitations.set(requestID + ':' + request.elicitationID, resolveElicit);
                webviewPanel.webview.postMessage({
                  type: 'toolElicit',
                  requestID,
                  elicitationID: request.elicitationID,
                  message: request.message,
                  schema: request.schema,
                });
              });
            },
          };

          let result: ToolExecResult;
          if (message.source) {
            result = await toolManager.execute(message.source, message.toolName || null, message.arguments || {}, chatDir, execOptions);
          } else if (message.server) {
            const qualified = `${sanitize(message.server)}__${sanitize(message.toolName)}`;
            result = await toolManager.execute('MCP', qualified, message.arguments || {}, chatDir, execOptions);
          } else {
            result = { content: `Tool call had no source: ${message.toolName || ''}`, isError: true };
          }

          if (requestID) {
            toolAborters.delete(requestID);
            for (const key of [...toolElicitations.keys()]) {
              if (key.startsWith(requestID + ':')) {
                toolElicitations.delete(key);
              }
            }
          }

          webviewPanel.webview.postMessage({
            type: 'toolResult',
            requestID,
            isError: result.isError,
            text: result.content,
            stopped: result.stopped,
            timedOut: result.timedOut,
          });
          break;
        }
        case 'cancelTool': {
          const controller = message.requestID && toolAborters.get(message.requestID);
          if (controller) {
            controller.abort();
          }
          break;
        }
        case 'toolElicitResult': {
          const key = message.requestID + ':' + message.elicitationID;
          const resolveElicit = toolElicitations.get(key);
          if (resolveElicit) {
            toolElicitations.delete(key);
            resolveElicit({ action: message.action || 'cancel', content: message.content });
          }
          break;
        }
        case 'fetchAvailableTools': {
          const availableTools = await gatherAvailableTools(path.dirname(chatFilePath));
          webviewPanel.webview.postMessage({ type: 'availableTools', tools: availableTools });
          break;
        }
        case 'openAddMcpServer':
          await vscode.commands.executeCommand('ice.mcp.addServer');
          break;
        case 'removeMcpServer': {
          // Remove a configured MCP server from wherever it is declared. The
          // config watcher then refreshes the composer's tool list.
          const serverId = message.server;
          if (!serverId) {
            break;
          }
          const confirm = await vscode.window.showWarningMessage(
            `Remove the MCP server "${serverId}" from your settings?`,
            { modal: true },
            'Remove'
          );
          if (confirm !== 'Remove') {
            break;
          }
          const configuration = vscode.workspace.getConfiguration();
          const inspected = configuration.inspect<{ [id: string]: McpServerConfig }>(MCP_SERVERS_SETTING);
          const removeFrom = async (value: { [id: string]: McpServerConfig } | undefined, target: vscode.ConfigurationTarget) => {
            if (value && Object.prototype.hasOwnProperty.call(value, serverId)) {
              const next = { ...value };
              delete next[serverId];
              await configuration.update(MCP_SERVERS_SETTING, next, target);
            }
          };
          await removeFrom(inspected?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
          await removeFrom(inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace);
          await removeFrom(inspected?.globalValue, vscode.ConfigurationTarget.Global);
          // Refresh immediately (the watcher also fires, but this is snappier).
          const afterRemoval = await gatherAvailableTools(path.dirname(chatFilePath));
          webviewPanel.webview.postMessage({ type: 'availableTools', tools: afterRemoval });
          break;
        }
        case 'addToolFromFile': {
          // Let the user add a tool script from anywhere (e.g. next to their .chat).
          const files = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectMany: false, filters: { JavaScript: ['js'] },
            openLabel: 'Add tool', title: 'Add a tool from a JavaScript file',
          });
          if (files && files.length > 0) {
            const absolutePath = files[0].fsPath;
            try {
              const definitions = await toolManager.resolveToolDefinitions(absolutePath, path.dirname(chatFilePath));
              if (definitions.length === 0) {
                throw new Error('No tool found in the file.');
              }
              extraToolSources.add(absolutePath);
            } catch (error: any) {
              vscode.window.showErrorMessage(`Could not add tool: ${error && error.message ? error.message : error}`);
            }
          }
          const refreshed = await gatherAvailableTools(path.dirname(chatFilePath));
          webviewPanel.webview.postMessage({ type: 'availableTools', tools: refreshed });
          break;
        }
        case 'createSnippet':
          if (!message.content) {
            vscode.window.showErrorMessage('Select text to create a snippet.');
            break;
          }
          const snippetText = message.content;
          await snippetManager.createSnippet(snippetText);
          this.loadSnippets(webviewPanel);
          break;
        case 'contextMenu':
          // Set the current active webview to the one that sent the context menu event
          this.activeWebview = webviewPanel;
          break;
      }
    });
  }

  getWebViewContent(webview: vscode.Webview) {
    return html
      .replace(/{{root}}/g, webview.asWebviewUri(vscode.Uri.file(path.join(extensionContext.extensionPath, 'webview'))).toString());
  }
}

function openChatView(uri?: vscode.Uri) {
  if (uri) {
    vscode.commands.executeCommand('vscode.openWith', uri, 'chat-view.editor');
  }
}

function updateProviderStatusBar(label: string | undefined, error?: string) {
  if (label) {
    statusBarItem.text = '$(comments-view-icon) ' + label;
  } else {
    statusBarItem.text = '$(comments-view-icon) No Chat Provider Selected';
  }

  statusBarItem.backgroundColor = error ? new vscode.ThemeColor('errorForeground') : undefined;
  statusBarItem.tooltip = error || label || 'No provider selected';
}

function showICECopyPasteIssueNotification(context: vscode.ExtensionContext) {
  const version = vscode.version;
  const [major, minor] = version.split('.').map(Number);
  const isVSCodeVersionAffected = major === 1 && minor <= 91;

  const NOTIFICATION_INTERVAL = 4 * 24 * 60 * 60 * 1000; // 4 days
  const CONFIG_KEY = 'ice.lastCopyPasteNotificationTime';

  const lastNotificationTime = context.globalState.get(CONFIG_KEY, 0);
  const currentTime = Date.now();
  const shouldShowNotification = currentTime - lastNotificationTime >= NOTIFICATION_INTERVAL;

  if (isVSCodeVersionAffected && shouldShowNotification) {
    const message = 'Ctrl+C/V (or Command+C/V) for copy/paste may not work after using the context menu in ICE. This is a known VSCode issue that will be fixed in a future update. To resolve, click outside the chat view and then back inside.';
    
    vscode.window.showInformationMessage(message, 'Got it')
      .then(() => {
        context.globalState.update(CONFIG_KEY, Date.now());
      });
  }
}
