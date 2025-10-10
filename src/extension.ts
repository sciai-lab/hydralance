import * as vscode from 'vscode';
import { Uri } from 'vscode';

// This function is called when the extension is activated.
export function activate(context: vscode.ExtensionContext) {
    console.log('Hydra Helper extension is now becoming active!');

    // Register our custom content provider for virtual Python docs
    const virtualScheme = 'hydra-virtual';
    const virtualContentProvider = new HydraVirtualPythonProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(virtualScheme, virtualContentProvider)
    );

    // Register our definition provider for YAML files.
    const provider = vscode.languages.registerDefinitionProvider(
        { language: 'yaml' },
        new HydraDefinitionProvider(virtualScheme, virtualContentProvider)
    );
    context.subscriptions.push(provider);
    console.log('Hydra Helper extension is now active!');
}

class HydraDefinitionProvider implements vscode.DefinitionProvider {
    private virtualScheme: string;
    private contentProvider: HydraVirtualPythonProvider;

    constructor(virtualScheme: string, contentProvider: HydraVirtualPythonProvider) {
        this.virtualScheme = virtualScheme;
        this.contentProvider = contentProvider;
    }

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        console.log('Hydra Helper: provideDefinition method was triggered.');
        const lineText = document.lineAt(position.line).text;
        const match = lineText.match(/_target_:\s*['"]?([\w\.]+)['"]?/);
        if (!match) {
            console.log(`Hydra Helper: The regex did not find a _target_ on the line: "${lineText}"`);
            return undefined;
        }
        const classPath = match[1];
        console.log(`Hydra Helper: Found potential class path: ${classPath}`);
        const lastDotIndex = classPath.lastIndexOf('.');
        if (lastDotIndex === -1) {
            console.log(`Hydra Helper: Invalid class path format: ${classPath}`);
            return undefined;
        }
        const modulePath = classPath.substring(0, lastDotIndex);
        const className = classPath.substring(lastDotIndex + 1);
        const pythonCode = `from ${modulePath} import ${className}`;
        console.log(`Hydra Helper: Created virtual Python code: "${pythonCode}"`);

        // Store the code in the provider for this request
        const virtualUri = Uri.parse(`${this.virtualScheme}:/virtual.py?module=${encodeURIComponent(modulePath)}&class=${encodeURIComponent(className)}`);
        this.contentProvider.setContent(virtualUri, pythonCode);

        try {
            const virtualDoc = await vscode.workspace.openTextDocument(virtualUri);
            const positionInVirtualDoc = new vscode.Position(0, pythonCode.indexOf(className));
            console.log('Hydra Helper: Asking Pylance for the definition...');
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                virtualDoc.uri,
                positionInVirtualDoc
            );
            // Filter out locations that point to the virtual document
            const filteredLocations = locations?.filter(loc => loc.uri.scheme !== this.virtualScheme);
            if (filteredLocations && filteredLocations.length > 0) {
                console.log(`Hydra Helper: Pylance found a definition at: ${filteredLocations[0].uri.fsPath}`);
                return filteredLocations;
            } else {
                console.log('Hydra Helper: Pylance could not find a definition or only found virtual document.');
            }
        } catch (error) {
            console.error('Hydra Helper: An error occurred.', error);
            return undefined;
        }
        return undefined;
    }
}

// Content provider for virtual Python documents
class HydraVirtualPythonProvider implements vscode.TextDocumentContentProvider {
    private contentMap: Map<string, string> = new Map();

    setContent(uri: vscode.Uri, content: string) {
        this.contentMap.set(uri.toString(), content);
    }

    provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
        return this.contentMap.get(uri.toString()) || '';
    }
}

// This function is called when your extension is deactivated.
export function deactivate() {}
