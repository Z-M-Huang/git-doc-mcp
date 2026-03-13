# Example Template

This directory contains an example manifest and actions for creating a git-doc-mcp MCP server.

## Structure

```
.mcp/
├── manifest.yml          # Manifest defining tools, resources, prompts
└── actions/
    ├── fetch-file.v1.js  # Fetch file from repository
    └── search-code.v1.js # Search code in repository
```

## Usage

1. Copy this `.mcp/` directory to your repository
2. Update `manifest.yml`:
   - Change `owner/repo` to your actual GitHub owner/repo
   - Update action URLs to point to your hosted actions
   - Calculate and update `actionHash` values
3. Host the manifest and actions (GitHub Pages, S3, etc.)
4. Use with git-doc-mcp CLI:

```bash
npx git-doc-mcp --manifest https://your-domain.com/.mcp/manifest.yml
```

## Customization

### Fetch File Action

Edit `fetch-file.v1.js`:
- Update `owner` and `repo` variables
- Change `branch` if needed

### Search Code Action

Edit `search-code.v1.js`:
- Update `owner` and `repo` variables

### Adding New Tools

1. Create a new action file in `actions/`
2. Add tool definition to `manifest.yml`
3. Calculate SHA-256 hash of action file for `actionHash`:

```bash
sha256sum actions/your-action.v1.js
```

## Calculating Action Hash

```bash
# Linux/macOS
sha256sum .mcp/actions/fetch-file.v1.js
# or
shasum -a 256 .mcp/actions/fetch-file.v1.js

# Then prepend "sha256:" to the hash
# Example: sha256:abc123...
```