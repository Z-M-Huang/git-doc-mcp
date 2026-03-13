# git-mcp - Turn Any Manifest into an MCP Server

[![npm version](https://badge.fury.io/js/git-mcp.svg)](https://www.npmjs.com/package/git-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Linux](https://img.shields.io/badge/Linux-supported-success.svg)](https://github.com)
[![macOS](https://img.shields.io/badge/macOS-supported-success.svg)](https://github.com)
[![Windows](https://img.shields.io/badge/Windows-supported-success.svg)](https://github.com)

**Write a manifest, host it anywhere, and users can instantly use it with their AI tools.**

## What is git-mcp?

git-mcp is a **declarative MCP manifest system** that lets anyone create and host MCP servers without running infrastructure. It turns any manifest URL into a fully-functional MCP server with custom tools, resources, and prompts - all defined in YAML.

**Key features:**
- **No hosting required** - Use GitHub Pages, GitLab Pages, S3, any static hosting
- **Custom JavaScript actions** - Define your own tool logic
- **Capability-scoped secrets** - Fine-grained access control with URL pattern matching
- **Platform-agnostic** - Works with GitHub, GitLab, S3, local files
- **TOFU manifest verification** - Trust-on-first-use with fail-closed security
- **Three-layer isolation** - Worker process + isolated-vm + URL validation
- **Cross-platform** - Linux, macOS, Windows

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
git clone https://github.com/user/git-mcp.git
cd git-mcp
npm install
npm run build
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
# Via CLI flag
npx git-mcp --manifest https://example.com/.mcp/manifest.yml \
  --secret GITHUB_TOKEN=$GITHUB_TOKEN

# Via environment variable
export GIT_MCP_SECRET_GITHUB_TOKEN=$GITHUB_TOKEN
npx git-mcp --manifest https://example.com/.mcp/manifest.yml
```

### Hash Pinning (for CI/CD)

```bash
npx git-mcp --manifest https://example.com/.mcp/manifest.yml \
  --manifest-hash sha256:abc123...
```

### Rate Limiting

```bash
# Limit to 30 tool calls per minute
npx git-mcp --manifest https://example.com/.mcp/manifest.yml \
  --rate-limit 30
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
export default async function myAction(input, ctx) {
  const { fetch, getSecret, log, manifest } = ctx;

  log('info', `Running action for ${manifest.name}`);

  // Get a secret scoped to the target URL
  const url = 'https://api.example.com/data';
  const token = getSecret('API_KEY', url);

  const response = await fetch(url, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  });

  // response.text is a property (not a method)
  // response.json() is a synchronous method
  const data = response.json();

  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}
```

### Context Methods

| Method | Description |
|--------|-------------|
| `ctx.fetch(url, options)` | Scoped fetch with SSRF protection and redirect validation |
| `ctx.getSecret(name, url)` | Get a secret value if the URL matches the secret's scope pattern |
| `ctx.log(level, message)` | Logging (levels: debug, info, warn, error) |
| `ctx.manifest` | Manifest metadata (`{ name, version }`) |

### Fetch Response

`ctx.fetch` returns a serialized response object (not a native `Response`):

| Property/Method | Type | Description |
|-----------------|------|-------------|
| `response.ok` | `boolean` | `true` if status is 200-299 |
| `response.status` | `number` | HTTP status code |
| `response.statusText` | `string` | HTTP status text |
| `response.text` | `string` | Response body as a string (property, not method) |
| `response.json()` | `object` | Parse body as JSON (synchronous method) |
| `response.headers` | `object` | Response headers as key-value pairs |

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

| Option | Description | Default |
|--------|-------------|---------|
| `--manifest <path>` | URL or local path to manifest.yml | (required) |
| `--manifest-header <header>` | Header for fetching manifest (repeatable) | |
| `--manifest-hash <hash>` | Expected manifest hash for pinning | |
| `--action-code-header <header>` | Header for downloading action scripts (repeatable) | |
| `--resource-header <header>` | Header for fetching resources (repeatable) | |
| `--secret <name=value>` | Pre-approved secret (repeatable) | |
| `--timeout <ms>` | Worker timeout in milliseconds | `60000` |
| `--memory-limit <bytes>` | Sandbox memory limit (8MB - 1GB) | `134217728` (128MB) |
| `--rate-limit <n>` | Max tool calls per minute (0 = unlimited) | `0` |
| `--allow-http` | Allow insecure HTTP URLs (HTTPS-only by default) | `false` |
| `--trust-changed` | Accept manifest hash changes (TOFU override) | `false` |

### Environment Variables

Secrets can be provided via environment variables prefixed with `GIT_MCP_SECRET_`:

```bash
export GIT_MCP_SECRET_GITHUB_TOKEN=ghp_abc123
export GIT_MCP_SECRET_API_KEY=sk-xyz789
```

The `--secret` CLI flag takes precedence over environment variables.

### Examples

```bash
# Basic usage
git-mcp --manifest ./manifest.yml

# With authentication headers
git-mcp --manifest https://... \
  --manifest-header "Authorization: Bearer $TOKEN" \
  --action-code-header "Authorization: Bearer $TOKEN"

# Separate resource headers
git-mcp --manifest https://... \
  --resource-header "Authorization: Bearer $RESOURCE_TOKEN"

# With secrets and rate limiting
git-mcp --manifest https://... \
  --secret GITHUB_TOKEN=$TOKEN \
  --rate-limit 60

# Hash pinned (for CI/CD)
git-mcp --manifest https://... --manifest-hash sha256:abc123...

# Accept manifest changes (TOFU override)
git-mcp --manifest https://... --trust-changed

# Custom memory limit (256MB)
git-mcp --manifest https://... --memory-limit 268435456

# Allow HTTP (not recommended for production)
git-mcp --manifest http://localhost:8080/manifest.yml --allow-http
```

## Comparison

| Feature | git-mcp | Context7 | idosal/git-mcp |
|---------|---------|----------|----------------|
| **Hosting** | Any static host | Hosted service | Needs separate server |
| **Custom actions** | User-defined JS | Fixed tools | Limited actions |
| **Private repos** | Auth headers | OAuth | Unknown |
| **Platform** | Any (GitHub, GitLab, S3, etc.) | Any | GitHub only |
| **Local development** | Local files | No | No |
| **Secret scoping** | URL pattern matching | N/A | N/A |
| **Manifest integrity** | TOFU + hash pinning | N/A | N/A |

## Security Model

### Trusted-Manifest System

Users explicitly configure manifest URLs they trust. This is consistent with the official GitHub MCP Server's approach — the user configures which server to use, so they trust the server author.

### Three-Layer Isolation

```
Layer 1: Worker Process (Primary Boundary)
  - Separate Node.js child process
  - Sanitized environment (no inherited credentials)
  - Crash in action doesn't kill CLI

Layer 2: isolated-vm (Defense-in-Depth)
  - Configurable memory limit (default: 128MB)
  - CPU timeout: 30s
  - No direct filesystem/network access

Layer 3: Controlled API Surface
  - ctx.fetch with SSRF protection
  - ctx.getSecret with URL scope validation
  - Audit logging of all network calls
```

### SSRF Protection

All URLs are validated before fetch:
- HTTPS-only by default (use `--allow-http` to override)
- Private IP ranges blocked (10.x, 172.16-31.x, 192.168.x, localhost)
- DNS resolution validated before connection
- Every redirect URL re-validated
- Cross-origin redirects strip sensitive headers (Authorization, Cookie)

### Capability-Scoped Secrets

Secrets are scoped to specific URL patterns:

```yaml
secrets:
  - name: GITHUB_TOKEN
    scope:
      - "https://api.github.com/*"
      - "https://raw.githubusercontent.com/*"
```

`ctx.getSecret(name, url)` only returns the secret value if the URL matches the scope pattern. Path-boundary-aware wildcard matching prevents `/repos-private` from matching a `/repos/*` scope.

### TOFU (Trust-on-First-Use)

On first use, git-mcp stores the manifest's SHA-256 hash. If the manifest changes:

```
Warning: Manifest content has changed since last use!
  Previous: sha256:abc123...
  Current:  sha256:def456...

To accept this change, re-run with: --trust-changed
For CI pinning, use: --manifest-hash sha256:def456...
```

The server exits with a non-zero code unless `--trust-changed` is provided. For CI/CD, use `--manifest-hash` for hard pinning.

### Rate Limiting

Sliding-window rate limiter prevents excessive tool calls:

```bash
# 60 calls per minute
git-mcp --manifest https://... --rate-limit 60
```

### Audit Logging

All `ctx.fetch` calls are logged to `~/.git-mcp/logs/audit.jsonl`:
- URL, HTTP status, duration
- Redirect hops
- Secret access (allowed/denied)
- Action start/end with timing

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Build: `npm run build`
5. Run tests: `npm test`
6. Submit a pull request

### Development Setup

```bash
npm install        # Install dependencies
npm run build      # Build all packages
npm test           # Run all tests (268 tests)
```

### Project Structure

```
git-mcp/
  packages/
    core/          # Manifest loading, sandbox, worker, MCP server
    cli/           # CLI entry point and serve command
    template/      # Example manifest and actions
```

## License

MIT License - see [LICENSE](LICENSE) for details.
