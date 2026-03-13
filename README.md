# git-mcp - Turn Any Manifest into an MCP Server

[![npm version](https://badge.fury.io/js/git-mcp.svg)](https://www.npmjs.com/package/git-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Write a manifest, host it anywhere, and users can instantly use it with their AI tools.**

## What is git-mcp?

git-mcp is a **declarative MCP manifest system** that lets anyone create and host MCP servers without running infrastructure. It turns any manifest URL into a fully-functional MCP server with custom tools, resources, and prompts - all defined in YAML.

**Key features:**
- 🚀 **No hosting required** - Use GitHub Pages, GitLab Pages, S3, any static hosting
- 🔧 **Custom JavaScript actions** - Define your own tool logic
- 🔐 **Capability-scoped secrets** - Fine-grained access control
- 🌐 **Platform-agnostic** - Works with GitHub, GitLab, S3, local files
- 🔒 **TOFU manifest verification** - Trust-on-first-use for security

## Quick Start

### 1. Install

```bash
# Using npm
npm install -g git-mcp

# Using npx (no install needed)
npx git-mcp --manifest https://example.com/.mcp/manifest.yml
```

### 2. Configure with Claude Code

Add to `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "my-repo": {
      "command": "npx",
      "args": ["git-mcp", "--manifest", "https://example.com/.mcp/manifest.yml"]
    }
  }
}
```

### 3. Create Your Manifest

Create `.mcp/manifest.yml` in your repository:

```yaml
schemaVersion: "1.0"
name: my-repo-mcp
version: 1.0.0
description: MCP server for my repository

tools:
  - name: fetch-file
    description: Fetch a file from the repository
    inputSchema:
      type: object
      properties:
        path: { type: string }
      required: [path]
    action: https://example.com/.mcp/actions/fetch-file.v1.js
    actionHash: "sha256:..."
    annotations:
      readOnlyHint: true
      openWorldHint: true
```

## Installation

### npm

```bash
npm install -g git-mcp
```

### npx (no install)

```bash
npx git-mcp --manifest <url-or-path>
```

### Local Development

```bash
git clone https://github.com/your-org/git-mcp.git
cd git-mcp
pnpm install
pnpm build
```

## Usage Examples

### Public Manifest

```bash
npx git-mcp --manifest https://raw.githubusercontent.com/owner/repo/main/.mcp/manifest.yml
```

### Private Manifest with Authentication

```bash
npx git-mcp --manifest https://private.example.com/.mcp/manifest.yml \
  --manifest-header "Authorization: Bearer $TOKEN"
```

### Local Development

```bash
npx git-mcp --manifest ./path/to/manifest.yml
```

### With Pre-approved Secrets

```bash
npx git-mcp --manifest https://example.com/.mcp/manifest.yml \
  --secret GITHUB_TOKEN=$GITHUB_TOKEN
```

### Hash Pinning (for CI/CD)

```bash
npx git-mcp --manifest https://example.com/.mcp/manifest.yml \
  --manifest-hash sha256:abc123...
```

## Manifest Schema

```yaml
schemaVersion: "1.0"           # Required - schema version
name: my-repo-mcp              # Required - server name
version: 1.0.0                 # Required - semantic version
description: Description       # Optional - shown to AI
instructions: Use when...      # Optional - helps AI understand when to use

secrets:                       # Optional - secrets needed
  - name: GITHUB_TOKEN
    description: GitHub token
    scope:
      - "https://api.github.com/*"
    required: false

tools:                         # Required - at least one tool
  - name: fetch-file
    title: Fetch File          # Optional - human-readable title
    description: Fetch a file  # Required
    inputSchema:               # Required - JSON Schema
      type: object
      properties:
        path: { type: string }
      required: [path]
    action: https://...        # Required - URL to action script
    actionHash: sha256:...     # Required - SHA-256 hash
    annotations:               # Optional - hints for AI
      readOnlyHint: true
      destructiveHint: false
      idempotentHint: true
      openWorldHint: true

resources:                     # Optional - static resources
  - name: readme
    uri: https://...
    description: README
    mimeType: text/markdown

prompts:                       # Optional - prompt templates
  - name: explain-code
    description: Explain code
    args:
      - name: path
        required: true
```

## Action API

Actions are plain JavaScript files that export a default async function:

```javascript
/**
 * @param {object} input - Tool input matching inputSchema
 * @param {object} ctx - Execution context
 * @param {object} ctx.manifest - Manifest metadata
 * @param {function} ctx.fetch - Scoped fetch function
 * @param {object} ctx.secrets - User-approved secrets
 * @param {function} ctx.log - Logging function
 */
export default async function myAction(input, ctx) {
  const { fetch, secrets, log } = ctx;

  log('info', 'Starting action');

  const response = await fetch('https://api.example.com/data', {
    headers: secrets.API_KEY ? { 'Authorization': `Bearer ${secrets.API_KEY}` } : {}
  });

  const data = await response.json();

  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}
```

### Context Methods

| Method | Description |
|--------|-------------|
| `ctx.fetch(url, options)` | Scoped fetch with URL validation and redirect handling |
| `ctx.secrets` | User-approved secrets (only those in scope for URL) |
| `ctx.log(level, message)` | Logging (levels: debug, info, warn, error) |
| `ctx.manifest` | Manifest metadata (name, version) |

### Return Format

```javascript
// Success
return {
  content: [{ type: 'text', text: 'Result' }]
};

// Error
return {
  content: [{ type: 'text', text: 'Error message' }],
  isError: true
};
```

## CLI Reference

### Options

| Option | Description |
|--------|-------------|
| `--manifest <path>` | URL or local path to manifest.yml (required) |
| `--manifest-header <header>` | Header for fetching manifest (repeatable) |
| `--manifest-hash <hash>` | Expected manifest hash for pinning |
| `--action-code-header <header>` | Header for downloading actions (repeatable) |
| `--secret <name=value>` | Pre-approved secret (repeatable) |
| `--timeout <ms>` | Worker timeout (default: 60000) |
| `--memory-limit <bytes>` | Memory limit (default: 134217728) |

### Examples

```bash
# Basic usage
git-mcp --manifest ./manifest.yml

# With authentication
git-mcp --manifest https://... --manifest-header "Authorization: Bearer $TOKEN"

# With secrets
git-mcp --manifest https://... --secret GITHUB_TOKEN=$TOKEN --secret API_KEY=$KEY

# Hash pinned (for CI/CD)
git-mcp --manifest https://... --manifest-hash sha256:abc123...
```

## Comparison

| Feature | git-mcp | Context7 | idosal/git-mcp |
|---------|---------|----------|----------------|
| **Hosting** | Any static host | Hosted service | Needs separate server |
| **Custom actions** | ✅ User-defined JS | ❌ Fixed tools | ❌ Limited actions |
| **Private repos** | ✅ Auth headers | ✅ OAuth | ❓ Unknown |
| **Platform** | Any (GitHub, GitLab, S3, etc.) | Any | GitHub only |
| **Local development** | ✅ Local files | ❌ | ❌ |

## Security Model

### Trusted-Manifest System

Users explicitly configure manifest URLs they trust. This is consistent with the official GitHub MCP Server's approach.

### Three-Layer Isolation

```
┌─────────────────────────────────────────────────┐
│  Layer 1: Worker Process (Primary Boundary)    │
│  - Separate Node.js child process               │
│  - Crash in action doesn't kill CLI             │
└─────────────────────────────────────────────────┘
                      │
┌─────────────────────────────────────────────────┐
│  Layer 2: isolated-vm (Defense-in-Depth)       │
│  - Memory limit: 128MB default                  │
│  - Timeout: 30s default                         │
└─────────────────────────────────────────────────┘
                      │
┌─────────────────────────────────────────────────┐
│  Layer 3: Controlled API Surface               │
│  - ctx.fetch with URL validation                │
│  - ctx.secrets (user-approved, scoped)          │
└─────────────────────────────────────────────────┘
```

### Capability-Scoped Secrets

Secrets are scoped to specific URL patterns:

```yaml
secrets:
  - name: GITHUB_TOKEN
    scope:
      - "https://api.github.com/*"
      - "https://raw.githubusercontent.com/*"
```

The `ctx.fetch` function validates that every URL (including redirects) matches approved scopes.

### TOFU (Trust-on-First-Use)

On first use, git-mcp stores the manifest hash. If the hash changes, it warns the user:

```
⚠️  Manifest content has changed since last use!
  Previous: sha256:abc123...
  Current:  sha256:def456...
```

For CI/CD, use `--manifest-hash` for hard pinning.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `pnpm test`
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.