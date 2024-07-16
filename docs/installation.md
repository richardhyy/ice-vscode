# Installation

To install ICE:

1. Open Visual Studio Code.

2. Access the Extensions view:
   - Click on the Extensions icon in the Activity Bar on the side of the window, or
   - Use the keyboard shortcut: `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (macOS)

3. In the Extensions view search box, type "ICE".

4. Look for "ICE - Integrated Conversational Environment" in the list of extensions.

5. Click the "Install" button next to ICE.

6. Once installed, you may need to reload VSCode. Click "Reload" if prompted.

## API Keys

To use ICE with various LLM providers, you'll need to configure API keys:

1. The first time you use a provider, ICE will prompt you to enter the necessary API key(s).
![ICE prompts for API keys](images/promptforapikey.png)
2. Enter your API key when prompted.
3. ICE securely stores your API keys in VSCode's built-in secret storage.

> Note: Keep your API keys confidential. Never share them publicly.

## Verifying Installation

To verify that ICE is installed correctly:

1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on macOS).
2. Type "ICE" and look for ICE-related commands like "ICE: New Instant Chat".

If you see these commands, ICE is installed and ready to use.

----

For usage instructions, see the [Basic Usage](basic-usage.md) guide.