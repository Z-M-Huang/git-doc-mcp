# CLAUDE.md - Development Guide

## Project Overview

git-doc-mcp is a **declarative MCP manifest system** that lets anyone create and host MCP servers without running infrastructure. It consists of:

- **@git-doc-mcp/core** - Core library with manifest loading, sandbox execution, worker process management, and MCP server setup
- **git-doc-mcp** (CLI) - Command-line interface for running MCP servers from manifests
- **template** - Example manifest and actions for reference

## Development Setup

### Prerequisites

- Node.js 18+
- npm (comes with Node.js)

### Installation

```bash
npm install
```

### Build

```bash
npm run build
```

### Development

```bash
# Watch mode for core package
cd packages/core && npm run dev

# Watch mode for CLI
cd packages/cli && npm run dev
```

### Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
cd packages/core && npm run test:watch
```

## Project Structure

```
git-doc-mcp/
├── packages/
│   ├── core/                   # Core library
│   │   ├── src/
│   │   │   ├── manifest/       # Manifest loading and validation
│   │   │   │   ├── schema.ts   # Zod schema for manifest
│   │   │   │   └── loader.ts   # URL and file loader
│   │   │   ├── sandbox/        # Sandbox execution
│   │   │   │   ├── executor.ts # isolated-vm wrapper
│   │   │   │   ├── context.ts  # Action context
│   │   │   │   └── url-validator.ts # SSRF protection
│   │   │   ├── worker/         # Worker process
│   │   │   │   ├── process.ts  # Process management
│   │   │   │   ├── protocol.ts # IPC protocol
│   │   │   │   └── worker-entry.ts # Worker entry point
│   │   │   ├── secrets/        # Secret management
│   │   │   │   ├── manager.ts  # Approval and scoping
│   │   │   │   └── patterns.ts # URL pattern matching
│   │   │   ├── server/         # MCP server
│   │   │   │   └── mcp.ts      # Server setup
│   │   │   ├── http/           # HTTP client
│   │   │   │   ├── client.ts   # Fetch with validation
│   │   │   │   └── redirect-utils.ts # Cross-origin header stripping
│   │   │   ├── audit/          # Audit logging
│   │   │   │   └── logger.ts   # JSONL audit logger with rotation
│   │   │   └── rate-limit/     # Rate limiting
│   │   │       └── limiter.ts  # Sliding-window rate limiter
│   │   └── package.json
│   │
│   ├── cli/                    # CLI package
│   │   ├── src/
│   │   │   ├── index.ts        # Entry point
│   │   │   └── commands/
│   │   │       └── serve.ts    # Serve command
│   │   └── package.json
│   │
│   └── template/               # Example manifest
│       └── .mcp/
│           ├── manifest.yml
│           └── actions/
│
├── package.json                # Monorepo root
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Architecture

### Data Flow

```
1. CLI starts
2. Load manifest from URL or file
3. Validate manifest schema
4. Check TOFU (trust-on-first-use)
5. Setup secrets manager
6. Create MCP server
7. On tool call:
   a. Fetch action script (if not cached)
   b. Verify action hash
   c. Spawn worker process
   d. Execute action in sandbox
   e. Return result
```

### Three-Layer Isolation

1. **Worker Process** - Primary security boundary
   - Separate Node.js process with sanitized environment
   - Crash doesn't affect main process
   - Configurable memory limit (default 128MB, via `--memory-limit`)

2. **isolated-vm** - Defense-in-depth
   - Memory limit: 128MB
   - CPU timeout: 30s
   - No direct filesystem/network access

3. **Controlled API** - URL validation
   - SSRF protection
   - Secret scope validation
   - Redirect validation

### IPC Protocol

Worker communication uses newline-delimited JSON over stdin/stdout:

```typescript
// Request
{ "id": "uuid", "type": "execute", "payload": {...} }

// Response
{ "id": "uuid", "type": "result", "result": {...} }
{ "id": "uuid", "type": "error", "error": {...} }
```

## Coding Standards

### TypeScript

- Strict mode enabled
- Use ES modules (type: "module")
- Use NodeNext module resolution
- Prefer `async/await` over Promises

### Naming

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`

### Exports

- Use explicit exports: `export { X } from './file.js'`
- Include `.js` extension in imports

### Testing

- Unit tests in `src/__tests__/*.test.ts` files
- Run with `npm test`
- Test framework: Vitest

```bash
# Run tests once
npm test

# Run in watch mode during development
cd packages/core && npm run test:watch
```

## Common Tasks

### Adding a New CLI Flag

1. Add option to BOTH top-level and `serve` subcommand in `packages/cli/src/index.ts`
2. Update `ServeOptions` interface in `serve.ts`
3. Implement handling in `serveCommand`

### Creating a New Action API

1. Add to `ActionContext` interface in `packages/core/src/sandbox/context.ts`
2. Implement in `createActionContext` function
3. Update documentation

### Debugging Sandbox Issues

1. Check worker process logs (stderr)
2. Increase timeout/memory limits
3. Use `ctx.log` in action for debugging

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server implementation |
| `isolated-vm` | JavaScript sandbox |
| `js-yaml` | YAML parsing |
| `zod` | Schema validation |
| `commander` | CLI argument parsing |

## Security Considerations

### SSRF Protection

All URLs are validated before fetch:
- HTTPS-only by default (`--allow-http` to override)
- Private IP ranges blocked (10.x, 172.16-31.x, 192.168.x, localhost)
- DNS resolution validated
- Every redirect URL re-validated
- Cross-origin redirects strip Authorization/Cookie headers

### Secret Scoping

Secrets accessed via `ctx.getSecret(name, url)` with URL scope validation:
- Pattern: `https://api.github.com/*`
- Path-boundary-aware wildcard matching (`/repos/*` won't match `/repos-private`)
- No subdomain matching, exact origin required

### Manifest Integrity

- TOFU on first use (stores hash, fail-closed on change)
- Hash pinning via `--manifest-hash`
- `--trust-changed` flag to accept manifest changes

### Rate Limiting

- Sliding-window rate limiter via `--rate-limit <calls-per-minute>`
- Default: unlimited (0)

### Audit Logging

- All `ctx.fetch` calls logged to `~/.git-doc-mcp/logs/audit.jsonl`
- Includes: URL, status, duration, redirects, secret access
- Automatic log rotation

## Testing

### Unit Tests

Located in `packages/core/src/__tests__/`:

```bash
# Run all tests
npm test

# Run specific test file
cd packages/core && npx vitest run src/__tests__/manifest/schema.test.ts

# Watch mode
cd packages/core && npm run test:watch
```

### Test Coverage (268 tests across 16 files)

- `manifest/schema.test.ts` - Manifest schema validation
- `manifest/loader.test.ts` - URL/file loading, HTTP rejection, redirect handling
- `secrets/patterns.test.ts` - URL scope pattern matching
- `secrets/manager.test.ts` - Secret approval, scoping, getSecret
- `sandbox/executor.test.ts` - Sandbox execution, json() method, size limits
- `sandbox/context.test.ts` - Action context, fetch, audit logging
- `sandbox/url-validator.test.ts` - SSRF protection, private IPs, DNS
- `worker/process.test.ts` - Worker lifecycle, crash recovery
- `worker/protocol.test.ts` - IPC message framing
- `worker/worker-entry.test.ts` - Request handling, memoryLimit forwarding
- `server/mcp.test.ts` - MCP server registration
- `http/client.test.ts` - HTTP client, HTTPS enforcement
- `http/redirect-utils.test.ts` - Cross-origin header stripping
- `rate-limit/limiter.test.ts` - Sliding-window rate limiter
- `audit/logger.test.ts` - Audit logging, rotation
- `security/regression.test.ts` - Security regression tests

## Common Issues

### Build Errors

If you see TypeScript errors:
1. Run `npm run build` to compile
2. Check that all imports use `.js` extension
3. Verify `composite: true` in package tsconfig.json

### Test Failures

If tests fail:
1. Check that source files are compiled (`npm run build`)
2. Verify test imports match actual exports
3. Check that test data matches schema requirements

## Release Process

1. Update version in package.json files
2. Run `npm run build && npm test`
3. Create git tag
4. Publish to npm