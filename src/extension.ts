import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Provider, ProviderManager } from './providerManager';
import { ChatAction, ChatHistoryManager, ChatMessage } from './chatHistoryManager';
import html from '../webview/chatview.html';
import { InstantChatManager } from './instantChatManager';

let extensionContext: vscode.ExtensionContext;
let chatViewProvider: ChatViewProvider;
let instantChatManager: InstantChatManager;
let statusBarItem: vscode.StatusBarItem;

function postMessageToCurrentWebview(message: any) {
  if (chatViewProvider.activeWebview) {
    chatViewProvider.activeWebview.webview.postMessage(message);
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  chatViewProvider = new ChatViewProvider(context);
  instantChatManager = new InstantChatManager(context);

  context.subscriptions.push(vscode.commands.registerCommand('chat-view.open', openChatView));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('chat-view.editor', chatViewProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand('flowchat.instantChat.new', async () => {
      const chatFilePath = instantChatManager.createNewInstantChat();
      openChatView(vscode.Uri.file(chatFilePath));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('flowchat.instantChat.resume', async () => {
      const chatFilePath = instantChatManager.getLastInstantChat();
      if (chatFilePath) {
        openChatView(vscode.Uri.file(chatFilePath));
      } else {
        vscode.window.showInformationMessage('No previous instant chat found.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('flowchat.downloadProvider', async () => {
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
    await chatViewProvider.showProviderPicker();
  }));

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(comments-view-icon) Chat Provider';
  statusBarItem.command = 'chat-view.provider.open-panel';
  statusBarItem.tooltip = 'Configure FlowChat Chat Providers';
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

  // Handle undo/redo
  context.subscriptions.push(vscode.commands.registerCommand('chat-view.undo', async () => {
    postMessageToCurrentWebview({ type: 'undo' });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('chat-view.redo', async () => {
    postMessageToCurrentWebview({ type: 'redo' });
  }));
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

  async showProviderPicker() {
    const providers = await this.providerManager.getProviderIDs();
    const providerItems: ProviderQuickPickerItem[] = await Promise.all(
      providers.map(async (providerID) => {
        const provider = await this.providerManager.getProviderByID(providerID);
        if (provider) {
          return new ProviderQuickPickerItem(provider.info['name'] || provider.id, provider.info['description'] || '', provider.id, provider);
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
    }
  
    const selectedItem = await vscode.window.showQuickPick(items, {
      title: 'Select a chat provider',
      placeHolder: this.currentProvider?.info['name'] || 'No provider selected',
    });
  
    if (selectedItem) {
      if ('provider' in selectedItem) {
        const selectedProvider = selectedItem as ProviderQuickPickerItem;
        if (selectedProvider.provider) {
          if (selectedItem.label.startsWith('$(gear) Configure')) {
            await this.providerManager.openProviderConfig(this.currentProvider!.id);
          } else {
            this.currentProvider = selectedProvider.provider;
            const label = this.currentProvider.info['name'] || this.currentProvider.id;
            updateProviderStatusBar(label);
            postMessageToCurrentWebview({ type: 'selectProvider', providerID: this.currentProvider.id });
          }
        } else if (selectedItem.label === openCustomProviderFolderLabel) {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(customProviderFolder));
        } 
      }
    }
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

    const chatFilePath = document.uri.fsPath;
    const chatHistoryManager = new ChatHistoryManager(chatFilePath);
    
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'webview'))]
    };

    webviewPanel.onDidChangeViewState(e => {
      if (webviewPanel.active && webviewPanel.visible) {
        this.activeWebview = webviewPanel;
        (async () => {
          await this.loadChatHistory(webviewPanel, chatHistoryManager);
        })();
        statusBarItem.show();
      } else if (this.activeWebview === webviewPanel) {
        this.activeWebview = null;
        statusBarItem.hide();
      }
    });

    this.activeWebview = webviewPanel;
    statusBarItem.show();

    webviewPanel.webview.html = this.getWebViewContent(webviewPanel.webview);

    await this.loadChatHistory(webviewPanel, chatHistoryManager);

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
          const messageTrail: [ChatMessage] = message.messageTrail.filter((m: ChatMessage) => !m.role.startsWith('#'));
          const latestMessage = messageTrail[messageTrail.length - 1];

          if (providerID === undefined) {
            vscode.window.showErrorMessage('Please select a provider before sending a message.');
          }

          const provider = await this.providerManager.getProviderByID(providerID);

          if (!provider) {
            vscode.window.showErrorMessage(`Provider ${providerID} not found. Please select a different provider.`);
            break;
          }

          updateProviderStatusBar(provider?.info['name'] || provider?.id);

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
                messageTrail,
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
            } else {
              updateProviderStatusBar(message.providerID, 'Provider not found');
              this.currentProvider = null;
            }
          } else {
            vscode.commands.executeCommand('chat-view.provider.open-panel');
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
