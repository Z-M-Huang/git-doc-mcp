/**
 * Unit tests for HTTP client (fetchContent, verifyHash).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS for SSRF validation
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { fetchContent, loadLocalContent, verifyHash } from '../../http/client.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

function createMockResponse(body: string, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  const headers = new Headers(init.headers);
  return new Response(body, { status: 200, statusText: 'OK', ...init, headers });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('fetchContent', () => {
  it('should fetch content and return hash', async () => {
    mockFetch.mockResolvedValue(createMockResponse('console.log("hello");'));
    const result = await fetchContent('https://example.com/action.js');
    expect(result.content).toBe('console.log("hello");');
    expect(result.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('should include etag and lastModified when present', async () => {
    mockFetch.mockResolvedValue(createMockResponse('code', {
      headers: { 'etag': '"abc123"', 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT' },
    }));
    const result = await fetchContent('https://example.com/action.js');
    expect(result.etag).toBe('"abc123"');
    expect(result.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });

  it('should reject when Content-Length exceeds maxSize', async () => {
    mockFetch.mockResolvedValue(createMockResponse('x', {
      headers: { 'content-length': '999999999' },
    }));
    await expect(fetchContent('https://example.com/action.js', { maxSize: 1024 }))
      .rejects.toThrow(/too large/i);
  });

  it('should reject oversized actual content', async () => {
    const largeContent = 'x'.repeat(1024 * 1024); // 1MB
    mockFetch.mockResolvedValue(createMockResponse(largeContent));
    await expect(fetchContent('https://example.com/action.js', { maxSize: 1024 }))
      .rejects.toThrow(/too large/i);
  });

  it('should reject HTTP errors', async () => {
    mockFetch.mockResolvedValue(createMockResponse('Not Found', { status: 404, statusText: 'Not Found' }));
    await expect(fetchContent('https://example.com/action.js'))
      .rejects.toThrow(/404/);
  });

  it('should block SSRF to private IPs (AC8)', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(fetchContent('https://internal.example.com/action.js'))
      .rejects.toThrow(/Blocked IP/);
    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should handle redirects with SSRF validation (AC10)', async () => {
    // First response is a redirect
    const redirectResponse = new Response(null, {
      status: 301,
      headers: { location: 'https://cdn.example.com/action.js' },
    });
    // Second response is actual content
    const finalResponse = createMockResponse('actual code');

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);

    const result = await fetchContent('https://example.com/action.js');
    expect(result.content).toBe('actual code');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should block redirect to private IP (AC10)', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'https://internal.example.com/action.js' },
    });
    mockFetch.mockResolvedValueOnce(redirectResponse);
    // Second DNS lookup returns private IP
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // initial URL OK
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]); // redirect target blocked

    await expect(fetchContent('https://example.com/action.js'))
      .rejects.toThrow(/Blocked IP/);
  });

  it('should reject redirect without Location header', async () => {
    const redirectResponse = new Response(null, { status: 302 });
    mockFetch.mockResolvedValueOnce(redirectResponse);
    await expect(fetchContent('https://example.com/action.js'))
      .rejects.toThrow(/Location header/);
  });

  it('should reject too many redirects', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/next' },
      }))
    );
    await expect(fetchContent('https://example.com/action.js'))
      .rejects.toThrow(/Too many redirects/);
  });

  it('should log audit events for redirect without Location', async () => {
    const auditLogger = { logError: vi.fn() };
    const redirectResponse = new Response(null, { status: 302 });
    mockFetch.mockResolvedValueOnce(redirectResponse);
    await expect(fetchContent('https://example.com/action.js', { auditLogger } as any))
      .rejects.toThrow(/Location header/);
    expect(auditLogger.logError).toHaveBeenCalledWith(
      'Redirect without location header',
      expect.objectContaining({ url: 'https://example.com/action.js' })
    );
  });

  it('should log audit events for failed fetch', async () => {
    const auditLogger = { logError: vi.fn() };
    mockFetch.mockResolvedValue(createMockResponse('Not Found', { status: 404, statusText: 'Not Found' }));
    await expect(fetchContent('https://example.com/action.js', { auditLogger } as any))
      .rejects.toThrow(/404/);
    expect(auditLogger.logError).toHaveBeenCalledWith(
      'Action fetch failed',
      expect.objectContaining({ status: 404 })
    );
  });

  it('should log audit events for oversized content-length', async () => {
    const auditLogger = { logError: vi.fn() };
    mockFetch.mockResolvedValue(createMockResponse('x', {
      headers: { 'content-length': '999999999' },
    }));
    await expect(fetchContent('https://example.com/action.js', { maxSize: 1024, auditLogger } as any))
      .rejects.toThrow(/too large/i);
    expect(auditLogger.logError).toHaveBeenCalledWith(
      'Action content too large',
      expect.objectContaining({ maxSize: 1024 })
    );
  });

  it('should log audit events for oversized body', async () => {
    const auditLogger = { logError: vi.fn() };
    const largeContent = 'x'.repeat(2048);
    mockFetch.mockResolvedValue(createMockResponse(largeContent));
    await expect(fetchContent('https://example.com/action.js', { maxSize: 1024, auditLogger } as any))
      .rejects.toThrow(/too large/i);
    expect(auditLogger.logError).toHaveBeenCalledWith(
      'Action body too large',
      expect.objectContaining({ maxSize: 1024 })
    );
  });

  it('should resolve relative redirect URLs', async () => {
    const redirectResponse = new Response(null, {
      status: 301,
      headers: { location: '/v2/action.js' },
    });
    mockFetch
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(createMockResponse('v2 code'));

    const result = await fetchContent('https://example.com/v1/action.js');
    expect(result.content).toBe('v2 code');
    expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/v2/action.js');
  });

  it('should pass custom headers to fetch', async () => {
    mockFetch.mockResolvedValue(createMockResponse('code'));
    await fetchContent('https://example.com/action.js', {
      headers: { 'Authorization': 'Bearer test123' },
    });
    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['Authorization']).toBe('Bearer test123');
  });

  it('should reject HTTP URL by default (allowHttp not set)', async () => {
    await expect(fetchContent('http://example.com/action.js'))
      .rejects.toThrow(/https/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should accept HTTP URL when allowHttp is true', async () => {
    mockFetch.mockResolvedValue(createMockResponse('console.log("hello");'));
    const result = await fetchContent('http://example.com/action.js', { allowHttp: true });
    expect(result.content).toBe('console.log("hello");');
  });
});

describe('loadLocalContent', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-doc-mcp-test-'));
  });

  it('should read file and return content with hash', async () => {
    const filePath = path.join(tmpDir, 'action.js');
    await fs.writeFile(filePath, 'console.log("hello");');

    const result = await loadLocalContent(filePath);
    expect(result.content).toBe('console.log("hello");');
    expect(result.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('should reject file exceeding maxSize', async () => {
    const filePath = path.join(tmpDir, 'large.js');
    await fs.writeFile(filePath, 'x'.repeat(2048));

    await expect(loadLocalContent(filePath, { maxSize: 1024 }))
      .rejects.toThrow(/too large/i);
  });

  it('should throw on missing file', async () => {
    await expect(loadLocalContent(path.join(tmpDir, 'nonexistent.js')))
      .rejects.toThrow();
  });
});

describe('verifyHash', () => {
  it('should not throw for matching hash', () => {
    const content = 'hello world';
    const hash = 'sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    expect(() => verifyHash(content, hash)).not.toThrow();
  });

  it('should throw for mismatching hash', () => {
    expect(() => verifyHash('hello', 'sha256:0000000000000000000000000000000000000000000000000000000000000000'))
      .toThrow(/Hash mismatch/);
  });
});
