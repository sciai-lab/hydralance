import * as vscode from 'vscode';

// This function is called when the extension is activated.
export function activate(context: vscode.ExtensionContext) {

    console.log('Hydra Helper extension is now becoming active!');
    // --- 1. Registration ---
    // Register our definition provider for YAML files.
    // This means `provideDefinition` will be called when a user tries to jump to a definition in a YAML file.
    const provider = vscode.languages.registerDefinitionProvider(
        { language: 'yaml' },
        new HydraDefinitionProvider()
    );

    // Add the provider to the context's subscriptions to ensure it's disposed of when the extension is deactivated.
    context.subscriptions.push(provider);

    console.log('Hydra Helper extension is now active!');
}

class HydraDefinitionProvider implements vscode.DefinitionProvider {
    
    // This is the required method for a DefinitionProvider.
	public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {

        // ADDED: This is our most important new log.
        console.log('Hydra Helper: provideDefinition method was triggered.');

        const lineText = document.lineAt(position.line).text;
        const match = lineText.match(/_target_:\s*['"]?([\w\.]+)['"]?/);
        
        if (!match) {
            // EDITED: More specific log message.
            console.log(`Hydra Helper: The regex did not find a _target_ on the line: "${lineText}"`);
            return undefined;
        }

        // ... the rest of the function remains the same
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

        try {
            const virtualDoc = await vscode.workspace.openTextDocument({
                content: pythonCode,
                language: 'python'
            });

            const positionInVirtualDoc = new vscode.Position(0, pythonCode.indexOf(className));
            
            console.log('Hydra Helper: Asking Pylance for the definition...');
            
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                virtualDoc.uri,
                positionInVirtualDoc
            );

            if (locations && locations.length > 0) {
                console.log(`Hydra Helper: Pylance found a definition at: ${locations[0].uri.fsPath}`);
                return locations;
            } else {
                console.log('Hydra Helper: Pylance could not find a definition.');
            }

        } catch (error) {
            console.error('Hydra Helper: An error occurred.', error);
            return undefined;
        }

        return undefined;
    }
}

// This function is called when your extension is deactivated.
export function deactivate() {}
