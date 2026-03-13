/**
 * Unit tests for manifest loader.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS and fetch
const { mockLookup, mockReadFile } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockReadFile: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock fs
vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import { isUrl, computeHash, loadManifest, checkManifestUpdate } from '../../manifest/loader.js';

const VALID_MANIFEST_YAML = `
schemaVersion: "1.0"
name: test-server
version: "1.0.0"
description: Test MCP server
tools:
  - name: echo
    description: Echo tool
    action: https://example.com/echo.js
    actionHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    inputSchema:
      type: object
      properties:
        text:
          type: string
`;

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  mockReadFile.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('isUrl', () => {
  it('should detect HTTP URLs', () => {
    expect(isUrl('http://example.com')).toBe(true);
  });

  it('should detect HTTPS URLs', () => {
    expect(isUrl('https://example.com')).toBe(true);
  });

  it('should detect file:// URLs', () => {
    expect(isUrl('file:///path/to/file')).toBe(true);
  });

  it('should reject local paths', () => {
    expect(isUrl('./local/path')).toBe(false);
    expect(isUrl('/absolute/path')).toBe(false);
    expect(isUrl('manifest.yml')).toBe(false);
  });
});

describe('computeHash', () => {
  it('should produce sha256: prefixed hash', () => {
    const hash = computeHash('hello');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('should be deterministic', () => {
    expect(computeHash('test')).toBe(computeHash('test'));
  });

  it('should differ for different inputs', () => {
    expect(computeHash('a')).not.toBe(computeHash('b'));
  });

  it('should handle empty string', () => {
    const hash = computeHash('');
    expect(hash).toMatch(/^sha256:/);
  });
});

describe('loadManifest', () => {
  describe('local file', () => {
    it('should load from local path', async () => {
      mockReadFile.mockResolvedValue(VALID_MANIFEST_YAML);
      const result = await loadManifest({ manifestPath: '/path/to/manifest.yml' });
      expect(result.manifest.name).toBe('test-server');
      expect(result.hash).toMatch(/^sha256:/);
      expect(result.source).toContain('manifest.yml');
    });

    it('should call auditLogger on file read failure', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const auditLogger = { logError: vi.fn() };
      await expect(loadManifest({ manifestPath: '/nonexistent.yml', auditLogger }))
        .rejects.toThrow('ENOENT');
      expect(auditLogger.logError).toHaveBeenCalledWith(
        'Manifest file read failed',
        expect.objectContaining({ error: 'ENOENT' })
      );
    });
  });

  describe('HTTP URL', () => {
    it('should load from HTTPS URL', async () => {
      mockFetch.mockResolvedValue(new Response(VALID_MANIFEST_YAML, { status: 200 }));
      const result = await loadManifest({ manifestPath: 'https://example.com/manifest.yml' });
      expect(result.manifest.name).toBe('test-server');
      expect(result.source).toBe('https://example.com/manifest.yml');
    });

    it('should block SSRF to private IP (AC7)', async () => {
      mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(loadManifest({ manifestPath: 'https://metadata.example.com/manifest.yml' }))
        .rejects.toThrow(/Blocked IP/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should block redirect to private IP (AC9)', async () => {
      const redirectResponse = new Response(null, {
        status: 302,
        headers: { location: 'https://internal.example.com/manifest.yml' },
      });
      mockFetch.mockResolvedValueOnce(redirectResponse);
      mockLookup
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);

      await expect(loadManifest({ manifestPath: 'https://example.com/manifest.yml' }))
        .rejects.toThrow(/Blocked IP/);
    });

    it('should reject non-OK responses', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
      await expect(loadManifest({ manifestPath: 'https://example.com/manifest.yml' }))
        .rejects.toThrow(/Failed to fetch/);
    });

    it('should include etag and lastModified', async () => {
      mockFetch.mockResolvedValue(new Response(VALID_MANIFEST_YAML, {
        status: 200,
        headers: { etag: '"v1"', 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT' },
      }));
      const result = await loadManifest({ manifestPath: 'https://example.com/manifest.yml' });
      expect(result.etag).toBe('"v1"');
      expect(result.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    });

    it('should reject redirect without Location header', async () => {
      const redirectResponse = new Response(null, { status: 302 });
      mockFetch.mockResolvedValueOnce(redirectResponse);
      await expect(loadManifest({ manifestPath: 'https://example.com/manifest.yml' }))
        .rejects.toThrow(/Location header/);
    });

    it('should reject too many redirects', async () => {
      // Return redirect for every call (more than MAX_REDIRECTS=5)
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/next' },
        }))
      );
      await expect(loadManifest({ manifestPath: 'https://example.com/manifest.yml' }))
        .rejects.toThrow(/Too many redirects/);
    });

    it('should follow redirect and resolve relative URLs', async () => {
      const redirectResponse = new Response(null, {
        status: 301,
        headers: { location: '/v2/manifest.yml' },
      });
      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(new Response(VALID_MANIFEST_YAML, { status: 200 }));

      const result = await loadManifest({ manifestPath: 'https://example.com/v1/manifest.yml' });
      expect(result.manifest.name).toBe('test-server');
      // Verify the redirect was resolved to absolute URL
      expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/v2/manifest.yml');
    });

    it('should log parse errors via auditLogger', async () => {
      mockFetch.mockResolvedValue(new Response('not: valid: yaml: [', { status: 200 }));
      const auditLogger = { logError: vi.fn() };
      await expect(loadManifest({
        manifestPath: 'https://example.com/manifest.yml',
        auditLogger,
      })).rejects.toThrow();
      expect(auditLogger.logError).toHaveBeenCalledWith(
        'Manifest parse failed',
        expect.objectContaining({ url: expect.any(String) })
      );
    });

    it('should reject HTTP URL by default (allowHttp not set)', async () => {
      await expect(loadManifest({ manifestPath: 'http://example.com/manifest.yml' }))
        .rejects.toThrow(/https/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should accept HTTP URL when allowHttp is true', async () => {
      mockFetch.mockResolvedValue(new Response(VALID_MANIFEST_YAML, { status: 200 }));
      const result = await loadManifest({ manifestPath: 'http://example.com/manifest.yml', allowHttp: true });
      expect(result.manifest.name).toBe('test-server');
    });
  });

  describe('file:// URL', () => {
    it('should load from file:// URL', async () => {
      mockReadFile.mockResolvedValue(VALID_MANIFEST_YAML);
      const result = await loadManifest({ manifestPath: 'file:///path/to/manifest.yml' });
      expect(result.manifest.name).toBe('test-server');
    });
  });
});

describe('checkManifestUpdate', () => {
  it('should return changed:false for 304 response', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 304 }));
    const result = await checkManifestUpdate('https://example.com/manifest.yml', '"v1"');
    expect(result.changed).toBe(false);
    expect(result.result).toBeUndefined();
  });

  it('should return changed:true with new manifest for 200 response', async () => {
    mockFetch.mockResolvedValue(new Response(VALID_MANIFEST_YAML, {
      status: 200,
      headers: { etag: '"v2"' },
    }));
    const result = await checkManifestUpdate('https://example.com/manifest.yml', '"v1"');
    expect(result.changed).toBe(true);
    expect(result.result?.manifest.name).toBe('test-server');
    expect(result.result?.etag).toBe('"v2"');
  });

  it('should throw on non-OK, non-304 response', async () => {
    mockFetch.mockResolvedValue(new Response('Server Error', { status: 500 }));
    await expect(checkManifestUpdate('https://example.com/manifest.yml', '"v1"'))
      .rejects.toThrow(/500/);
  });

  it('should send If-None-Match header with etag', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 304 }));
    await checkManifestUpdate('https://example.com/manifest.yml', '"v1"');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['If-None-Match']).toBe('"v1"');
  });

  it('should block SSRF to private IP in update check', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(checkManifestUpdate('https://internal.corp/manifest.yml', '"v1"'))
      .rejects.toThrow(/Blocked IP/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should block redirect to private IP in update check', async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'https://internal.example.com/manifest.yml' },
    });
    mockFetch.mockResolvedValueOnce(redirectResponse);
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);

    await expect(checkManifestUpdate('https://example.com/manifest.yml', '"v1"'))
      .rejects.toThrow(/Blocked IP/);
  });

  it('should follow redirect and resolve relative URLs in update check', async () => {
    const redirectResponse = new Response(null, {
      status: 301,
      headers: { location: '/v2/manifest.yml' },
    });
    mockFetch
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(new Response(VALID_MANIFEST_YAML, { status: 200 }));

    const result = await checkManifestUpdate('https://example.com/v1/manifest.yml', '"v1"');
    expect(result.changed).toBe(true);
    expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/v2/manifest.yml');
  });

  it('should reject too many redirects in update check', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/next' },
      }))
    );
    await expect(checkManifestUpdate('https://example.com/manifest.yml', '"v1"'))
      .rejects.toThrow(/Too many redirects/);
  });

  it('should include lastModified in update result', async () => {
    mockFetch.mockResolvedValue(new Response(VALID_MANIFEST_YAML, {
      status: 200,
      headers: { etag: '"v2"', 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT' },
    }));
    const result = await checkManifestUpdate('https://example.com/manifest.yml', '"v1"');
    expect(result.result?.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });
});
