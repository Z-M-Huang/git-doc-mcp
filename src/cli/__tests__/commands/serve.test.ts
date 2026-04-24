/**
 * Unit tests for CLI serve command pure functions.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseHeaders, parseSecrets, getSecretScopes, hashPath, resolvePromptContent } from '../../commands/serve.js';

describe('parseHeaders', () => {
  it('should parse header strings', () => {
    const result = parseHeaders(['Authorization: Bearer xxxxx', 'Accept: application/json']);
    expect(result).toEqual({
      Authorization: 'Bearer xxxxx',
      Accept: 'application/json',
    });
  });

  it('should handle header with multiple colons', () => {
    const result = parseHeaders(['X-Custom: value:with:colons']);
    expect(result).toEqual({ 'X-Custom': 'value:with:colons' });
  });

  it('should trim whitespace', () => {
    const result = parseHeaders(['  Content-Type : text/plain  ']);
    expect(result).toEqual({ 'Content-Type': 'text/plain' });
  });

  it('should skip malformed headers (no colon)', () => {
    const result = parseHeaders(['malformed-no-colon']);
    expect(result).toEqual({});
  });

  it('should skip headers with colon at start', () => {
    const result = parseHeaders([':value']);
    expect(result).toEqual({});
  });

  it('should handle empty array', () => {
    expect(parseHeaders([])).toEqual({});
  });

  it('should use last value for duplicate keys', () => {
    const result = parseHeaders(['Accept: text/plain', 'Accept: application/json']);
    expect(result).toEqual({ Accept: 'application/json' });
  });
});

describe('parseSecrets', () => {
  it('should parse name=value strings', () => {
    const result = parseSecrets(['MY_VAR=aaa', 'OTHER_VAR=bbb']);
    expect(result).toEqual({
      MY_VAR: 'aaa',
      OTHER_VAR: 'bbb',
    });
  });

  it('should handle value with equals sign', () => {
    const result = parseSecrets(['ITEM=base64==data']);
    expect(result).toEqual({ ITEM: 'base64==data' });
  });

  it('should preserve empty value after equals', () => {
    const result = parseSecrets(['EMPTY_VAL=']);
    expect(result).toEqual({ EMPTY_VAL: '' });
  });

  it('should skip malformed entries (no equals)', () => {
    const result = parseSecrets(['malformed']);
    expect(result).toEqual({});
  });

  it('should handle empty array', () => {
    expect(parseSecrets([])).toEqual({});
  });

  it('should use last value for duplicate keys', () => {
    const result = parseSecrets(['MY_VAR=first', 'MY_VAR=second']);
    expect(result).toEqual({ MY_VAR: 'second' });
  });

  it('should trim whitespace around key name', () => {
    const result = parseSecrets(['  MY_VAR  =value']);
    expect(result).toEqual({ MY_VAR: 'value' });
  });

  it('should handle extra whitespace in entry', () => {
    const result = parseSecrets(['  KEY = val ']);
    expect(result).toEqual({ KEY: ' val ' });
  });
});

describe('getSecretScopes', () => {
  it('should extract scopes from manifest secrets', () => {
    const manifest = {
      schemaVersion: '1.0',
      name: 'test',
      version: '1.0.0',
      tools: [{
        name: 'echo',
        description: 'echo',
        action: 'https://example.com/echo.js',
        actionHash: 'sha256:' + 'a'.repeat(64),
        inputSchema: { type: 'object' as const, properties: {} },
      }],
      secrets: [
        { name: 'VAR_A', scope: 'https://api.github.com/*', required: false },
        { name: 'VAR_B', scope: ['https://api.com/*', 'https://cdn.com/*'], required: false },
      ],
    };
    const result = getSecretScopes(manifest);
    expect(result).toEqual({
      VAR_A: ['https://api.github.com/*'],
      VAR_B: ['https://api.com/*', 'https://cdn.com/*'],
    });
  });

  it('should return empty object for manifest without secrets', () => {
    const manifest = {
      schemaVersion: '1.0',
      name: 'test',
      version: '1.0.0',
      tools: [{
        name: 'echo',
        description: 'echo',
        action: 'https://example.com/echo.js',
        actionHash: 'sha256:' + 'a'.repeat(64),
        inputSchema: { type: 'object' as const, properties: {} },
      }],
    };
    expect(getSecretScopes(manifest)).toEqual({});
  });
});

describe('hashPath', () => {
  it('should return hex string of length 16', () => {
    const result = hashPath('/path/to/manifest');
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should be deterministic', () => {
    expect(hashPath('input')).toBe(hashPath('input'));
  });

  it('should differ for different inputs', () => {
    expect(hashPath('a')).not.toBe(hashPath('b'));
  });

  it('should handle URLs', () => {
    const result = hashPath('https://example.com/manifest.yml');
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('resolvePromptContent', () => {
  it('should substitute text prompt content', async () => {
    const readResourceContent = vi.fn();
    const result = await resolvePromptContent(
      { type: 'text', text: 'Explain {{path}}' },
      { path: 'src/index.ts' },
      readResourceContent
    );

    expect(result).toEqual({ type: 'text', text: 'Explain src/index.ts' });
    expect(readResourceContent).not.toHaveBeenCalled();
  });

  it('should load missing resource text from resolved URI', async () => {
    const readResourceContent = vi.fn().mockResolvedValue('# Loaded docs');
    const result = await resolvePromptContent(
      {
        type: 'resource',
        resource: {
          uri: 'https://example.com/docs/{{topic}}.md',
          mimeType: 'text/markdown',
        },
      },
      { topic: 'getting-started' },
      readResourceContent
    );

    expect(readResourceContent).toHaveBeenCalledWith('https://example.com/docs/getting-started.md');
    expect(result).toEqual({
      type: 'resource',
      resource: {
        uri: 'https://example.com/docs/getting-started.md',
        text: '# Loaded docs',
        mimeType: 'text/markdown',
      },
    });
  });

  it('should preserve explicit resource text without loading', async () => {
    const readResourceContent = vi.fn();
    const result = await resolvePromptContent(
      {
        type: 'resource',
        resource: {
          uri: 'https://example.com/docs/{{topic}}.md',
          text: 'Inline {{topic}} docs',
        },
      },
      { topic: 'api' },
      readResourceContent
    );

    expect(readResourceContent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'resource',
      resource: {
        uri: 'https://example.com/docs/api.md',
        text: 'Inline api docs',
      },
    });
  });

  it('should leave unknown placeholders intact', async () => {
    const readResourceContent = vi.fn().mockResolvedValue('content');
    const result = await resolvePromptContent(
      { type: 'resource', resource: { uri: './{{missing}}.md' } },
      {},
      readResourceContent
    );

    expect(readResourceContent).toHaveBeenCalledWith('./{{missing}}.md');
    expect(result).toEqual({
      type: 'resource',
      resource: { uri: './{{missing}}.md', text: 'content' },
    });
  });
});
