/**
 * Unit tests for sandbox/context.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createActionContext } from '../../sandbox/context.js';

const testManifest = { name: 'test', version: '1.0.0' };

function createContext(overrides = {}) {
  return createActionContext({
    manifest: testManifest,
    secrets: { GITHUB_TOKEN: 'ghp_abc', GITLAB_TOKEN: 'glpat_def' },
    secretScopes: {
      GITHUB_TOKEN: ['https://api.github.com/*'],
      GITLAB_TOKEN: ['https://gitlab.com/api/*'],
    },
    ...overrides,
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('createActionContext', () => {
  it('should return object with manifest, fetch, getSecret, log', () => {
    const ctx = createContext();
    expect(ctx.manifest).toEqual({ name: 'test', version: '1.0.0' });
    expect(typeof ctx.fetch).toBe('function');
    expect(typeof ctx.getSecret).toBe('function');
    expect(typeof ctx.log).toBe('function');
  });

  it('should NOT have secrets property (AC1)', () => {
    const ctx = createContext();
    expect((ctx as Record<string, unknown>).secrets).toBeUndefined();
  });
});

describe('ctx.getSecret', () => {
  it('should return value for in-scope URL (AC2)', () => {
    const ctx = createContext();
    expect(ctx.getSecret('GITHUB_TOKEN', 'https://api.github.com/repos')).toBe('ghp_abc');
  });

  it('should return undefined for out-of-scope URL (AC3)', () => {
    const ctx = createContext();
    expect(ctx.getSecret('GITHUB_TOKEN', 'https://evil.com/steal')).toBeUndefined();
  });

  it('should return undefined for nonexistent secret (AC4)', () => {
    const ctx = createContext();
    expect(ctx.getSecret('NONEXISTENT', 'https://api.github.com/repos')).toBeUndefined();
  });

  it('should log secret access via audit logger', () => {
    const logSecretAccess = vi.fn();
    const ctx = createContext({ auditLogger: { logSecretAccess, logFetch: vi.fn(), logRedirect: vi.fn(), logError: vi.fn() } });
    ctx.getSecret('GITHUB_TOKEN', 'https://api.github.com/repos');
    expect(logSecretAccess).toHaveBeenCalledWith('GITHUB_TOKEN', 'https://api.github.com/repos', true, 'test');
  });
});

describe('scopedFetch', () => {
  it('should succeed fetching public URL with unrelated secrets (AC5)', async () => {
    // Previously this was blocked by inverted scope logic
    mockFetch.mockResolvedValue(new Response('OK'));
    const ctx = createContext();
    const response = await ctx.fetch('https://httpbin.org/get');
    expect(response.status).toBe(200);
  });

  it('should block SSRF to private IPs', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const ctx = createContext();
    await expect(ctx.fetch('https://internal.example.com/')).rejects.toThrow(/Blocked IP/);
  });

  it('should resolve relative redirect URLs (AC11)', async () => {
    // First fetch returns redirect with relative Location
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: '/v2/data' },
    });
    const finalResponse = new Response('data');

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);

    const ctx = createContext();
    const response = await ctx.fetch('https://api.example.com/v1/data');
    expect(response.status).toBe(200);

    // Verify the second fetch was called with the resolved absolute URL
    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[0]).toBe('https://api.example.com/v2/data');
  });

  it('should resolve protocol-relative redirects (AC12)', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: '//other.example.com/data' },
    });
    const finalResponse = new Response('data');

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);

    const ctx = createContext();
    const response = await ctx.fetch('https://api.example.com/data');
    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[1][0]).toBe('https://other.example.com/data');
  });

  it('should block redirect to private IP (AC13)', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'https://compromised.com/api' },
    });
    mockFetch.mockResolvedValueOnce(redirectResponse);
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);

    const ctx = createContext();
    await expect(ctx.fetch('https://api.example.com/data')).rejects.toThrow(/Blocked IP/);
  });

  it('should enforce Content-Length size limit', async () => {
    mockFetch.mockResolvedValue(new Response('x', {
      headers: { 'content-length': '99999999' },
    }));
    const ctx = createContext({ maxResponseSize: 1024 });
    await expect(ctx.fetch('https://example.com/data')).rejects.toThrow(/too large/i);
  });

  it('should throw on too many redirects', async () => {
    // Return redirect for every call
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/next' },
      }))
    );
    const ctx = createContext({ maxRedirects: 3 });
    await expect(ctx.fetch('https://example.com/start')).rejects.toThrow(/Too many redirects/);
  });

  it('should throw on redirect without Location header', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 302 }));
    const ctx = createContext();
    await expect(ctx.fetch('https://example.com/data')).rejects.toThrow(/location header/i);
  });

  it('should reject streaming body exceeding maxResponseSize', async () => {
    // Create a response with small Content-Length but large body
    const largeBody = 'x'.repeat(2000);
    mockFetch.mockResolvedValue(new Response(largeBody));
    const ctx = createContext({ maxResponseSize: 100 });
    await expect(ctx.fetch('https://example.com/data')).rejects.toThrow(/too large/i);
  });
});

describe('audit fetch logging', () => {
  it('should call logFetch with actual status and duration after successful fetch (AC24)', async () => {
    const logFetch = vi.fn();
    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));
    const ctx = createContext({
      auditLogger: {
        logFetch,
        logRedirect: vi.fn(),
        logSecretAccess: vi.fn(),
        logError: vi.fn(),
        logActionLog: vi.fn(),
        log: vi.fn(),
        logActionStart: vi.fn(),
        logActionEnd: vi.fn(),
        close: vi.fn(),
      },
    });

    await ctx.fetch('https://example.com/data');

    // logFetch should be called twice: pre-fetch (attempt) and post-fetch (result)
    expect(logFetch).toHaveBeenCalledTimes(2);
    // First call: pre-fetch with undefined status/duration
    expect(logFetch).toHaveBeenNthCalledWith(1, 'https://example.com/data', undefined, undefined, 'test');
    // Second call: post-fetch with actual status and non-negative duration
    const secondCall = logFetch.mock.calls[1];
    expect(secondCall[0]).toBe('https://example.com/data');
    expect(secondCall[1]).toBe(200);
    expect(typeof secondCall[2]).toBe('number');
    expect(secondCall[2]).toBeGreaterThanOrEqual(0);
  });

  it('should call logFetch via finally even when fetch throws due to SSRF block (AC25)', async () => {
    const logFetch = vi.fn();
    // Mock DNS to resolve to a private IP (triggers SSRF block inside try/finally)
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const ctx = createContext({
      auditLogger: {
        logFetch,
        logRedirect: vi.fn(),
        logSecretAccess: vi.fn(),
        logError: vi.fn(),
        logActionLog: vi.fn(),
        log: vi.fn(),
        logActionStart: vi.fn(),
        logActionEnd: vi.fn(),
        close: vi.fn(),
      },
    });

    await expect(ctx.fetch('https://blocked.example.com/data')).rejects.toThrow(/Blocked IP/);

    // validateUrl() is inside try/finally (step 8), so SSRF failures trigger the finally logFetch.
    // Pre-fetch logFetch (attempt signal) fires before try/finally.
    // Post-fetch logFetch in finally fires with undefined status (no response received).
    expect(logFetch).toHaveBeenCalledTimes(2);
    // First call: pre-fetch attempt signal
    expect(logFetch).toHaveBeenNthCalledWith(1, 'https://blocked.example.com/data', undefined, undefined, 'test');
    // Second call: finally block with undefined status and non-negative duration
    const secondCall = logFetch.mock.calls[1];
    expect(secondCall[0]).toBe('https://blocked.example.com/data');
    expect(secondCall[1]).toBeUndefined(); // no response status on failure
    expect(typeof secondCall[2]).toBe('number');
    expect(secondCall[2]).toBeGreaterThanOrEqual(0);
  });
});

describe('ctx.log', () => {
  it('should call logger with formatted message', () => {
    const logger = vi.fn();
    const ctx = createContext({ logger });
    ctx.log('info', 'test message');
    expect(logger).toHaveBeenCalledWith('info', '[test] test message');
  });

  it('should route through structured audit logger (AC18)', () => {
    const logActionLog = vi.fn();
    const ctx = createContext({
      auditLogger: {
        logActionLog,
        logSecretAccess: vi.fn(),
        logFetch: vi.fn(),
        logRedirect: vi.fn(),
        logError: vi.fn(),
      },
    });
    ctx.log('warn', 'something happened');
    expect(logActionLog).toHaveBeenCalledWith('warn', 'something happened', 'test');
  });

  it('should log denied secret access via auditLogger', () => {
    const logSecretAccess = vi.fn();
    const ctx = createContext({ auditLogger: { logSecretAccess, logFetch: vi.fn(), logRedirect: vi.fn(), logError: vi.fn(), logActionLog: vi.fn() } });
    ctx.getSecret('GITHUB_TOKEN', 'https://evil.com/steal');
    expect(logSecretAccess).toHaveBeenCalledWith('GITHUB_TOKEN', 'https://evil.com/steal', false, 'test');
  });
});
