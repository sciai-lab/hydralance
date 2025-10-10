import * as vscode from 'vscode';
import { Uri } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';


// Utility class to manage the .hydra_helper Python helper file
class PythonHelperFile {
    private workspacePath: string;
    private helperDir: string;
    private helperFile: string;
    private static CLEANUP_AGE_MS = 1000; // 1 second

    constructor() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder found.');
        }
        this.workspacePath = workspaceFolders[0].uri.fsPath;
        this.helperDir = path.join(this.workspacePath, '.hydra_helper');
        // Use a unique file for each request
        const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        this.helperFile = path.join(this.helperDir, `virtual_${unique}.py`);
    }

    async ensureDirAndMaybePromptGitignore() {
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
        // Cleanup old helper files
        this.cleanupOldFiles();
    }

    write(text: string) {
        fs.writeFileSync(this.helperFile, text, { encoding: 'utf8' });
    }

    getUri(): vscode.Uri {
        return Uri.file(this.helperFile);
    }

    getHelperFilePath(): string {
        return this.helperFile;
    }

    cleanupFile() {
        // Remove this specific helper file
        try {
            if (fs.existsSync(this.helperFile)) {
                fs.unlinkSync(this.helperFile);
            }
        } catch (err) {
            console.error('Hydra Helper: Error cleaning up helper file:', err);
        }
    }

    // Remove helper files older than CLEANUP_AGE_MS
    cleanupOldFiles() {
        try {
            const files = fs.readdirSync(this.helperDir);
            const now = Date.now();
            for (const file of files) {
                if (file.startsWith('virtual_') && file.endsWith('.py')) {
                    const filePath = path.join(this.helperDir, file);
                    const stat = fs.statSync(filePath);
                    if (now - stat.mtimeMs > PythonHelperFile.CLEANUP_AGE_MS) {
                        fs.unlinkSync(filePath);
                    }
                }
            }
        } catch (err) {
            // Ignore cleanup errors
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
        ':',
        '.', // Trigger on dot for module path completion
        // '"', // Trigger on quote for new import
        // '\'' // Trigger on single quote
    );
    context.subscriptions.push(completionProvider);

    console.log('Hydra Helper extension is now active!');

    // Ensure the helper directory exists and prompt for .gitignore if needed
    const helper = new PythonHelperFile();
    helper.ensureDirAndMaybePromptGitignore().catch(err => {
        console.error('Hydra Helper: Error ensuring helper directory:', err);
    });

    // Register linting diagnostics for _target_
    // activateHydraLinting(context);
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
        const posIdx = pythonCode.lastIndexOf(symbol);
        const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);
        console.debug('Hydra Helper: Asking Pylance for the definition...');
        try {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                fileUri,
                positionInVirtualDoc
            );
            helper.cleanupFile();
            if (locations && locations.length > 0) {
                console.debug(`Hydra Helper: Pylance found a definition at: ${locations[0].uri.fsPath}`);
                return locations;
            } else {
                console.debug('Hydra Helper: Pylance could not find a definition.');
            }
        } catch (error) {
            helper.cleanupFile();
            console.error('Hydra Helper: An error occurred.', error);
            return undefined;
        }
        helper.cleanupFile();
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
        let helper: PythonHelperFile | undefined;
        try {
            helper = new PythonHelperFile();
            await helper.ensureDirAndMaybePromptGitignore();
            helper.write(pythonCode);
            const fileUri = helper.getUri();
            const posIdx = pythonCode.lastIndexOf(symbol);
            const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);
            console.log('Hydra Helper: Asking Pylance for import completions...');
            const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                fileUri,
                positionInVirtualDoc
            );
            helper.cleanupFile();
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
            if (helper) {
                helper.cleanupFile();
            }
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
        }, 400));
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
            let helper: PythonHelperFile;
            try {
                helper = new PythonHelperFile();
            } catch (e) {
                continue;
            }
            await helper.ensureDirAndMaybePromptGitignore();
            helper.write(pythonCode);
            const fileUri = helper.getUri();
            const posIdx = pythonCode.lastIndexOf(symbol);
            const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);
            let found = false;
            try {
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeDefinitionProvider',
                    fileUri,
                    positionInVirtualDoc
                );
                helper.cleanupFile();
                if (locations && locations.length > 0) {
                    found = true;
                }
            } catch (error) {
                helper.cleanupFile();
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
