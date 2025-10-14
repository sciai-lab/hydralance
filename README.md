# HydraLance

HydraLance is a VS Code extension that provides intelligent language support for Hydra configuration files. It bridges the gap between YAML configuration files and Python code by leveraging Pylance to provide code intelligence for `_target_` references and their parameters.

## Features

### 1. Go-to-Definition for `_target_` Values
Click on any `_target_` value in your YAML configuration to jump directly to the Python source code:

```yaml
model:
  _target_: torch.nn.Linear  # Ctrl+Click to go to PyTorch source
  in_features: 128
  out_features: 64
```

### 2. Auto-completion for `_target_` Values
Get intelligent suggestions for Python modules, classes, and functions:

```yaml
model:
  _target_: torch.nn.  # Auto-complete shows Linear, Conv2d, etc.
```

### 3. Parameter Auto-completion (NEW!)
Get intelligent parameter suggestions based on the target class/function signature:

```yaml
model:
  _target_: torch.nn.Linear
  # Type here to get completions for: in_features, out_features, bias, device, dtype
  
optimizer:
  _target_: torch.optim.Adam
  # Type here to get completions for: lr, betas, eps, weight_decay, amsgrad
```

### 4. Error Detection and Linting
Invalid `_target_` references are highlighted with error diagnostics:

```yaml
model:
  _target_: torch.nn.InvalidClass  # Shows error: cannot be resolved
```

## How It Works

HydraLance uses a clever approach with in-memory "shadow" Python documents:

1. **Shadow Documents**: Creates virtual Python files containing import statements derived from `_target_` values
2. **Pylance Integration**: Leverages Pylance's language server capabilities for Python symbol resolution
3. **Parameter Extraction**: Uses signature help to get parameter information from Python functions/classes
4. **YAML Context Parsing**: Understands YAML structure to provide context-aware completions

## Requirements

- **Pylance Extension**: HydraLance requires the [Pylance extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) to function
- **Python Environment**: A configured Python environment with the packages you're referencing in your configurations

## Installation

1. Install the Pylance extension (if not already installed)
2. Install HydraLance from the VS Code marketplace
3. Open a YAML file with Hydra configurations

The extension will automatically:
- Check for Pylance availability
- Wait for Pylance to be ready
- Create a `hydralance/` folder for temporary files
- Offer to add this folder to your `.gitignore`

## Extension Settings

This extension contributes the following settings:

* `hydralance.hideHelperFolder`: Hide the `hydralance` folder from the VS Code explorer (default: true)

## Known Issues

- Parameter completion works best with well-documented Python packages
- Some dynamic or heavily decorated functions may not provide complete parameter information
- Large configuration files may experience slight delays during initial analysis

## Release Notes

### 0.0.1

Initial release featuring:
- Go-to-definition for `_target_` values
- Auto-completion for Python imports
- Parameter auto-completion for target functions/classes
- Error detection and linting
- Integration with Pylance

---

## Development

This extension is built with TypeScript and uses the VS Code Extension API. It creates temporary Python files in `hydralance/` to facilitate communication with Pylance.

**Enjoy intelligent Hydra configuration editing!**
