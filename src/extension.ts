import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';


// Utility class to manage the .hydra_helper Python helper file
class PythonHelperFile {
    private workspacePath: string;
    private helperDir: string;
    private helperFile: string;

    constructor() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder found.');
        }
        this.workspacePath = workspaceFolders[0].uri.fsPath;
        this.helperDir = path.join(this.workspacePath, '.hydra_helper');
        this.helperFile = path.join(this.helperDir, 'virtual.py');
    }

    ensureDirAndMaybePromptGitignore = async () => {
        let created = false;
        if (!fs.existsSync(this.helperDir)) {
            fs.mkdirSync(this.helperDir);
            created = true;
        }
        // If just created and workspace is a git repo, prompt user to add to .gitignore
        if (created && fs.existsSync(path.join(this.workspacePath, '.git'))) {
            const gitignorePath = path.join(this.workspacePath, '.gitignore');
            let alreadyIgnored = false;
            if (fs.existsSync(gitignorePath)) {
                const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
                alreadyIgnored = gitignoreContent.includes('.hydra_helper/');
            }
            if (!alreadyIgnored) {
                const answer = await vscode.window.showInformationMessage(
                    'The .hydra_helper folder is used for internal extension files. Would you like to add it to your .gitignore?',
                    'Yes', 'No'
                );
                if (answer === 'Yes') {
                    fs.appendFileSync(gitignorePath, '\n.hydra_helper/\n');
                }
            }
        }
    };

    write(text: string) {
        this.ensureDirAndMaybePromptGitignore();
        console.debug(`Hydra Helper: Created virtual Python code: "${text}"`);
        fs.writeFileSync(this.helperFile, text, { encoding: 'utf8' });
    }

    getUri(): vscode.Uri {
        return Uri.file(this.helperFile);
    }

    getHelperFilePath(): string {
        return this.helperFile;
    }
}

// This function is called when the extension is activated.
export function activate(context: vscode.ExtensionContext) {
    console.log('Hydra Helper extension is now becoming active!');

    // Hide .hydra_helper from the VS Code explorer
    vscode.workspace.getConfiguration('files').update(
        'exclude',
        { '.hydra_helper': false }, // for debugging purposes show it for now
        vscode.ConfigurationTarget.Workspace
    );

    // Register our definition provider for YAML files.
    const provider = vscode.languages.registerDefinitionProvider(
        { language: 'yaml' },
        new HydraDefinitionProvider()
    );
    context.subscriptions.push(provider);

    // Register our completion provider for YAML files
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { language: 'yaml' },
        new HydraCompletionItemProvider(),
        '.', // Trigger on dot for module path completion
        '"', // Trigger on quote for new import
        '\'' // Trigger on single quote
    );
    context.subscriptions.push(completionProvider);

    console.log('Hydra Helper extension is now active!');

    // Ensure the helper directory exists and prompt for .gitignore if needed
    const helper = new PythonHelperFile();
    helper.ensureDirAndMaybePromptGitignore().catch(err => {
        console.error('Hydra Helper: Error ensuring helper directory:', err);
    });
}

class HydraDefinitionProvider implements vscode.DefinitionProvider {
    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        console.log('Hydra Helper: provideDefinition method was triggered.');
        const lineText = document.lineAt(position.line).text;
        const match = lineText.match(/_target_:\s*['"]?([\w\.]+)['"]?/);
        if (!match) {
            console.debug(`Hydra Helper: The regex did not find a _target_ on the line: "${lineText}"`);
            return undefined;
        }
        const classPath = match[1];
        console.debug(`Hydra Helper: Found potential class path: ${classPath}`);
        const lastDotIndex = classPath.lastIndexOf('.');
        if (lastDotIndex === -1) {
            console.debug(`Hydra Helper: Invalid class path format: ${classPath}`);
            return undefined;
        }
        const modulePath = classPath.substring(0, lastDotIndex);
        const className = classPath.substring(lastDotIndex + 1);
        const pythonCode = `from ${modulePath} import ${className}`;

        // Use the PythonHelperFile utility
        let helper: PythonHelperFile;
        try {
            helper = new PythonHelperFile();
        } catch (e) {
            vscode.window.showErrorMessage('Hydra Helper: No workspace folder found.');
            return undefined;
        }
        await helper.ensureDirAndMaybePromptGitignore();
        helper.write(pythonCode);
        const fileUri = helper.getUri();
        const positionInVirtualDoc = new vscode.Position(0, pythonCode.indexOf(className));
        console.debug('Hydra Helper: Asking Pylance for the definition...');
        try {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                fileUri,
                positionInVirtualDoc
            );
            if (locations && locations.length > 0) {
                console.debug(`Hydra Helper: Pylance found a definition at: ${locations[0].uri.fsPath}`);
                return locations;
            } else {
                console.debug('Hydra Helper: Pylance could not find a definition.');
            }
        } catch (error) {
            console.error('Hydra Helper: An error occurred.', error);
            return undefined;
        }
        return undefined;
    }
}

// --- PHASE 2b: COMPLETION PROVIDER ---
class HydraCompletionItemProvider implements vscode.CompletionItemProvider {
    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | undefined> {
        console.log(`Hydra Helper: Completion provider triggered. Reason: ${context.triggerKind}`);
        const lineText = document.lineAt(position.line).text;
        const targetMatch = lineText.match(/_target_:\s*(['"]?)([\w\.]*)/);
        if (!targetMatch) {
            return undefined;
        }
        const query = targetMatch[2] || '';
        return this.getImportCompletions(query);
    }

    /**
     * Provides completions by simulating a Python import statement.
     * This now handles both top-level packages and sub-modules.
     */
    private async getImportCompletions(query: string): Promise<vscode.CompletionItem[]> {
        const lastDotIndex = query.lastIndexOf('.');
        const modulePath = lastDotIndex === -1 ? '' : query.substring(0, lastDotIndex);
        const partialSymbol = lastDotIndex === -1 ? query : query.substring(lastDotIndex + 1);
        // If there's no module path, simulate a top-level import (e.g., "import my_app").
        // Otherwise, simulate a from-import (e.g., "from my_app import database").
        const pythonCode = modulePath
            ? `from ${modulePath} import ${partialSymbol}`
            : `import ${partialSymbol}`;
        try {
            // Use the PythonHelperFile utility for the virtual file
            let helper: PythonHelperFile;
            try {
                helper = new PythonHelperFile();
            } catch (e) {
                vscode.window.showErrorMessage('Hydra Helper: No workspace folder found.');
                return [];
            }
            await helper.ensureDirAndMaybePromptGitignore();
            helper.write(pythonCode);
            const fileUri = helper.getUri();
            const positionInVirtualDoc = new vscode.Position(0, pythonCode.length);
            console.debug('Hydra Helper: Asking Pylance for import completions...');
            const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                fileUri,
                positionInVirtualDoc
            );
            if (!completions) {
                return [];
            }
            // Reconstruct the full path for each completion item.
            return completions.items.map(item => {
                const newLabel = modulePath ? `${modulePath}.${item.label}` : `${item.label}`;
                const newItem = new vscode.CompletionItem(newLabel, item.kind);
                return newItem;
            });
        } catch (error) {
            console.error('Hydra Helper: Error during import completion.', error);
            return [];
        }
    }
}

// This function is called when your extension is deactivated.
export function deactivate() {}
