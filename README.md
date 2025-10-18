# HydraLance

HydraLance is a VS Code extension that provides intelligent language support for [Hydra](https://hydra.cc/) configuration files. It bridges the gap between YAML configuration files and Python code by leveraging Pylance to provide code intelligence for `_target_` references, parameter completion, and indexes `.yaml` files resolve Hydra interpolations.

If you find HydraLance useful, please consider giving it a ⭐ on [GitHub](https://github.com/imagirom/hydralance)!

## ✨ Features

### 1. 🎯 Go-to-Definition for `_target_` Values
Navigate directly from YAML configurations to Python source code:

```yaml
model:
  _target_: torch.nn.Linear  # Ctrl+Click to go to PyTorch source
  in_features: 128
  out_features: 64
```

Pro tip: Use `Ctrl+Shift+F10` to peek at the definition without leaving your current context.

### 2. 🔍 Auto-completion for `_target_` Values
Get intelligent suggestions for Python modules, classes, and functions:

```yaml
model:
  _target_: torch.nn.  # Auto-complete shows Linear, Conv2d, etc.
```

### 3. ⚡ Parameter Auto-completion
Get intelligent parameter suggestions based on the target class/function signature:

```yaml
model:
  _target_: torch.nn.Linear
  # Type here to get completions for: in_features, out_features, bias
  
optimizer:
  _target_: torch.optim.Adam
  # Type here to get completions for: lr, betas, eps, weight_decay, amsgrad, ...
```

### 5. 🏗️ Defaults List Navigation
Navigate to referenced config files in Hydra defaults lists:

```yaml
defaults:
  - default              # Ctrl+Click to go to .default.yaml
  - dataset: imagenet    # Ctrl+Click to open ./dataset/imagenet.yaml
```

Resolved filenames are displayed on hover.

### 4. 🔗 Interpolation Resolution
Navigate between Hydra config interpolations across your entire project:

```yaml
# In config/dataset/imagenet.yaml
name: imagenet_1k
classes: 1000

# In config/experiment/main.yaml  
experiment:
  dataset_name: "${dataset.name}"     # Ctrl+Click to go to definition(s)
```

**Features:**
- **Cross-file resolution**: Find interpolation targets across your entire workspace
- **Smart filtering**: Multiple match filtering options (all, top matches, perfect matches)
- **Workspace isolation**: Keep matches within workspace boundaries
- **Level-based ranking**: Most specific matches shown first

### 6. 🚨 Error Detection and Linting
Invalid `_target_` references are highlighted with error diagnostics:

```yaml
model:
  _target_: torch.nn.InvalidClass  # Shows error: cannot be resolved
```

## 🔧 How It Works

HydraLance uses multiple approaches:

### For `_target_` Features:
1. **Shadow Documents**: Creates virtual Python files containing import statements derived from `_target_` values
2. **Pylance Integration**: Leverages Pylance's language server capabilities for Python symbol resolution
3. **Parameter Extraction**: Uses signature help to get parameter information from Python functions/classes

### For Interpolation Resolution:
1. **Workspace Indexing**: Scans and indexes all YAML files in your workspace
2. **Reverse Path Matching**: Builds a reverse lookup index for efficient interpolation resolution
3. **Logical Path Construction**: Maps file paths and YAML keys to Hydra's logical namespace

## 📋 Requirements

- **Pylance Extension**: HydraLance requires the [Pylance extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) to function
- **Python Environment**: A configured Python environment with the packages you're referencing in your configurations

## 📦 Installation

1. Install the Pylance extension (you probably already have it)
2. Install HydraLance from the VS Code marketplace
3. Open a YAML file with Hydra configurations

The extension will automatically:
- Check for Pylance availability
- Wait for Pylance to be ready
- Index your YAML files for interpolation resolution
- Create a `hydralance/` folder for temporary files
- Offer to add this folder to your `.gitignore`

## ⚙️ Extension Settings

### Core Settings
* **`hydralance.hideHelperFolder`** *(boolean, default: true)*  
  Hide the `hydralance` folder from the VS Code explorer

### Interpolation Resolution Settings  
* **`hydralance.excludePatterns`** *(array, default: [".venv/**"])*  
  Glob patterns to exclude from YAML file indexing for interpolation resolution

* **`hydralance.matchFilter`** *(enum, default: "top matches only")*  
  Controls which interpolation matches are shown:
  - `"all"` - Shows all matches found
  - `"top matches only"` - Shows only the highest level matches found
  - `"perfect matches only"` - Shows only matches that exactly match the interpolation depth

* **`hydralance.isolateWorkspaceFolders`** *(boolean, default: true)*  
  When enabled, interpolation resolution only considers files within the same workspace folder

## 🎮 Commands

Access these commands via the Command Palette (`Ctrl+Shift+P`):

* **`HydraLance: Generate Diagnostic Info`** - Generate diagnostic information for troubleshooting
* **`HydraLance: Show Logs`** - Show extension logs in the output panel  
* **`HydraLance: Refresh YAML Index`** - Refresh the YAML file index

## Notice

HydraLance is an independent project and is not affiliated with or endorsed by the Hydra project or its maintainers. Use at your own discretion.

