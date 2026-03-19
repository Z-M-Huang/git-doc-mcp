/**
 * Serve command - starts MCP server from a manifest.
 * @module commands/serve
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as url from 'node:url';
import {
  loadManifest,
  createMcpServer,
  startMcpServer,
  SecretsManager,
  fetchContent,
  loadLocalContent,
  verifyHash,
  WorkerManager,
  Manifest,
  validateUrl,
  createAuditLogger,
  RateLimiter,
} from '../../index.js';

function isHttpUrl(val: string): boolean {
  return val.startsWith('http://') || val.startsWith('https://');
}

function resolveLocalPath(relativePath: string, baseDir: string): string {
  return path.isAbsolute(relativePath) ? relativePath : path.resolve(baseDir, relativePath);
}

/**
 * Serve command options.
 */
export interface ServeOptions {
  manifest: string;
  manifestHeader: string[];
  manifestHash?: string;
  actionCodeHeader: string[];
  resourceHeader: string[];
  secret: string[];
  timeout: string;
  memoryLimit: string;
  allowHttp: boolean;
  trustChanged: boolean;
  rateLimit: string;
}

/**
 * Execute the serve command.
 */
export async function serveCommand(options: ServeOptions): Promise<void> {
  const {
    manifest: manifestPath,
    manifestHeader,
    manifestHash: pinnedHash,
    actionCodeHeader,
    resourceHeader: resourceHeaderRaw,
    secret: preApprovedSecrets,
    timeout,
    memoryLimit: memoryLimitStr,
    allowHttp,
    trustChanged,
  } = options;

  const memoryLimitBytes = parseInt(memoryLimitStr, 10);
  if (!Number.isFinite(memoryLimitBytes) || memoryLimitBytes < 8 * 1024 * 1024 || memoryLimitBytes > 1024 * 1024 * 1024) {
    console.error(`Error: --memory-limit must be an integer between 8388608 (8MB) and 1073741824 (1GB). Got: ${memoryLimitStr}`);
    process.exit(1);
  }
  if (memoryLimitBytes !== 128 * 1024 * 1024) {
    console.error(`Using custom memory limit: ${memoryLimitBytes} bytes (${(memoryLimitBytes / 1024 / 1024).toFixed(0)}MB)`);
  }

  // Rate limiting
  const rateLimitValue = parseInt(options.rateLimit, 10);
  if (!Number.isFinite(rateLimitValue) || rateLimitValue < 0) {
    console.error(`Error: --rate-limit must be a non-negative integer. Got: ${options.rateLimit}`);
    process.exit(1);
  }
  const rateLimiter = rateLimitValue > 0 ? new RateLimiter(rateLimitValue, 60_000) : null;
  if (rateLimiter) {
    console.error(`Rate limiting enabled: ${rateLimitValue} calls/minute`);
  }

  // Create audit logger (single instance for the main process)
  const auditLogger = createAuditLogger();

  // Parse headers
  const manifestHeaders = parseHeaders(manifestHeader);
  const actionHeaders = parseHeaders(actionCodeHeader);
  const resourceHeaders = parseHeaders(resourceHeaderRaw ?? []);

  // Parse pre-approved secrets
  const secrets = parseSecrets(preApprovedSecrets);

  // Load manifest
  console.error(`Loading manifest from: ${manifestPath}`);
  const manifestResult = await loadManifest({
    manifestPath,
    headers: manifestHeaders,
    auditLogger,
    allowHttp,
  });

  // Verify manifest hash if pinned
  if (pinnedHash) {
    if (manifestResult.hash !== pinnedHash) {
      auditLogger.logError('Manifest hash mismatch', { expected: pinnedHash, got: manifestResult.hash });
      console.error(`Error: Manifest hash mismatch!`);
      console.error(`  Expected: ${pinnedHash}`);
      console.error(`  Got: ${manifestResult.hash}`);
      process.exit(1);
    }
  } else {
    // TOFU: Check if manifest hash changed
    await checkTofu(manifestPath, manifestResult.hash, trustChanged);
  }

  const { manifest } = manifestResult;

  // Compute base directory for resolving relative paths in manifest
  const manifestBaseDir = isHttpUrl(manifestResult.source)
    ? undefined
    : path.dirname(manifestResult.source);

  // Setup secrets manager
  const secretsManager = new SecretsManager();

  // Approve pre-approved secrets from --secret flags
  for (const [name, value] of Object.entries(secrets)) {
    const secretDef = manifest.secrets?.find((s) => s.name === name);
    if (secretDef) {
      secretsManager.approve(secretDef, value);
      console.error(`Approved secret: ${name}`);
    }
  }

  // Check environment variables for missing secrets (AC6)
  // --secret flag takes precedence over env vars
  for (const secret of manifest.secrets ?? []) {
    if (!secretsManager.isApproved(secret.name)) {
      const envName = 'GIT_MCP_SECRET_' + secret.name.toUpperCase().replace(/-/g, '_');
      const envValue = process.env[envName];
      if (envValue !== undefined) {
        secretsManager.approve(secret, envValue);
        console.error(`Approved secret from env: ${secret.name} (${envName})`);
      }
    }
  }

  // Prompt for missing required secrets
  for (const secret of manifest.secrets ?? []) {
    if (secret.required && !secretsManager.isApproved(secret.name)) {
      console.error(`Error: Required secret "${secret.name}" not provided`);
      process.exit(1);
    }
  }

  // Create worker manager with audit logger
  const workerManager = new WorkerManager({
    timeout: parseInt(timeout, 10),
    logger: console.error,
    auditLogger,
  });

  // Action cache
  const actionCache = new Map<string, string>();

  // Reject local action paths in remote manifests eagerly at startup
  for (const tool of manifest.tools ?? []) {
    if (!isHttpUrl(tool.action) && !manifestBaseDir) {
      console.error(`Error: Local file paths require a local manifest. Cannot resolve action: ${tool.action}`);
      process.exit(1);
    }
  }

  // Resolve local resource URIs to file:// for MCP SDK registration
  const localResourcePaths = new Map<string, string>();
  const resolvedManifest = { ...manifest };
  if (manifest.resources) {
    resolvedManifest.resources = manifest.resources.map(r => {
      if (isHttpUrl(r.uri)) return r;
      if (!manifestBaseDir) {
        throw new Error(`Local file paths require a local manifest. Cannot resolve: ${r.uri}`);
      }
      const absPath = resolveLocalPath(r.uri, manifestBaseDir);
      const fileUri = url.pathToFileURL(absPath).href;
      localResourcePaths.set(fileUri, absPath);
      return { ...r, uri: fileUri };
    });
  }

  // Create MCP server
  const server = createMcpServer({
    manifest: resolvedManifest,
    onToolCall: async (name, input) => {
      // Rate limit check
      if (rateLimiter && !rateLimiter.tryAcquire()) {
        auditLogger.logError('Rate limit exceeded', { toolName: name, limit: rateLimitValue }, manifest.name);
        return {
          content: [{
            type: 'text',
            text: `Rate limit exceeded: ${rateLimitValue} calls per minute. Retry after a brief pause or increase with --rate-limit <n>.`,
          }],
          isError: true,
        };
      }

      const tool = manifest.tools?.find((t) => t.name === name);
      if (!tool) {
        auditLogger.logError('Tool not found', { toolName: name }, manifest.name);
        return {
          content: [{ type: 'text', text: `Tool not found: ${name}` }],
          isError: true,
        };
      }

      try {
        // Log action start
        auditLogger.logActionStart(name, manifest.name);
        const startTime = Date.now();

        // Get or fetch action code
        let actionCode: string;
        if (isHttpUrl(tool.action)) {
          // Remote action — cache and verify hash (existing behavior)
          const cached = actionCache.get(tool.action);
          if (cached) {
            actionCode = cached;
          } else {
            console.error(`Fetching action: ${tool.action}`);
            const result = await fetchContent(tool.action, {
              headers: actionHeaders,
              auditLogger,
              allowHttp,
            });
            verifyHash(result.content, tool.actionHash);
            actionCode = result.content;
            actionCache.set(tool.action, actionCode);
          }
        } else {
          // Local action — read from disk each time (no cache, so edits are picked up)
          if (!manifestBaseDir) {
            throw new Error(`Local file paths require a local manifest. Cannot resolve: ${tool.action}`);
          }
          const filePath = resolveLocalPath(tool.action, manifestBaseDir);
          console.error(`Loading local action: ${filePath}`);
          const result = await loadLocalContent(filePath, { auditLogger });
          verifyHash(result.content, tool.actionHash);
          actionCode = result.content;
        }

        // Execute in worker
        const response = await workerManager.executeAction({
          id: crypto.randomUUID(),
          type: 'execute',
          payload: {
            actionUrl: tool.action,
            actionCode,
            input,
            secrets: secretsManager.getAllSecrets(),
            timeout: parseInt(timeout, 10),
            manifest: {
              name: manifest.name,
              version: manifest.version,
            },
            secretScopes: getSecretScopes(manifest),
            memoryLimit: memoryLimitBytes,
          },
        });

        if (response.type === 'error') {
          auditLogger.logActionEnd(name, 'error', Date.now() - startTime, manifest.name);
          auditLogger.logError('Worker execution failed', { toolName: name, error: response.error?.message }, manifest.name);
          return {
            content: [{ type: 'text', text: response.error?.message ?? 'Unknown error' }],
            isError: true,
          };
        }

        auditLogger.logActionEnd(name, 'success', Date.now() - startTime, manifest.name);
        return response.result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        auditLogger.logError('Action execution failed', { toolName: name, error: message }, manifest.name);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
    onResourceRead: resolvedManifest.resources ? async (uri) => {
      const resource = resolvedManifest.resources?.find((r) => r.uri === uri);
      if (!resource) {
        throw new Error(`Resource not found: ${uri}`);
      }

      try {
        const localPath = localResourcePaths.get(uri);
        if (localPath) {
          const result = await loadLocalContent(localPath, { auditLogger });
          return result.content;
        }
        // HTTP(S) resource — existing behavior
        const resourceSchemes = allowHttp ? ['https', 'http'] : ['https'];
        await validateUrl(resource.uri, { allowedSchemes: resourceSchemes });
        const response = await fetchContent(resource.uri, {
          headers: resourceHeaders,
          auditLogger,
          allowHttp,
        });
        return response.content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read resource: ${message}`, { cause: error });
      }
    } : undefined,
    // eslint-disable-next-line @typescript-eslint/require-await
    onPromptGet: manifest.prompts ? async (name, args) => {
      const prompt = manifest.prompts?.find((p) => p.name === name);
      if (!prompt) {
        throw new Error(`Prompt not found: ${name}`);
      }

      // Structured messages: substitute {{arg}} placeholders and return
      if (prompt.messages) {
        return {
          description: prompt.description,
          messages: prompt.messages.map((msg) => ({
            role: msg.role,
            content: substituteContent(msg.content, args ?? {}),
          })),
        };
      }

      // Simple fallback: build single user message from description + args
      let text = prompt.description;
      if (prompt.args && args) {
        text += '\n\nArguments:\n';
        for (const arg of prompt.args) {
          const value = args[arg.name];
          if (value !== undefined) {
            text += `- ${arg.name}: ${value}\n`;
          }
        }
      }

      return {
        description: prompt.description,
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
      };
    } : undefined,
  });

  // Cleanup on exit
  const cleanup = async () => {
    await auditLogger.close();
  };
  process.on('beforeExit', () => void cleanup());

  // Start server
  console.error(`Starting MCP server: ${manifest.name} v${manifest.version}`);
  await startMcpServer(server);
}

/**
 * Parse header strings into object.
 * Format: "Header-Name: Header-Value"
 */
export function parseHeaders(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    const colonIndex = header.indexOf(':');
    if (colonIndex > 0) {
      const name = header.slice(0, colonIndex).trim();
      const value = header.slice(colonIndex + 1).trim();
      result[name] = value;
    }
  }
  return result;
}

/**
 * Parse secret strings into object.
 * Format: "NAME=value"
 */
export function parseSecrets(secrets: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const secret of secrets) {
    const equalIndex = secret.indexOf('=');
    if (equalIndex > 0) {
      const name = secret.slice(0, equalIndex).trim();
      const value = secret.slice(equalIndex + 1);
      result[name] = value;
    }
  }
  return result;
}

/**
 * Get secret scopes from manifest.
 */
export function getSecretScopes(manifest: Manifest): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const secret of manifest.secrets ?? []) {
    const scopes = Array.isArray(secret.scope) ? secret.scope : [secret.scope];
    result[secret.name] = scopes;
  }
  return result;
}

/**
 * Substitute {{argName}} placeholders in a template string.
 */
function substituteTemplate(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => args[name] ?? `{{${name}}}`);
}

/**
 * Substitute {{argName}} placeholders in prompt content.
 * Ensures resource.text is always present (required by MCP TextResourceContents).
 */
function substituteContent(
  content: { type: 'text'; text: string } | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } },
  args: Record<string, string>,
): { type: 'text'; text: string } | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string } } {
  if (content.type === 'text') {
    return { type: 'text', text: substituteTemplate(content.text, args) };
  }
  const resource: { uri: string; text: string; mimeType?: string } = {
    uri: substituteTemplate(content.resource.uri, args),
    text: substituteTemplate(content.resource.text ?? '', args),
  };
  if (content.resource.mimeType) {
    resource.mimeType = content.resource.mimeType;
  }
  return { type: 'resource', resource };
}

/**
 * Check TOFU (Trust-on-First-Use) for manifest hash.
 */
async function checkTofu(manifestPath: string, currentHash: string, trustChanged = false): Promise<void> {
  const trustDir = path.join(os.homedir(), '.git-doc-mcp', 'trust');
  const trustFile = path.join(trustDir, hashPath(manifestPath), 'manifest.trust');

  try {
    const storedHash = await fs.readFile(trustFile, 'utf-8');

    if (storedHash !== currentHash) {
      console.error(``);
      console.error(`Warning: Manifest content has changed since last use!`);
      console.error(`  Previous: ${storedHash}`);
      console.error(`  Current:  ${currentHash}`);
      console.error(``);
      console.error(`This could indicate:`);
      console.error(`  - Legitimate update from the manifest author`);
      console.error(`  - Manifest compromise`);
      console.error(``);

      if (trustChanged) {
        await fs.writeFile(trustFile, currentHash, 'utf-8');
        console.error(`Manifest change accepted. Updated stored hash.`);
      } else {
        console.error(`Current hash: ${currentHash}`);
        console.error(`To accept this change, re-run with: --trust-changed`);
        console.error(`For CI pinning, use: --manifest-hash ${currentHash}`);
        process.exit(1);
      }
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // First use - trust file doesn't exist yet
      await fs.mkdir(path.dirname(trustFile), { recursive: true });
      await fs.writeFile(trustFile, currentHash, 'utf-8');
      console.error(`First use of manifest. Stored hash: ${currentHash}`);
      console.error(`For CI pinning, use: --manifest-hash ${currentHash}`);
    } else {
      // Unexpected error reading trust file - fail closed
      console.error(`Error reading trust file: ${(error as Error).message}`);
      process.exit(1);
    }
  }
}

/**
 * Create a safe path component from a string.
 */
export function hashPath(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
