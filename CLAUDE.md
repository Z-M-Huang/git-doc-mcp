# CLAUDE.md - Development Guide

## Project Overview

git-mcp is a **declarative MCP manifest system** that lets anyone create and host MCP servers without running infrastructure. It consists of:

- **@git-mcp/core** - Core library with manifest loading, sandbox execution, worker process management, and MCP server setup
- **git-mcp** (CLI) - Command-line interface for running MCP servers from manifests
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
git-mcp/
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
│   │   │   │   └── protocol.ts # IPC protocol
│   │   │   ├── secrets/        # Secret management
│   │   │   │   ├── manager.ts  # Approval and scoping
│   │   │   │   └── patterns.ts # URL pattern matching
│   │   │   ├── server/         # MCP server
│   │   │   │   └── mcp.ts      # Server setup
│   │   │   └── http/           # HTTP client
│   │   │       └── client.ts   # Fetch with validation
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
   - Separate Node.js process
   - OS-level resource limits
   - Crash doesn't affect main process

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

1. Add option to `packages/cli/src/index.ts`
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
- Only HTTPS allowed
- Private IP ranges blocked
- DNS rebinding protection
- Redirect validation

### Secret Scoping

Secrets are only available for URLs matching their scope patterns:
- Pattern: `https://api.github.com/*`
- No subdomain matching
- Exact origin required

### Manifest Integrity

- TOFU on first use
- Hash pinning via `--manifest-hash`
- Warning on manifest change

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

### Test Coverage

- `manifest/schema.test.ts` - Manifest schema validation
- `secrets/patterns.test.ts` - URL scope pattern matching
- `sandbox/url-validator.test.ts` - SSRF protection

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