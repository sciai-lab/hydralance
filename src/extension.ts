import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


// Extension-wide output channel for better user debugging
let outputChannel: vscode.OutputChannel;

// Enhanced logging utility with log storage
class ExtensionLogger {
    private static logs: string[] = [];
    private static maxLogs = 1000; // Keep last 1000 log entries
    
    static log(message: string, data?: any) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        const fullMessage = logMessage + (data ? ` ${JSON.stringify(data)}` : '');
        
        // Store log entry
        this.logs.push(fullMessage);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift(); // Remove oldest log
        }
        
        // Log to both console and output channel
        console.log(logMessage, data || '');
        if (outputChannel) {
            outputChannel.appendLine(fullMessage);
        }
    }
    
    static error(message: string, error?: any) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ERROR: ${message}`;
        const fullMessage = logMessage + (error ? ` ${error}` : '');
        
        // Store log entry
        this.logs.push(fullMessage);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        
        console.error(logMessage, error || '');
        if (outputChannel) {
            outputChannel.appendLine(fullMessage);
            outputChannel.show(); // Show output panel on errors
        }
    }
    
    static debug(message: string, data?: any) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] DEBUG: ${message}`;
        const fullMessage = logMessage + (data ? ` ${JSON.stringify(data)}` : '');
        
        // Store log entry
        this.logs.push(fullMessage);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        
        console.debug(logMessage, data || '');
        if (outputChannel) {
            outputChannel.appendLine(fullMessage);
        }
    }
    
    static show() {
        if (outputChannel) {
            outputChannel.show();
        }
    }
    
    static getAllLogs(): string[] {
        return [...this.logs]; // Return copy to prevent external modification
    }
}

// Collect diagnostic information for debugging user issues
async function collectDiagnosticInfo(): Promise<string> {
    const info: any = {
        timestamp: new Date().toISOString(),
        vscode: {
            version: vscode.version,
            language: vscode.env.language,
            machineId: vscode.env.machineId.substring(0, 8) + '...' // Partial for privacy
        },
        system: {
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            nodeVersion: process.version
        },
        workspace: {
            folders: vscode.workspace.workspaceFolders?.map(f => ({
                name: f.name,
                scheme: f.uri.scheme
            })) || [],
            openDocuments: vscode.workspace.textDocuments.length
        },
        extensions: {
            pylance: {
                installed: !!vscode.extensions.getExtension('ms-python.vscode-pylance'),
                active: vscode.extensions.getExtension('ms-python.vscode-pylance')?.isActive || false,
                version: vscode.extensions.getExtension('ms-python.vscode-pylance')?.packageJSON.version || 'unknown'
            },
            python: {
                installed: !!vscode.extensions.getExtension('ms-python.python'),
                active: vscode.extensions.getExtension('ms-python.python')?.isActive || false,
                version: vscode.extensions.getExtension('ms-python.python')?.packageJSON.version || 'unknown'
            },
            totalInstalled: vscode.extensions.all.length,
            activeExtensions: vscode.extensions.all
                .filter(ext => ext.isActive)
                .map(ext => ({
                    id: ext.id,
                    version: ext.packageJSON.version
                }))
        },
        hydralance: {
            pyrightReady: await testPyrightReady()
        },
        logs: ExtensionLogger.getAllLogs()
    };

    return JSON.stringify(info, null, 2);
}


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
            ExtensionLogger.error('Error writing in-memory document:', err);
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
        return { code: `import ${target}`, symbol: target, type: 'import' };
    }
    // check if the second last part is uppercase, implying a method being autocompleted / linted
    const secondLast = parts[parts.length - 2];
    if (secondLast[0] === secondLast[0].toUpperCase()) {
        // module.submodule.Class.method
        const modulePath = parts.slice(0, -2).join('.');
        const className = parts[parts.length - 2];
        const methodName = parts[parts.length - 1];
        return {
            code: `${modulePath ? `from ${modulePath} import ${className}` : `import ${className}`}; ${className}.${methodName}`,
            symbol: methodName,
            type: 'method'
        };
    } else {
        // module.submodule.function or module.submodule1.submodule2
        const modulePath = parts.slice(0, -1).join('.');
        const functionName = parts[parts.length - 1];
        return {
            code: `from ${modulePath} import ${functionName}`,
            symbol: functionName,
            type: 'import'
        };
    }
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

// --- Utility: YAML context parsing for parameter detection ---
interface YamlContext {
    isParameterContext: boolean;
    isInDefaultsList: boolean;
    targetValue?: string;
    indentLevel: number;
    existingSiblings: string[];
}

function parseYamlContext(document: vscode.TextDocument, position: vscode.Position): YamlContext {
    const lines = document.getText().split(/\r?\n/);
    const currentLine = lines[position.line];
    const currentIndent = getIndentLevel(currentLine);
    
    ExtensionLogger.debug(`Parsing YAML context at line ${position.line}, indent ${currentIndent}`);

    // Check if we are in a 'defaults' list
    let isInDefaultsList = false;
    let parentKey = undefined;
    let parentLineNum = -1;
    
    // Traverse upwards to find the parent key
    for (let i = position.line - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.trim() === '') {
            continue;
        }
        const lineIndent = getIndentLevel(line);
        ExtensionLogger.log(`Hydra Helper: indent ${lineIndent}, ${line}`);
        if (lineIndent < currentIndent) {
            const keyMatch = line.match(/^\s*([^:]+):\s*(.*)/);
            if (keyMatch) {
                parentKey = keyMatch[1].trim();
                parentLineNum = i;
            }
            if (parentKey === 'defaults' && lineIndent === 0) {
                isInDefaultsList = true;
            }
            break; // Found parent block
        }
    }
    
    // Find _target_ at the same indentation level
    let targetValue: string | undefined;
    const existingSiblings: string[] = [];
    
    // Look backwards and forwards from current position to find siblings
    for (let i = parentLineNum + 1; i < lines.length; i++) {
        const line = lines[i];
        const lineIndent = getIndentLevel(line);
        
        // Skip empty lines and comments
        if (line.trim() === '' || line.trim().startsWith('#')) {
            continue;
        }
        
        // If we hit a line with less indentation, we're out of the current block
        if (lineIndent < currentIndent && line.trim() !== '') {
            if (i > position.line) {
                break; // We've moved to the next block
            }
            continue;
        }
        
        // Only consider lines at the same indentation level
        if (lineIndent === currentIndent) {
            const keyMatch = line.match(/^\s*([^:]+):\s*(.*)/);
            if (keyMatch) {
                const key = keyMatch[1].trim();
                const value = keyMatch[2].trim();
                
                if (key === '_target_') {
                    // Remove quotes if present
                    targetValue = value.replace(/^['"]|['"]$/g, '');
                    ExtensionLogger.log(`Hydra Helper: Found _target_: ${targetValue}`);
                } else if (i !== position.line) {
                    // Add to existing siblings (don't include current line)
                    existingSiblings.push(key);
                }
            }
        }
    }
    
    ExtensionLogger.log(`Hydra Helper: Found ${existingSiblings.length} existing siblings: ${existingSiblings.join(', ')}`);
    
    return {
        isParameterContext: !!targetValue,
        isInDefaultsList,
        targetValue,
        indentLevel: currentIndent,
        existingSiblings
    };
}

function getIndentLevel(line: string): number {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
}

function isAtKeyPosition(line: string, position: number): boolean {
    // Check if cursor is at the start of a key (not in a value)
    const beforeCursor = line.substring(0, position);
    const afterCursor = line.substring(position);
    const colonIndex = beforeCursor.lastIndexOf(':');
    
    ExtensionLogger.log(`Hydra Helper: Checking key position. Before: "${beforeCursor}", After: "${afterCursor}"`);
    
    if (colonIndex === -1) {
        // No colon before cursor, we're likely typing a key
        ExtensionLogger.log('Hydra Helper: No colon found, assuming key position');
        return true;
    }
    
    // Check if there's non-whitespace after the colon
    const afterColon = line.substring(colonIndex + 1);
    const isKey = afterColon.trim() === '';
    ExtensionLogger.log(`Hydra Helper: After colon: "${afterColon}", is key position: ${isKey}`);
    
    // Also check if we're at the beginning of a new line (indented)
    const trimmedBefore = beforeCursor.trim();
    if (trimmedBefore === '' && afterCursor.trim() !== '') {
        ExtensionLogger.log('Hydra Helper: At beginning of indented line');
        return true;
    }
    
    return isKey;
}


// --- Utility: Parse a line from the defaults list ---
interface DefaultsConfig {
    type: 'config';
    configGroup?: string;
    configName: string;
    package?: string;
    valueRange: { start: number; end: number };
}

interface DefaultsGroupDefault {
    type: 'group_default';
    optional: boolean;
    override: boolean;
    configGroup: string;
    package?: string;
    option: string | string[] | null;
    valueRange: { start: number; end: number };
}

type DefaultsEntry = DefaultsConfig | DefaultsGroupDefault;

function parseDefaultsListEntry(line: string): DefaultsEntry | undefined {
    const originalLine = line;
    
    // Remove '-' trim whitespace and potential comments
    line = line.split('#')[0].trim().substring(1).trim(); 
    
    // Calculate the offset to the start of the processed line within the original line
    const lineStartOffset = originalLine.indexOf(line);
    
    // Regex for GROUP_DEFAULT: [optional|override]? CONFIG_GROUP(@PACKAGE)?: OPTION
    const groupDefaultRegex = /^(optional\s+|override\s+)?([\w\/]+)(@[\w_]+)?:\s*(.*)$/;
    const groupDefaultMatch = line.match(groupDefaultRegex);

    if (groupDefaultMatch) {
        const optional = groupDefaultMatch[1]?.includes('optional') || false;
        const override = groupDefaultMatch[1]?.includes('override') || false;
        const configGroup = groupDefaultMatch[2];
        const pkg = groupDefaultMatch[3]?.substring(1);
        let option: string | string[] | null = groupDefaultMatch[4].trim();

        if (option === 'null') {
            option = null;
        } else if (option.startsWith('[') && option.endsWith(']')) {
            option = option.substring(1, option.length - 1).split(',').map(s => s.trim());
        }

        // Calculate valueRange for the option part (after the colon)
        const optionStart = line.indexOf(':') + 1;
        const optionMatch = line.substring(optionStart).match(/\s*(.+)/);
        let valueRangeStart = lineStartOffset + optionStart;
        let valueRangeEnd = lineStartOffset + line.length;
        
        if (optionMatch) {
            valueRangeStart = lineStartOffset + optionStart + optionMatch.index! + optionMatch[0].indexOf(optionMatch[1]);
            valueRangeEnd = valueRangeStart + optionMatch[1].length;
        }

        return {
            type: 'group_default',
            optional,
            override,
            configGroup,
            package: pkg,
            option,
            valueRange: { start: valueRangeStart, end: valueRangeEnd }
        };
    }

    // Regex for CONFIG: (CONFIG_GROUP/)?CONFIG_NAME(@PACKAGE)?
    const configRegex = /^(([\w\/]+)\/)?([\w_]+)(@[\w_]+)?$/;
    const configMatch = line.match(configRegex);

    if (configMatch) {
        const configGroup = configMatch[2];
        const configName = configMatch[3];
        const pkg = configMatch[4]?.substring(1);

        // Calculate valueRange covering configGroup (if present) and configName
        let valueRangeStart = lineStartOffset;
        let valueRangeEnd = lineStartOffset + line.length;
        
        // If there's a package suffix, exclude it from the clickable range
        if (configMatch[4]) {
            valueRangeEnd = lineStartOffset + line.lastIndexOf(configMatch[4]);
        }

        return {
            type: 'config',
            configGroup,
            configName,
            package: pkg,
            valueRange: { start: valueRangeStart, end: valueRangeEnd }
        };
    }

    return undefined;
}


// Alternative approach: Use completion provider to get parameter information
async function getParameterCompletionsViaCompletion(target: string, existingSiblings: string[]): Promise<vscode.CompletionItem[]> {
    const { code: importCode,symbol: functionOrClassName, type: import_or_method } = createPythonImportCode(target);
    const parts = target.split('.');
    const functionName = parts[parts.length - 1];
    
    // Create code that would trigger parameter completion
    let pythonCode: string;
    let position: vscode.Position;
    if (import_or_method === 'import') {
        pythonCode = `${importCode}\n${functionOrClassName}(`;
        position = new vscode.Position(1, functionOrClassName.length + 1);
    } else {
        pythonCode = `${importCode}(`;
        position = new vscode.Position(0, pythonCode.length);
    }
    const helper = new PythonHelperDocument();
    try {
        await helper.write(pythonCode);
        const fileUri = helper.getUri();
        const doc = await vscode.workspace.openTextDocument(fileUri);
        
        // Give Pylance a moment to analyze
        // await new Promise(resolve => setTimeout(resolve, 300));
        
        ExtensionLogger.log(`Hydra Helper: Trying completion approach for: ${target}`);
        ExtensionLogger.log(`Hydra Helper: Code: ${pythonCode}`);
        
        // Position cursor right after the opening parenthesis
        
        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            fileUri,
            position
        );
        
        await helper.cleanup();
        
        if (!completions) {
            ExtensionLogger.log(`Hydra Helper: No completions found via completion provider`);
            return [];
        }
        
        ExtensionLogger.log(`Hydra Helper: Found ${completions.items.length} completion items (before filtering)`);
        completions.items.forEach(item => {
            const label = typeof item.label === 'string' ? item.label : item.label.label;
            // ExtensionLogger.log(`Hydra Helper: Completion item: "${label}" (kind: ${item.kind})`);
        });
        
        // Filter for parameter-like completions
        return completions.items
            .filter(item => {
                const label = typeof item.label === 'string' ? item.label : item.label.label;
                // Look for items that look like parameter names (contain = or are variables)
                return item.kind === vscode.CompletionItemKind.Variable &&
                       (typeof label === 'string' && label.endsWith('='));
            })
            .filter(item => {
                const label = typeof item.label === 'string' ? item.label : item.label.label;
                const paramName = label.split('=')[0].trim();
                return paramName !== 'self' && 
                       paramName !== 'cls' && 
                       !existingSiblings.includes(paramName);
            })
            .map(item => {
                const label = typeof item.label === 'string' ? item.label : item.label.label;
                const paramName = label.split('=')[0].trim();
                
                const newItem = new vscode.CompletionItem(paramName, vscode.CompletionItemKind.Property);
                newItem.detail = `Parameter of ${target}`;
                newItem.documentation = item.documentation;
                newItem.insertText = `${paramName}: `;
                newItem.sortText = `0${paramName}`;
                return newItem;
            });
            
    } catch (error) {
        await helper.cleanup();
        console.error(`Hydra Helper: Error in completion approach:`, error);
        return [];
    }
}

async function getParameterCompletions(target: string, existingSiblings: string[]): Promise<vscode.CompletionItem[]> {
    ExtensionLogger.log(`Hydra Helper: Getting parameter completions for: ${target}`);
    try {
        const completionResults = await getParameterCompletionsViaCompletion(target, existingSiblings);
        if (completionResults.length > 0) {
            ExtensionLogger.log(`Hydra Helper: Success with completion provider approach: ${completionResults.length} parameters`);
            return completionResults;
        }
    } catch (error) {
        ExtensionLogger.log(`Hydra Helper: Completion provider approach failed:`, error);
    }
    return [];
}


// This function is called when the extension is activated.
export async function activate(context: vscode.ExtensionContext) {
    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel('HydraLance');
    context.subscriptions.push(outputChannel);
    
    ExtensionLogger.log('Hydra Helper extension is now becoming active!');

    // Check if Pylance is available
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    if (!pylance) {
        ExtensionLogger.error('Pylance extension not found');
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
    ExtensionLogger.log('Waiting for Pyright to be ready...');
    while (!(await testPyrightReady())) {
        ExtensionLogger.log('Pyright not ready yet, retrying in 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    ExtensionLogger.log('Pyright is ready.');

    // Register diagnostic command for debugging user issues
    const diagnosticCommand = vscode.commands.registerCommand('hydralance.diagnostics', async () => {
        const info = await collectDiagnosticInfo();
        const document = await vscode.workspace.openTextDocument({
            content: info,
            language: 'json'
        });
        await vscode.window.showTextDocument(document);
        vscode.window.showInformationMessage('Diagnostic info generated. Please share this with the developer.');
    });
    context.subscriptions.push(diagnosticCommand);

    // Register command to show logs
    const showLogsCommand = vscode.commands.registerCommand('hydralance.showLogs', () => {
        ExtensionLogger.show();
    });
    context.subscriptions.push(showLogsCommand);

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
        ':', // Trigger after colon for _target_ values
        '.', // Trigger on dot for module path completion
        ' ', // Trigger on space (for parameter completion after colon)
        '\n' // Trigger on newline for parameter keys
    );
    context.subscriptions.push(completionProvider);

    // Register our hover provider for YAML files
    const hoverProvider = vscode.languages.registerHoverProvider(
        { language: 'yaml' },
        new HydraHoverProvider()
    );
    context.subscriptions.push(hoverProvider);

    ExtensionLogger.log('Hydra Helper extension is now active!');

    // Ensure the shadow directory is in .gitignore if needed
    PythonHelperDocument.ensureGitignoreEntry().catch((err: Error) => {
        ExtensionLogger.error('Error ensuring gitignore entry:', err);
    });

    // Register linting diagnostics for _target_
    activateHydraLinting(context);
}

// Common function to find target path for defaults entries
function findTargetPathForDefaults(
    document: vscode.TextDocument,
    parsedEntry: DefaultsEntry
): { path: string; exists: boolean; fullPath?: string } | undefined {
    let relativePaths: string[] = [];

    if (parsedEntry.type === 'group_default') {
        if (parsedEntry.option && typeof parsedEntry.option === 'string') {
            relativePaths.push(path.join(parsedEntry.configGroup, `${parsedEntry.option}.yaml`));
            relativePaths.push(path.join(parsedEntry.configGroup, `${parsedEntry.option}.yml`));
        }
    } else if (parsedEntry.type === 'config') {
        const configPath = parsedEntry.configGroup 
            ? path.join(parsedEntry.configGroup, parsedEntry.configName)
            : parsedEntry.configName;
        relativePaths.push(`${configPath}.yaml`);
        relativePaths.push(`${configPath}.yml`);
    }

    if (relativePaths.length === 0) {
        return undefined;
    }

    ExtensionLogger.log(`Hydra Helper: Potential relative paths: ${relativePaths.join(', ')}`);

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
        return undefined;
    }

    let currentPath = path.dirname(document.uri.fsPath);
    const workspaceRoot = workspaceFolder.uri.fsPath;

    while (currentPath.startsWith(workspaceRoot)) {
        for (const relativePath of relativePaths) {
            const fullPath = path.join(currentPath, relativePath);
            if (fs.existsSync(fullPath)) {
                // Return the relative path from workspace root for a cleaner display
                return { 
                    path: path.relative(workspaceRoot, fullPath), 
                    exists: true,
                    fullPath: fullPath
                };
            }
        }
        
        // Move one directory up
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            // Reached the root of the file system
            break;
        }
        currentPath = parentPath;
    }

    // If file doesn't exist, still show the expected path
    return { 
        path: relativePaths[0], 
        exists: false 
    };
}

class HydraDefinitionProvider implements vscode.DefinitionProvider {
    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        const lineText = document.lineAt(position.line).text;

        // Check for _target_ definition
        const targetMatch = lineText.match(/_target_:\s*['"]?([\w\.]+)['"]?/);
        if (targetMatch) {
            const classPath = targetMatch[1];
            return this.provideDefinitionForTarget(classPath);
        }

        // Check for defaults list definition
        const yamlContext = parseYamlContext(document, position);
        if (yamlContext.isInDefaultsList) {
            const parsedEntry = parseDefaultsListEntry(lineText);
            if (parsedEntry) {
                const pos = position.character;
                if (pos >= parsedEntry.valueRange.start && pos <= parsedEntry.valueRange.end) {
                    ExtensionLogger.log("Hydra Helper: Parsed defaults list entry:", parsedEntry);
                    return this.provideDefinitionForDefaults(document, parsedEntry);
                }
            }
        }

        return undefined;
    }

    private async provideDefinitionForTarget(classPath: string): Promise<vscode.Definition | undefined> {
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

    private async provideDefinitionForDefaults(
        document: vscode.TextDocument,
        parsedEntry: DefaultsEntry
    ): Promise<vscode.Definition | undefined> {
        const targetInfo = findTargetPathForDefaults(document, parsedEntry);
        if (targetInfo && targetInfo.exists && targetInfo.fullPath) {
            ExtensionLogger.log(`Hydra Helper: Found definition at: ${targetInfo.fullPath}`);
            const targetUri = vscode.Uri.file(targetInfo.fullPath);
            const targetPosition = new vscode.Position(0, 0);
            return new vscode.Location(targetUri, targetPosition);
        }

        ExtensionLogger.log(`Hydra Helper: Could not find a definition for the defaults entry.`);
        return undefined;
    }
}

class HydraHoverProvider implements vscode.HoverProvider {
    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const lineText = document.lineAt(position.line).text;

        // Check for defaults list hover
        const yamlContext = parseYamlContext(document, position);
        if (yamlContext.isInDefaultsList) {
            const parsedEntry = parseDefaultsListEntry(lineText);
            if (parsedEntry) {
                const pos = position.character;
                if (pos >= parsedEntry.valueRange.start && pos <= parsedEntry.valueRange.end) {
                    const targetInfo = findTargetPathForDefaults(document, parsedEntry);
                    if (targetInfo) {
                        const markdownString = new vscode.MarkdownString();
                        
                        // Show only the path with optional warning
                        if (targetInfo.exists) {
                            markdownString.appendCodeblock(targetInfo.path, 'text');
                        } else {
                            markdownString.appendCodeblock(`${targetInfo.path} [not found]`, 'text');
                        }
                        
                        // Create hover range based on the parsed entry's value range
                        const range = new vscode.Range(
                            position.line,
                            parsedEntry.valueRange.start,
                            position.line,
                            parsedEntry.valueRange.end + 1
                        );
                        
                        return new vscode.Hover(markdownString, range);
                    }
                }
            }
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
        ExtensionLogger.log(`Hydra Helper: Completion provider triggered. Reason: ${context.triggerKind}`);
        const lineText = document.lineAt(position.line).text;
        
        // Check for _target_ completion (existing functionality)
        const targetMatch = lineText.match(/_target_:\s*(['"]?)([\w\.]*)/);
        if (targetMatch) {
            const query = targetMatch[2] || '';
            return this.getImportCompletions(query);
        }
        
        // Check for parameter completion (new functionality)
        const yamlContext = parseYamlContext(document, position);
        if (yamlContext.isParameterContext && yamlContext.targetValue) {
            // Check if we're at a position where we should suggest parameter names
            if (isAtKeyPosition(lineText, position.character)) {
                ExtensionLogger.log(`Hydra Helper: Providing parameter completions for target: ${yamlContext.targetValue}`);
                return await getParameterCompletions(yamlContext.targetValue, yamlContext.existingSiblings);
            }
        }
        
        return undefined;
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
        ExtensionLogger.log(`Hydra Helper: Created virtual Python code for completion: "${pythonCode}"`);
        
        const helper = new PythonHelperDocument();
        try {
            await helper.write(pythonCode);
            const fileUri = helper.getUri();
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const posIdx = pythonCode.lastIndexOf(symbol);
            const positionInVirtualDoc = new vscode.Position(0, posIdx >= 0 ? posIdx : 0);
            
            ExtensionLogger.log('Hydra Helper: Asking Pylance for import completions...');
            const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                fileUri,
                positionInVirtualDoc
            );
            
            await helper.cleanup();
            
            if (!completions) {
                return [];
            }
            // Filter and reconstruct completion items for _target_ (only modules, classes, functions, methods).
            const modulePath = query.split('.').slice(0, -1).join('.');
            const relevantKinds = [
                vscode.CompletionItemKind.Module,
                vscode.CompletionItemKind.Class,
                vscode.CompletionItemKind.Function,
                vscode.CompletionItemKind.Method
            ];
            ExtensionLogger.log(`Hydra Helper: Found ${completions.items.length} completion items from Pylance.`);
            // print all completion kinds for debugging
            // const kindCounts: { [key: number]: number } = {};
            // completions.items.forEach(item => {
            //     if (item.kind !== undefined) {
            //         kindCounts[item.kind] = (kindCounts[item.kind] || 0) + 1;
            //     }
            // });
            // ExtensionLogger.log('Hydra Helper: Completion item kinds distribution:', kindCounts);
            ExtensionLogger.log(`Hydra Helper: Filtering completion items...`);
            return completions.items
                // .filter(item => item.kind && relevantKinds.includes(item.kind))
                .map(item => {
                    const shortLabel = typeof item.label === 'string' ? item.label : item.label.label;
                    const fullPath = modulePath ? `${modulePath}.${shortLabel}` : shortLabel;
                    const newItem = new vscode.CompletionItem(item.label, item.kind);
                    newItem.insertText = fullPath;
                    newItem.detail = item.detail;
                    newItem.documentation = item.documentation;
                    newItem.sortText = item.sortText;
                    newItem.filterText = fullPath;
                    newItem.preselect = item.preselect;
                    newItem.commitCharacters = item.commitCharacters;
                    newItem.command = item.command;
                    newItem.tags = item.tags;
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
