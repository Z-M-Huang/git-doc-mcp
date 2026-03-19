/**
 * Security regression tests proving vulnerabilities are fixed (NFR1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS and fs (hoisted for vi.mock factory)
const { mockLookup, mockReadFile } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockReadFile: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock fs for loader tests
vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import { createActionContext } from '../../sandbox/context.js';
import { loadManifest } from '../../manifest/loader.js';
import { fetchContent } from '../../http/client.js';

const _VALID_MANIFEST_YAML = `
schemaVersion: "1.0"
name: test
version: "1.0.0"
description: Test
tools:
  - name: echo
    description: Echo
    action: https://example.com/echo.js
    actionHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    inputSchema:
      type: object
`;

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  mockReadFile.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('Secret scoping bypass regression (AC23)', () => {
  it('ctx.getSecret returns undefined for out-of-scope URL', () => {
    // Previously, action code could read ctx.secrets.GITHUB_TOKEN directly
    const ctx = createActionContext({
      manifest: { name: 'test', version: '1.0.0' },
      secrets: { GITHUB_TOKEN: 'ghp_secret_value' },
      secretScopes: { GITHUB_TOKEN: ['https://api.github.com/*'] },
    });

    // Out-of-scope: should NOT leak the secret
    expect(ctx.getSecret('GITHUB_TOKEN', 'https://evil.com/steal')).toBeUndefined();
  });

  it('ctx.getSecret returns value for in-scope URL', () => {
    const ctx = createActionContext({
      manifest: { name: 'test', version: '1.0.0' },
      secrets: { GITHUB_TOKEN: 'ghp_secret_value' },
      secretScopes: { GITHUB_TOKEN: ['https://api.github.com/*'] },
    });

    // In-scope: should return the secret
    expect(ctx.getSecret('GITHUB_TOKEN', 'https://api.github.com/repos')).toBe('ghp_secret_value');
  });
});

describe('ctx.secrets removal regression (AC1)', () => {
  it('ctx.secrets is undefined after security fix', () => {
    // Previously, ctx.secrets exposed all secrets as a plain object
    const ctx = createActionContext({
      manifest: { name: 'test', version: '1.0.0' },
      secrets: { TOKEN: 'value' },
      secretScopes: { TOKEN: ['https://api.com/*'] },
    });

    expect((ctx as Record<string, unknown>).secrets).toBeUndefined();
  });
});

describe('Inverted scope logic regression (AC5)', () => {
  it('fetching unrelated URL is no longer blocked', async () => {
    // Previously, scopedFetch blocked ALL fetches to URLs not in EVERY secret's scope
    mockFetch.mockResolvedValue(new Response('OK'));

    const ctx = createActionContext({
      manifest: { name: 'test', version: '1.0.0' },
      secrets: { A_TOKEN: 'aaa', B_TOKEN: 'bbb' },
      secretScopes: {
        A_TOKEN: ['https://api.github.com/*'],
        B_TOKEN: ['https://api.gitlab.com/*'],
      },
    });

    // This URL doesn't match either secret's scope, but should still succeed
    const response = await ctx.fetch('https://httpbin.org/get');
    expect(response.status).toBe(200);
  });
});

describe('SSRF in loader regression (AC24)', () => {
  it('loadManifest blocks private IP URLs', async () => {
    // Previously, loadFromUrl used raw fetch() without SSRF validation
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(loadManifest({
      manifestPath: 'https://metadata.internal/manifest.yml',
    })).rejects.toThrow(/Blocked IP/);

    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('SSRF in client regression (AC24)', () => {
  it('fetchContent blocks private IP URLs', async () => {
    // Previously, fetchContent used raw fetch() without SSRF validation
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);

    await expect(fetchContent('https://internal.corp/action.js'))
      .rejects.toThrow(/Blocked IP/);

    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
