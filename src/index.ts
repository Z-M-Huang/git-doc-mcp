/**
 * @git-doc-mcp/core - Core library for git-doc-mcp
 *
 * Provides:
 * - Manifest loading and validation
 * - Sandbox execution with isolated-vm
 * - Worker process management
 * - Secret scoping and approval
 * - MCP server setup
 *
 * @example
 * ```typescript
 * import { loadManifest, createMcpServer, startMcpServer } from '@git-doc-mcp/core';
 *
 * const result = await loadManifest({ manifestPath: './manifest.yml' });
 * const server = createMcpServer({
 *   manifest: result.manifest,
 *   onToolCall: async (name, input) => {
 *     // Execute tool
 *     return { content: [{ type: 'text', text: 'result' }] };
 *   },
 * });
 * await startMcpServer(server);
 * ```
 *
 * @module @git-doc-mcp/core
 */

// Manifest
export * from './manifest/index.js';

// Secrets
export * from './secrets/index.js';

// Sandbox
export * from './sandbox/index.js';

// Worker
export * from './worker/index.js';

// Server
export * from './server/index.js';

// HTTP
export * from './http/index.js';

// Audit
export * from './audit/index.js';

// Rate limiting
export * from './rate-limit/index.js';