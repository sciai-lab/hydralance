import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';


// Utility class to manage in-memory Python helper documents
// Uses VS Code's text document API instead of physical files for better performance
class PythonHelperDocument {
    private shadowUri: vscode.Uri;
    private static helperCounter = 0;

    constructor() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            // Fallback: create a URI in a temporary location
            // Even without a workspace, we can use an untitled scheme or a temp path
            this.shadowUri = vscode.Uri.parse(`untitled:/.vscode/.pylance_shadow/hydra_stub_${PythonHelperDocument.helperCounter++}.py`);
        } else {
            // Create shadow URI inside workspace's .vscode folder
            this.shadowUri = vscode.Uri.joinPath(
                workspaceFolders[0].uri,
                '.vscode',
                '.pylance_shadow',
                `hydra_stub_${PythonHelperDocument.helperCounter++}.py`
            );
        }
    }

    /**
     * Write Python code to an in-memory text document.
     * Pylance will see this via onDidChangeTextDocument events.
     * No physical file I/O is performed.
     */
    async write(text: string): Promise<void> {
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(this.shadowUri, { ignoreIfNotExists: true });
            edit.createFile(this.shadowUri, { contents: Buffer.from(text) });
            await vscode.workspace.applyEdit(edit);
        } catch (err) {
            console.error('Hydra Helper: Error writing in-memory document:', err);
            throw err;
        }
    }

    getUri(): vscode.Uri {
        return this.shadowUri;
    }

    /**
     * Optional: Close the in-memory document.
     * Note: This is not strictly necessary as the document will be garbage collected,
     * but can be used for explicit cleanup.
     */
    async cleanup(): Promise<void> {
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(this.shadowUri, { ignoreIfNotExists: true });
            await vscode.workspace.applyEdit(edit);
        } catch (err) {
            // Ignore cleanup errors - document might not exist
            console.debug('Hydra Helper: Cleanup skipped (document may not exist)');
        }
    }

    /**
     * Static method to ensure .vscode/.pylance_shadow is in .gitignore
     */
    static async ensureGitignoreEntry(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        if (!fs.existsSync(path.join(workspacePath, '.git'))) {
            return; // Not a git repo
        }

        const gitignorePath = path.join(workspacePath, '.gitignore');
        const shadowPath = '.vscode/.pylance_shadow/';
        
        let alreadyIgnored = false;
        if (fs.existsSync(gitignorePath)) {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            alreadyIgnored = gitignoreContent.includes(shadowPath);
        }

        if (!alreadyIgnored) {
            const answer = await vscode.window.showInformationMessage(
                'The .vscode/.pylance_shadow folder is used for Hydra language support. Would you like to add it to your .gitignore?',
                'Yes', 'No'
            );
            if (answer === 'Yes') {
                const content = fs.existsSync(gitignorePath) 
                    ? fs.readFileSync(gitignorePath, 'utf8')
                    : '';
                const newContent = content + (content.endsWith('\n') ? '' : '\n') + shadowPath + '\n';
                fs.writeFileSync(gitignorePath, newContent, 'utf8');
            }
        }
    }
}

// --- Utility: Create Python import code for a Hydra _target_ string ---
function createPythonImportCode(target: string): { code: string, symbol: string, type: 'import' | 'method' } {
    const parts = target.split('.');
    if (parts.length < 2) {
        // Not enough info to import
        return { code: '', symbol: target, type: 'import' };
    }
    if (parts.length === 2) {
        // module.class or module.function
        return { code: `from ${parts[0]} import ${parts[1]}`, symbol: parts[1], type: 'import' };
    }
    // module.class.method or deeper
    const modulePath = parts.slice(0, -2).join('.');
    const className = parts[parts.length - 2];
    const methodName = parts[parts.length - 1];
    return {
        code: `${modulePath ? `from ${modulePath} import ${className}` : `import ${className}`}; ${className}.${methodName}`,
        symbol: methodName,
        type: 'method'
    };
}

// --- Utility: Test if Pyright is ready by resolving a known symbol ---
async function testPyrightReady(): Promise<boolean> {
    const { code: pythonCode, symbol } = createPythonImportCode('sys.version');
    if (!pythonCode) {
        return false;
    }

    const helper = new PythonHelperDocument();
    try {
        await helper.write(pythonCode);
        const fileUri = helper.getUri();
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const posIdx = pythonCode.lastIndexOf(symbol);
        const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);

        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            fileUri,
            positionInVirtualDoc
        );

        await helper.cleanup();
        return locations && locations.length > 0;
    } catch (error) {
        await helper.cleanup();
        return false;
    }
}

// This function is called when the extension is activated.
export async function activate(context: vscode.ExtensionContext) {
    console.log('Hydra Helper extension is now becoming active!');

    // Check if Pylance is available
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    if (!pylance) {
        vscode.window.showWarningMessage(
            'HydraLance requires the Pylance extension to function. Please install it from the marketplace.',
            'Install Pylance'
        ).then(selection => {
            if (selection === 'Install Pylance') {
                vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-python.vscode-pylance');
            }
        });
        return;
    }

    // Poll until Pyright is ready to resolve symbols
    console.log('Hydra Helper: Waiting for Pyright to be ready...');
    while (!(await testPyrightReady())) {
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    console.log('Hydra Helper: Pyright is ready.');

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
        ':',
        '.', 
        // Trigger on dot for module path completion
        // '"', // Trigger on quote for new import
        // '\'' // Trigger on single quote
    );
    context.subscriptions.push(completionProvider);

    console.log('Hydra Helper extension is now active!');

    // Ensure the shadow directory is in .gitignore if needed
    PythonHelperDocument.ensureGitignoreEntry().catch((err: Error) => {
        console.error('Hydra Helper: Error ensuring gitignore entry:', err);
    });

    // Register linting diagnostics for _target_
    activateHydraLinting(context);
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
        const { code: pythonCode, symbol, type } = createPythonImportCode(classPath);
        if (!pythonCode) {
            return undefined;
        }
        console.debug(`Hydra Helper: Created virtual Python code: "${pythonCode}"`);
        
        // Use the in-memory PythonHelperDocument
        const helper = new PythonHelperDocument();
        try {
            await helper.write(pythonCode);
            const fileUri = helper.getUri();
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const posIdx = pythonCode.lastIndexOf(symbol);
            const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);
            
            console.debug('Hydra Helper: Asking Pylance for the definition...');
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                fileUri,
                positionInVirtualDoc
            );
            
            // Cleanup is optional with in-memory documents, but we'll do it to be tidy
            await helper.cleanup();
            
            if (locations && locations.length > 0) {
                console.debug(`Hydra Helper: Pylance found a definition at: ${locations[0].uri.fsPath}`);
                return locations;
            } else {
                console.debug('Hydra Helper: Pylance could not find a definition.');
            }
        } catch (error) {
            await helper.cleanup();
            console.error('Hydra Helper: An error occurred.', error);
            return undefined;
        }
        return undefined;
    }
}

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
        const { code: pythonCode, symbol, type } = createPythonImportCode(query);
        if (!pythonCode) {
            return [];
        }
        console.log(`Hydra Helper: Created virtual Python code for completion: "${pythonCode}"`);
        
        const helper = new PythonHelperDocument();
        try {
            await helper.write(pythonCode);
            const fileUri = helper.getUri();
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const posIdx = pythonCode.lastIndexOf(symbol);
            const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);
            
            console.log('Hydra Helper: Asking Pylance for import completions...');
            const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                fileUri,
                positionInVirtualDoc
            );
            
            await helper.cleanup();
            
            if (!completions) {
                return [];
            }
            // Reconstruct the full path for each completion item.
            const modulePath = query.split('.').slice(0, -1).join('.');
            return completions.items.map(item => {
                const newLabel = modulePath ? `${modulePath}.${item.label}` : `${item.label}`;
                const newItem = new vscode.CompletionItem(newLabel, item.kind);
                return newItem;
            });
        } catch (error) {
            await helper.cleanup();
            console.error('Hydra Helper: Error during import completion.', error);
            return [];
        }
    }
}

// --- PHASE 3: LINTING PROVIDER FOR _target_ ---
const HYDRA_DIAGNOSTIC_COLLECTION = 'hydraHelperDiagnostics';

function activateHydraLinting(context: vscode.ExtensionContext) {
    const diagnostics = vscode.languages.createDiagnosticCollection(HYDRA_DIAGNOSTIC_COLLECTION);
    context.subscriptions.push(diagnostics);

    // Debounce map for document URIs
    const debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    function triggerLint(document: vscode.TextDocument) {
        if (document.languageId !== 'yaml') {
            return;
        }
        const uriStr = document.uri.toString();
        if (debounceTimers.has(uriStr)) {
            clearTimeout(debounceTimers.get(uriStr));
        }
        debounceTimers.set(uriStr, setTimeout(() => {
            lintDocument(document, diagnostics);
            debounceTimers.delete(uriStr);
        }, 2000)); // 2 second debounce
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(triggerLint),
        vscode.workspace.onDidChangeTextDocument(e => triggerLint(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri))
    );

    // Lint all open YAML docs on activation
    vscode.workspace.textDocuments.forEach(doc => {
        if (doc.languageId === 'yaml') {
            triggerLint(doc);
        }
    });
}

async function lintDocument(document: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection) {
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const diags: vscode.Diagnostic[] = [];
    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];
        const match = line.match(/_target_:\s*['"]?([\w\.]+)['"]?/);
        if (match) {
            const classPath = match[1];
            const { code: pythonCode, symbol, type } = createPythonImportCode(classPath);
            if (!pythonCode) {
                continue;
            }
            const helper = new PythonHelperDocument();
            let found = false;
            try {
                await helper.write(pythonCode);
                const fileUri = helper.getUri();
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const posIdx = pythonCode.lastIndexOf(symbol);
                const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);
                
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeDefinitionProvider',
                    fileUri,
                    positionInVirtualDoc
                );
                
                await helper.cleanup();
                
                if (locations && locations.length > 0) {
                    found = true;
                }
            } catch (error) {
                await helper.cleanup();
                found = false;
            }
            if (!found) {
                // Underline the value behind _target_
                const start = line.indexOf(classPath);
                const range = new vscode.Range(i, start, i, start + classPath.length);
                diags.push(new vscode.Diagnostic(
                    range,
                    `Hydra Helper: '${classPath}' is not a valid Python symbol (cannot be resolved).`,
                    vscode.DiagnosticSeverity.Error
                ));
            }
        }
    }
    diagnostics.set(document.uri, diags);
}

// This function is called when your extension is deactivated.
export function deactivate() {}
