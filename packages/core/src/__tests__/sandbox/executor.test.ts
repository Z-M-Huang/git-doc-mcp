/**
 * Unit tests for sandbox/executor.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS (needed for fetchCallback tests that invoke scopedFetch)
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

// Mock global fetch (needed for fetchCallback tests)
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Capture callbacks set on the isolate global
let capturedGlobals: Record<string, unknown> = {};

const mockGlobal = {
  set: vi.fn(async (name: string, value: unknown) => {
    capturedGlobals[name] = value;
  }),
};

const mockContext = { global: mockGlobal };

const mockScript = {
  run: vi.fn(),
};

const mockIsolate = {
  createContext: vi.fn(async () => mockContext),
  compileScript: vi.fn(async () => mockScript),
  dispose: vi.fn(),
};

vi.mock('isolated-vm', () => ({
  default: {
    Isolate: vi.fn(() => mockIsolate),
    Callback: vi.fn((fn: Function) => fn),
    ExternalCopy: vi.fn((val: unknown) => ({
      copyInto: () => val,
    })),
  },
}));

import { transformActionCode, validateResultSize, executeAction } from '../../sandbox/executor.js';

beforeEach(() => {
  capturedGlobals = {};
  mockGlobal.set.mockClear();
  mockScript.run.mockClear();
  mockIsolate.createContext.mockClear();
  mockIsolate.compileScript.mockClear();
  mockIsolate.dispose.mockClear();
  mockFetch.mockReset();
  mockLookup.mockReset();
  // Default: resolve to a public IP so SSRF validation passes
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('transformActionCode', () => {
  it('should transform named default export function', () => {
    const code = 'export default async function echo(input, ctx) { return { content: [] }; }';
    const result = transformActionCode(code);
    expect(result).toContain('async function __default__(input, ctx)');
    expect(result).not.toContain('export default');
  });

  it('should transform anonymous default export function', () => {
    const code = 'export default function(input) { return input; }';
    const result = transformActionCode(code);
    expect(result).toContain('function __default__(input)');
  });

  it('should transform block-bodied arrow function default export', () => {
    const code = 'export default async (input, ctx) => { return { content: [] }; }';
    const result = transformActionCode(code);
    expect(result).not.toContain('export default');
    // Must not double-wrap with return (old bug produced "{ return { return ...")
    expect(result).not.toContain('return { return');
    // Should produce valid JS: function declaration followed by the original block body
    expect(result).toBe('async function __default__(input, ctx) { return { content: [] }; }');
  });

  it('should transform expression-bodied arrow function default export', () => {
    const code = 'export default (input) => input;';
    const result = transformActionCode(code);
    expect(result).toContain('function __default__(input)');
    // Must wrap expression in { return ...; }
    expect(result).toBe('function __default__(input) { return input; }');
  });

  it('should transform expression-bodied arrow returning object literal', () => {
    const code = 'export default async (input) => ({ content: [{ type: "text", text: "hi" }] })';
    const result = transformActionCode(code);
    expect(result).toBe('async function __default__(input) { return ({ content: [{ type: "text", text: "hi" }] }); }');
  });

  it('should transform generic export default', () => {
    const code = 'export default { key: "value" };';
    const result = transformActionCode(code);
    expect(result).toContain('const __default__ = { key: "value" };');
  });

  it('should remove named exports', () => {
    const code = 'export { foo, bar };\nconst foo = 1;\nconst bar = 2;';
    const result = transformActionCode(code);
    expect(result).not.toContain('export {');
    expect(result).toContain('const foo = 1;');
  });

  it('should transform export const/let/var', () => {
    const code = 'export const X = 1;\nexport let Y = 2;\nexport var Z = 3;';
    const result = transformActionCode(code);
    expect(result).toContain('const X = 1;');
    expect(result).toContain('let Y = 2;');
    expect(result).toContain('var Z = 3;');
    expect(result).not.toContain('export const');
  });

  it('should transform export function', () => {
    const code = 'export function helper() { return 1; }';
    const result = transformActionCode(code);
    expect(result).toContain('function helper()');
    expect(result).not.toContain('export function');
  });

  it('should transform export class', () => {
    const code = 'export class Foo {}';
    const result = transformActionCode(code);
    expect(result).toContain('class Foo {}');
    expect(result).not.toContain('export class');
  });

  it('should handle code with no exports', () => {
    const code = 'const x = 1;\nfunction foo() {}';
    const result = transformActionCode(code);
    expect(result).toBe(code);
  });

  it('should handle empty string', () => {
    const result = transformActionCode('');
    expect(result).toBe('');
  });
});

describe('executeAction', () => {
  const contextOptions = {
    manifest: { name: 'test', version: '1.0.0' },
    secrets: {},
    secretScopes: {},
    timeout: 5000,
  };

  it('should execute action and return result', async () => {
    const expectedResult = { content: [{ type: 'text' as const, text: 'hello' }] };

    mockScript.run.mockImplementation(async () => {
      // Simulate wrapper script calling _resolve
      const resolve = capturedGlobals['_resolve'] as Function;
      resolve(expectedResult);
    });

    const result = await executeAction(
      'export default async function echo(input) { return { content: [{ type: "text", text: "hello" }] }; }',
      { text: 'test' },
      contextOptions,
    );

    expect(result).toEqual(expectedResult);
    expect(mockIsolate.dispose).toHaveBeenCalled();
  });

  it('should set all 7 globals on isolate context', async () => {
    mockScript.run.mockImplementation(async () => {
      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction('export default async function f() {}', {}, contextOptions);

    const setNames = mockGlobal.set.mock.calls.map((c: unknown[]) => c[0]);
    expect(setNames).toContain('_log');
    expect(setNames).toContain('_fetch');
    expect(setNames).toContain('_resolve');
    expect(setNames).toContain('_reject');
    expect(setNames).toContain('_input');
    expect(setNames).toContain('_getSecret');
    expect(setNames).toContain('_manifest');
  });

  it('should return error result when action rejects', async () => {
    mockScript.run.mockImplementation(async () => {
      const reject = capturedGlobals['_reject'] as Function;
      reject('action error');
    });

    const result = await executeAction(
      'export default async function f() { throw new Error("boom"); }',
      {},
      contextOptions,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('action error') })
    );
  });

  it('should return error result when isolate setup fails', async () => {
    mockIsolate.createContext.mockRejectedValueOnce(new Error('isolate setup failed'));

    const result = await executeAction(
      'export default async function f() {}',
      {},
      contextOptions,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('isolate setup failed') })
    );
    expect(mockIsolate.dispose).toHaveBeenCalled();
  });

  it('should validate and truncate oversized result', async () => {
    const oversizedResult = {
      content: [{ type: 'text' as const, text: 'x'.repeat(1200000) }],
    };

    mockScript.run.mockImplementation(async () => {
      const resolve = capturedGlobals['_resolve'] as Function;
      resolve(oversizedResult);
    });

    const result = await executeAction('export default async function f() {}', {}, contextOptions);

    // Result should be truncated by validateResultSize
    const item = result.content[0];
    if (item.type === 'text') {
      expect(item.text.length).toBeLessThan(1200000);
      expect(item.text).toContain('[truncated]');
    }
  });

  it('should pass input and manifest to isolate', async () => {
    const input = { key: 'value' };

    mockScript.run.mockImplementation(async () => {
      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction('export default async function f() {}', input, contextOptions);

    expect(capturedGlobals['_input']).toEqual(input);
    expect(capturedGlobals['_manifest']).toEqual({ name: 'test', version: '1.0.0' });
  });

  it('should dispose isolate on success', async () => {
    mockScript.run.mockImplementation(async () => {
      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction('export default async function f() {}', {}, contextOptions);
    expect(mockIsolate.dispose).toHaveBeenCalledTimes(1);
  });

  it('should use custom sandbox options', async () => {
    const { Isolate } = (await import('isolated-vm')).default;

    mockScript.run.mockImplementation(async () => {
      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction('export default async function f() {}', {}, contextOptions, {
      memoryLimit: 64 * 1024 * 1024,
    });

    expect(Isolate).toHaveBeenCalledWith({ memoryLimit: 64 * 1024 * 1024 });
  });

  it('should provide working log callback', async () => {
    const logger = vi.fn();

    mockScript.run.mockImplementation(async () => {
      const log = capturedGlobals['_log'] as Function;
      log('info', 'test message');

      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction('export default async function f() {}', {}, {
      ...contextOptions,
      logger,
    });

    expect(logger).toHaveBeenCalledWith('info', '[test] test message');
  });

  it('should provide fetchCallback with json() method returning parsed JSON (AC3)', async () => {
    // Mock global fetch to return a JSON response
    mockFetch.mockResolvedValue(new Response('{"key":"value"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    let jsonResult: unknown;

    mockScript.run.mockImplementation(async () => {
      const fetchFn = capturedGlobals['_fetch'] as (url: string, opts: Record<string, unknown>) => Promise<{
        ok: boolean;
        status: number;
        text: string;
        json: () => unknown;
      }>;
      const result = await fetchFn('https://example.com/data', {});
      // json() should return parsed JSON
      jsonResult = result.json();

      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction(
      'export default async function f() {}',
      {},
      contextOptions,
    );

    expect(jsonResult).toEqual({ key: 'value' });
  });

  it('should throw SyntaxError when json() called on non-JSON response (AC4)', async () => {
    // Mock global fetch to return a non-JSON response
    mockFetch.mockResolvedValue(new Response('not valid json', {
      status: 200,
    }));

    let jsonError: unknown;

    mockScript.run.mockImplementation(async () => {
      const fetchFn = capturedGlobals['_fetch'] as (url: string, opts: Record<string, unknown>) => Promise<{
        ok: boolean;
        status: number;
        text: string;
        json: () => unknown;
      }>;
      const result = await fetchFn('https://example.com/data', {});
      try {
        result.json();
      } catch (err) {
        jsonError = err;
      }

      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction(
      'export default async function f() {}',
      {},
      contextOptions,
    );

    expect(jsonError).toBeInstanceOf(SyntaxError);
  });

  it('should handle getSecret callback returning null for undefined', async () => {
    const opts = {
      ...contextOptions,
      secrets: { TOKEN: 'abc' },
      secretScopes: { TOKEN: ['https://api.example.com/*'] },
    };

    mockScript.run.mockImplementation(async () => {
      // Simulate calling _getSecret for out-of-scope URL
      const getSecret = capturedGlobals['_getSecret'] as Function;
      const result = getSecret('TOKEN', 'https://other.com/data');
      // Should return null (undefined converted to null for ivm boundary)
      expect(result).toBeNull();

      const resolve = capturedGlobals['_resolve'] as Function;
      resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    await executeAction('export default async function f() {}', {}, opts);
  });
});

describe('validateResultSize', () => {
  it('should return small results as-is', () => {
    const result = { content: [{ type: 'text' as const, text: 'hello' }] };
    expect(validateResultSize(result)).toEqual(result);
  });

  it('should truncate when content items exceed MAX_CONTENT_ITEMS', () => {
    const items = Array.from({ length: 150 }, (_, i) => ({
      type: 'text' as const,
      text: `item ${i}`,
    }));
    const result = validateResultSize({ content: items });
    // 100 items + 1 truncation notice = 101
    expect(result.content.length).toBe(101);
    const lastItem = result.content[100];
    expect(lastItem.type).toBe('text');
    if (lastItem.type === 'text') {
      expect(lastItem.text).toContain('Truncated');
    }
  });

  it('should truncate oversized text content', () => {
    // Need >1MB total serialized size to trigger truncation
    const longText = 'x'.repeat(1200000);
    const result = validateResultSize({
      content: [{ type: 'text', text: longText }],
    });
    const item = result.content[0];
    if (item.type === 'text') {
      expect(item.text.length).toBeLessThan(longText.length);
      expect(item.text).toContain('[truncated]');
    }
  });

  it('should preserve isError flag', () => {
    const result = validateResultSize({
      content: [{ type: 'text', text: 'error' }],
      isError: true,
    });
    expect(result.isError).toBe(true);
  });

  it('should not truncate non-text (image) content by text logic', () => {
    const result = validateResultSize({
      content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
    });
    const item = result.content[0];
    if (item.type === 'image') {
      expect(item.data).toBe('base64data');
    }
  });
});
