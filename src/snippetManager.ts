import * as vscode from 'vscode';

export class SnippetManager {
  private readonly snippetsKey = 'flowchat.snippets';

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getSnippets(): { [completion: string]: string } {
    const snippetsJson = this.context.globalState.get(this.snippetsKey) as string | undefined;
    return snippetsJson ? JSON.parse(snippetsJson) : {};
  }

  private saveSnippets(snippets: { [completion: string]: string }): void {
    this.context.globalState.update(this.snippetsKey, JSON.stringify(snippets));
  }

  public async createSnippet(snippetText: string): Promise<void> {
    if (snippetText.trim().length === 0) {
      vscode.window.showErrorMessage('Snippet cannot be empty');
      return;
    }

    const snippets = this.getSnippets();

    const completionText = await vscode.window.showInputBox({
      prompt: `Enter the completion text for the snippet: ${snippetText.replace(/\n/g, ' ').substring(0, 20) + (snippetText.length > 20 ? '...' : '')}`,
      validateInput: (value: string) => {
        if (value.trim().length === 0) {
          return 'Completion text cannot be empty';
        }
        if (snippets[value]) {
          return 'Completion text already exists';
        }
        return null;
      },
    });

    if (completionText) {
      snippets[completionText] = snippetText;
      this.saveSnippets(snippets);
      vscode.window.showInformationMessage(`Snippet created successfully. Type \`/${completionText}\` to insert the snippet`);
    }
  }

  public async showSnippetPicker(): Promise<void> {
    const snippets = this.getAllSnippets();
    const snippetItems: vscode.QuickPickItem[] = Object.entries(snippets).map(([completion, snippet]) => ({
      label: completion,
      detail: snippet,
    }));

    const newSnippetItem: vscode.QuickPickItem = {
      label: '$(add) Create New Snippet',
      alwaysShow: true,
    };

    const selectedItem = await vscode.window.showQuickPick([...snippetItems, newSnippetItem], {
      placeHolder: 'Select a snippet to edit or create a new snippet',
    });

    if (selectedItem) {
      if (selectedItem === newSnippetItem) {
        // Create a new snippet
        const snippetText = await vscode.window.showInputBox({
          prompt: 'Enter the snippet text',
          validateInput: (value: string) => {
            if (value.trim().length === 0) {
              return 'Snippet text cannot be empty';
            }
            return null;
          }
        });

        if (snippetText) {
          await this.createSnippet(snippetText);
        }
      } else {
        // Show second level menu for editing or deleting the selected snippet
        const selectedSnippet = selectedItem.label;
        const actions: vscode.QuickPickItem[] = [
          { label: '$(edit) Edit Snippet' },
          { label: '$(trash) Delete Snippet' },
        ];

        const selectedAction = await vscode.window.showQuickPick(actions, {
          placeHolder: `Selected Snippet: ${selectedSnippet}`,
        });

        if (selectedAction) {
          if (selectedAction.label === '$(edit) Edit Snippet') {
            // Edit the selected snippet
            const updatedSnippetText = await vscode.window.showInputBox({
              prompt: 'Update the snippet text',
              value: selectedItem.detail,
            });

            if (updatedSnippetText) {
              await this.updateSnippet(selectedSnippet, updatedSnippetText);
            }
          } else if (selectedAction.label === '$(trash) Delete Snippet') {
            // Delete the selected snippet
            await this.deleteSnippet(selectedSnippet);
          }
        }
      }
    }
  }

  private async updateSnippet(completionText: string, updatedSnippetText: string): Promise<void> {
    const snippets = this.getSnippets();
    if (snippets[completionText]) {
      snippets[completionText] = updatedSnippetText;
      this.saveSnippets(snippets);
      vscode.window.showInformationMessage('Snippet updated successfully');
    } else {
      vscode.window.showErrorMessage('Snippet not found');
    }
  }

  public getSnippet(completionText: string): string | undefined {
    const snippets = this.getSnippets();
    return snippets[completionText];
  }

  public getAllSnippets(): { [completion: string]: string } {
    return this.getSnippets();
  }

  public async deleteSnippet(completionText: string): Promise<void> {
    const snippets = this.getSnippets();
    if (snippets[completionText]) {
      delete snippets[completionText];
      this.saveSnippets(snippets);
      vscode.window.showInformationMessage('Snippet deleted successfully');
    } else {
      vscode.window.showErrorMessage('Snippet not found');
    }
  }
}
