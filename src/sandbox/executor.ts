/**
 * Sandbox executor using isolated-vm.
 * @module sandbox/executor
 */

import ivm from 'isolated-vm';
import { createActionContext, CreateContextOptions } from './context.js';

/**
 * Sandbox executor options.
 */
export interface SandboxOptions {
  /** Memory limit in bytes (default: 128MB) */
  memoryLimit?: number;
  /** CPU time limit in ms (default: 30000) */
  cpuTimeLimit?: number;
  /** Wall time limit in ms (default: 60000) */
  wallTimeLimit?: number;
}

/**
 * Default sandbox options.
 */
const DEFAULT_SANDBOX_OPTIONS: Required<SandboxOptions> = {
  memoryLimit: 128 * 1024 * 1024, // 128MB
  cpuTimeLimit: 30000, // 30 seconds
  wallTimeLimit: 60000, // 60 seconds
};

/**
 * Result size limits.
 */
const MAX_RESULT_SIZE = 1024 * 1024; // 1MB
const MAX_CONTENT_ITEMS = 100;

/**
 * Tool result from action execution.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/**
 * Validate and truncate result if too large.
 */
export function validateResultSize(result: ToolResult): ToolResult {
  // Check content item count
  if (result.content.length > MAX_CONTENT_ITEMS) {
    return {
      content: result.content.slice(0, MAX_CONTENT_ITEMS).concat([
        { type: 'text', text: `[Truncated: ${result.content.length - MAX_CONTENT_ITEMS} more items]` }
      ]),
      isError: result.isError,
    };
  }

  // Check total size
  const serializedSize = JSON.stringify(result).length;
  if (serializedSize > MAX_RESULT_SIZE) {
    // Truncate text content
    const truncatedContent = result.content.map(item => {
      if (item.type === 'text' && item.text.length > 10000) {
        return { type: 'text' as const, text: item.text.slice(0, 10000) + '\n...[truncated]' };
      }
      return item;
    });

    return {
      content: truncatedContent,
      isError: result.isError,
    };
  }

  return result;
}

/**
 * Transform ES module action code to CommonJS-style for isolated-vm.
 */
export function transformActionCode(code: string): string {
  // Handle `export default function name(...)` pattern
  // export default async function echo(input, ctx) -> async function __default__(input, ctx)
  let transformed = code.replace(
    /export\s+default\s+(async\s+)?function\s+\w+\s*\(/g,
    '$1function __default__('
  );

  // Handle `export default function(...)` (anonymous) - unlikely but handle it
  transformed = transformed.replace(
    /export\s+default\s+(async\s+)?function\s*\(/g,
    '$1function __default__('
  );

  // Handle `export default (async function...)` expressions
  transformed = transformed.replace(
    /export\s+default\s+\((async\s+)?function/g,
    '(__default__ = $1function'
  );

  // Handle `export default { ... }` objects or arrow functions
  // export default async (input, ctx) => { ... }
  if (!transformed.includes('function __default__')) {
    // Check for arrow function export
    const arrowMatch = code.match(/export\s+default\s+(async\s+)?\(([^)]*)\)\s*=>\s*/);
    if (arrowMatch) {
      const isAsync = arrowMatch[1] ? 'async ' : '';
      const params = arrowMatch[2];
      const matchEnd = arrowMatch.index! + arrowMatch[0].length;
      const afterArrow = code.slice(matchEnd);

      if (afterArrow.trimStart().startsWith('{')) {
        // Block body: export default async (input) => { ... } → async function __default__(input) { ... }
        transformed = code.replace(
          /export\s+default\s+(async\s+)?\([^)]*\)\s*=>\s*/,
          `${isAsync}function __default__(${params}) `
        );
      } else {
        // Expression body: export default (input) => expr; → function __default__(input) { return expr; }
        const beforeExport = code.slice(0, arrowMatch.index!);
        const expr = afterArrow.replace(/;\s*$/, '');
        transformed = beforeExport + `${isAsync}function __default__(${params}) { return ${expr}; }`;
      }
    } else {
      // Generic export default replacement
      transformed = code.replace(/export\s+default\s+/g, 'const __default__ = ');
    }
  }

  // Remove other exports (they're not needed for action execution)
  transformed = transformed.replace(/export\s+\{[^}]*\}/g, '');
  transformed = transformed.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');

  return transformed;
}

/**
 * Execute an action script in an isolated sandbox.
 *
 * The action code should export a default async function:
 * ```javascript
 * export default async function myAction(input, ctx) {
 *   return { content: [{ type: 'text', text: 'Result' }] };
 * }
 * ```
 */
export async function executeAction(
  actionCode: string,
  input: unknown,
  contextOptions: CreateContextOptions,
  sandboxOptions: SandboxOptions = {}
): Promise<ToolResult> {
  const opts = { ...DEFAULT_SANDBOX_OPTIONS, ...sandboxOptions };

  // Create action context
  const actionContext = createActionContext(contextOptions);

  // Create isolated-vm isolate
  const isolate = new ivm.Isolate({
    memoryLimit: opts.memoryLimit,
  });

  try {
    // Transform ES module syntax to CommonJS-style
    const transformedCode = transformActionCode(actionCode);

    // Create context
    const context = await isolate.createContext();
    const global = context.global;

    // Create a deferred result holder
    let resolveResult: (value: ToolResult) => void;
    let rejectResult: (error: Error) => void;
    const resultPromise = new Promise<ToolResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    // Create log callback
    const logCallback = (level: string, message: string) => {
      actionContext.log(level as 'debug' | 'info' | 'warn' | 'error', message);
    };

    // Create fetch wrapper that returns a JSON string (not an object).
    // isolated-vm cannot transfer objects or Promises across the boundary
    // via Reference.apply(), but strings transfer cleanly.
    const fetchCallback = async (url: string, optionsJson?: string) => {
      try {
        const options = optionsJson ? JSON.parse(optionsJson) : {};
        const response = await actionContext.fetch(url, options as RequestInit);
        const text = await response.text();
        return JSON.stringify({
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          text: text,
          headers: Object.fromEntries(response.headers.entries()),
        });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          status: 0,
          statusText: 'Error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Create getSecret wrapper (returns null instead of undefined for isolated-vm boundary)
    const getSecretCallback = (name: string, url: string) => {
      return actionContext.getSecret(name, url) ?? null;
    };

    // Set up callbacks in the isolate
    // _fetch uses ivm.Reference (not Callback) because it is async.
    // ivm.Callback cannot return Promises across the isolate boundary.
    await global.set('_log', new ivm.Callback(logCallback));
    await global.set('_fetch', new ivm.Reference(fetchCallback));
    await global.set('_resolve', new ivm.Callback((result: ToolResult) => resolveResult(result)));
    await global.set('_reject', new ivm.Callback((error: string) => rejectResult(new Error(error))));
    await global.set('_input', new ivm.ExternalCopy(input).copyInto());
    await global.set('_getSecret', new ivm.Callback(getSecretCallback));
    await global.set('_manifest', new ivm.ExternalCopy(actionContext.manifest).copyInto());

    // Create the wrapper script with full capture-then-delete pattern (AC17, AC18)
    const wrapperScript = `
      // Capture ALL globals into local const variables BEFORE anything else
      const __fetch__ = _fetch;
      const __log__ = _log;
      const __manifest__ = _manifest;
      const __getSecret__ = _getSecret;
      const __input__ = _input;
      const __resolve__ = _resolve;
      const __reject__ = _reject;

      // Delete all raw globals immediately
      delete globalThis._fetch;
      delete globalThis._log;
      delete globalThis._resolve;
      delete globalThis._reject;
      delete globalThis._input;
      delete globalThis._manifest;
      delete globalThis._getSecret;

      // Build ctx from captured locals only
      const ctx = {
        manifest: __manifest__,
        fetch: async (url, options) => {
          // __fetch__ is an ivm.Reference to an async host function.
          // It returns a JSON string; we parse it and add the json() helper.
          const optionsJson = options ? JSON.stringify(options) : undefined;
          const raw = await __fetch__.apply(undefined, [url, optionsJson], { result: { promise: true, copy: true } });
          const res = JSON.parse(raw);
          res.json = function() { return JSON.parse(res.text); };
          return res;
        },
        log: (level, message) => {
          __log__(level, message);
        },
        getSecret: (name, url) => {
          const result = __getSecret__(name, url);
          return result === null ? undefined : result;
        },
      };

      // Transformed action code
      ${transformedCode}

      // Find the action function
      const actionFn = typeof __default__ !== 'undefined' ? __default__ : null;

      if (typeof actionFn !== 'function') {
        __reject__('Action must export a default async function');
      } else {
        // Execute the action using captured locals
        Promise.resolve()
          .then(() => actionFn(__input__, ctx))
          .then(result => {
            if (!result || !Array.isArray(result.content)) {
              __reject__('Action must return { content: [...] }');
            } else {
              __resolve__(result);
            }
          })
          .catch(err => {
            __reject__(err.message || String(err));
          });
      }
    `;

    // Compile and run the script
    const script = await isolate.compileScript(wrapperScript);

    // Run with timeout
    await script.run(context, {
      timeout: opts.cpuTimeLimit,
    });

    // Wait for the result with wall timeout
    const rawResult = await Promise.race([
      resultPromise,
      new Promise<ToolResult>((_, reject) => {
        setTimeout(() => reject(new Error('Action timeout')), opts.wallTimeLimit);
      }),
    ]);

    // Validate and truncate result if too large
    return validateResultSize(rawResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Execution error: ${message}` }],
      isError: true,
    };
  } finally {
    // Clean up
    isolate.dispose();
  }
}
