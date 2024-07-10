import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as mime from 'mime-types';
const isBinaryFileSync = require("isbinaryfile").isBinaryFileSync;
import html from '../webview/chatview.html';
import { Provider, ProviderManager } from './providerManager';
import { Attachment, ChatAction, ChatHistoryManager, ChatMessage } from './chatHistoryManager';
import { InstantChatManager } from './instantChatManager';
import { SnippetManager } from './snippetManager';

let extensionContext: vscode.ExtensionContext;
let chatViewProvider: ChatViewProvider;
let instantChatManager: InstantChatManager;
let statusBarItem: vscode.StatusBarItem;
let snippetManager: SnippetManager;

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

  context.subscriptions.push(vscode.commands.registerCommand('chat-view.open', openChatView));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('chat-view.editor', chatViewProvider, {
    webviewOptions: {
      retainContextWhenHidden: true,
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

  // Register message handlers
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.duplicate', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'duplicate' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.delete', async () => {
    vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Are you sure you want to delete this message?' }).then((value) => {
      if (value === 'Yes') {
        postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'delete' });
      }
    });
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'delete' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.toggleEdit', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'toggleEdit' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.regenerate', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'regenerate' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.resend', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'resend' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.insertConfigUpdate.before', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'insertConfigUpdate', subOperation: 'before' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.insertConfigUpdate.after', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'insertConfigUpdate', subOperation: 'after' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.copy', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'copy' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.attachment.reveal', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'revealAttachment' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.attachment.remove', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'removeAttachment' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.message.editor.createSnippet', async () => {
    postMessageToCurrentWebview({ type: 'contextMenuOperation', operation: 'createSnippet' });
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
}

export function getConfigurationValue<T>(key: string): T | undefined {
  return vscode.workspace.getConfiguration('ice').get<T>(key);
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

const STATEKEY_PREVIOUS_PROVIDER_ID = 'chatView.previousProviderID';

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
    this.context.globalState.update(STATEKEY_PREVIOUS_PROVIDER_ID, this.currentProvider.id);
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
            await this.providerManager.openProviderConfig(this.currentProvider!.id);
          } else {
            this.selectProvider(selectedProvider.provider);
          }
        } else if (selectedItem.label === openCustomProviderFolderLabel) {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(customProviderFolder));
        } 
      }
    }
  }

  async loadSnippets(webviewPanel: vscode.WebviewPanel): Promise<void> {
    const snippets = snippetManager.getAllSnippets();
    webviewPanel.webview.postMessage({ type: 'loadSnippets', snippets: snippets });
  }

  private async loadChatHistory(webviewPanel: vscode.WebviewPanel, chatHistoryManager: ChatHistoryManager): Promise<void> {
    const actions: ChatAction[] = await chatHistoryManager.loadActionHistory();
    webviewPanel.webview.postMessage({ type: 'loadActions', actions: actions });
    console.log('actions', actions);
  }

  public async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => { } };
  }

  public async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
    await this.providerManager.loadProviders();

    if (!this.currentProvider) {
      // Load the previous provider if current provider is not set
      const previousProviderID = this.context.globalState.get<string>(STATEKEY_PREVIOUS_PROVIDER_ID);
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

    let providerExecuting: Provider | null = null;

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

          const messageTrail: [ChatMessage] = message.messageTrail.filter((m: ChatMessage) => !m.role.startsWith('#'));

          // Process the message attachments before passing to the provider
          const needPreprocess = (provider?.info['_needAttachmentPreprocessing'] || 'true') === 'true';
          let processedMessageTrail = messageTrail.map(message => {
            if (message.attachments) {
              message.attachments = message.attachments.map(attachment => {
                // Convert messages' attachment URLs to absolute path
                if (attachment.url.startsWith('data:') || attachment.url.startsWith('http')) {
                  return attachment;
                } else {
                  return {
                    ...attachment,
                    url: attachment.url.startsWith("http") || fs.existsSync(attachment.url) ? attachment.url : path.join(path.dirname(chatFilePath), attachment.url),
                  };
                }
              });
            }

            if (needPreprocess && message.attachments) {
              // A provider can opt out of attachment preprocessing by setting `_needAttachmentPreprocessing` to false
              // We assume the provider will handle the attachments by itself if it's set to false

              // Or, we can preprocess the attachments here to ensure maximum compatibility
              // Preprocess the attachment: skip binary files; read text files and insert into the message content
              for (const attachment of message.attachments) {
                let fileBuffer;

                if (attachment.url.startsWith('data:')) {
                  // Base64 encoded data
                  const base64Data = attachment.url.split(',')[1];
                  fileBuffer = Buffer.from(base64Data, 'base64');
                } else {
                  // Read text files
                  fileBuffer = fs.readFileSync(attachment.url);
                }

                const isBinary = isBinaryFileSync(fileBuffer);
                if (!isBinary) {
                  message.content = `<${attachment.name}>\n${fileBuffer}\n</${attachment.name}>\n${message.content}`;
                } else {
                  message.content = `<${attachment.name}>\nUnsupported attachment\n</${attachment.name}>\n${message.content}`;
                  vscode.window.showWarningMessage(`Attachment ${attachment.name} is a binary file and cannot be sent.`);
                }
              }

              delete message.attachments;
            }
            return message;
          });          
          const latestMessage = processedMessageTrail[processedMessageTrail.length - 1];

          let newMessage: ChatMessage = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            role: 'assistant',
            content: '',
            parentID: latestMessage.id,
            timestamp: new Date().toISOString(),
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
                (partialText: string) => {
                  // Streaming message from provider
                  console.log('stream', partialText);
                  newMessage.content += partialText;
                  webviewPanel.webview.postMessage({ type: 'updateMessage', message: newMessage, incomplete: true });
                  webviewPanel.webview.postMessage({ type: 'progress', text: 'Text Completion in Progress', cancelableRequestID: requestID });
                },
                async (finalText: string) => {
                  // Streaming completed
                  console.log('stream completed');
                  // Save the final message
                  if (finalText && finalText.trim()) {
                    newMessage.content = finalText;
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
        case 'selectProvider':
          let providerDisplay: Provider | undefined;
          if (message.providerID) {
            providerDisplay = await this.providerManager.getProviderByID(message.providerID);
            if (providerDisplay) {
              updateProviderStatusBar(providerDisplay.info['name'] || providerDisplay.id);
              this.currentProvider = providerDisplay;
              this.context.globalState.update(STATEKEY_PREVIOUS_PROVIDER_ID, this.currentProvider.id);
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
        case 'confirmAction':
          vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: message.message }).then((value) => {
            if (value === 'Yes') {
              webviewPanel.webview.postMessage(message.onConfirm);
            }
          });
          break;
        case 'setClipboard':
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.showInformationMessage('Copied to clipboard: ' + message.text.substr(0, 20) + (message.text.length > 20 ? '...' : ''));
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
          const newActionRedo = await chatHistoryManager.redo();
          if (newActionRedo) {
            webviewPanel.webview.postMessage({ type: 'appendAction', actions: [newActionRedo] });
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
          webviewPanel.webview.postMessage({ type: 'providerConfig', providerID: message.providerID, configKeys: providerEntity.configKeys });
          break;
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
