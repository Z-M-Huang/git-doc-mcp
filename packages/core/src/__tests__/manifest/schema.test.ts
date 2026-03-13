/**
 * Unit tests for manifest schema validation.
 * @module __tests__/manifest/schema.test
 */

import { describe, it, expect } from 'vitest';
import { ManifestSchema, ToolSchema, SecretSchema } from '../../manifest/schema.js';

describe('ManifestSchema', () => {
  describe('valid manifests', () => {
    it('should parse minimal valid manifest with required fields', () => {
      const manifest = {
        schemaVersion: '1.0',
        name: 'test-mcp',
        version: '1.0.0',
        tools: [
          {
            name: 'test',
            description: 'Test tool',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            action: 'https://example.com/action.js',
            actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      };

      const result = ManifestSchema.parse(manifest);
      expect(result.name).toBe('test-mcp');
      expect(result.version).toBe('1.0.0');
      expect(result.tools).toHaveLength(1);
    });

    it('should parse full manifest with all fields', () => {
      const manifest = {
        schemaVersion: '1.0',
        name: 'test-mcp',
        version: '1.0.0',
        description: 'Test MCP server',
        instructions: 'Use these tools for testing',
        secrets: [
          {
            name: 'API_TOKEN',
            description: 'API token',
            scope: ['https://api.example.com/*'],
            required: true,
          },
        ],
        tools: [
          {
            name: 'fetch',
            description: 'Fetch data',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
            action: 'https://example.com/action.js',
            actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
          },
        ],
        resources: [
          {
            name: 'readme',
            uri: 'https://example.com/README.md',
            description: 'README',
            mimeType: 'text/markdown',
          },
        ],
        prompts: [
          {
            name: 'explain',
            description: 'Explain code',
            args: [{ name: 'path', required: true }],
          },
        ],
      };

      const result = ManifestSchema.parse(manifest);
      expect(result.tools).toHaveLength(1);
      expect(result.resources).toHaveLength(1);
      expect(result.prompts).toHaveLength(1);
      expect(result.secrets).toHaveLength(1);
    });
  });

  describe('invalid manifests', () => {
    it('should reject missing schemaVersion', () => {
      const manifest = {
        name: 'test-mcp',
        version: '1.0.0',
        tools: [],
      };

      expect(() => ManifestSchema.parse(manifest)).toThrow();
    });

    it('should reject missing name', () => {
      const manifest = {
        schemaVersion: '1.0',
        version: '1.0.0',
        tools: [],
      };

      expect(() => ManifestSchema.parse(manifest)).toThrow();
    });

    it('should reject missing version', () => {
      const manifest = {
        schemaVersion: '1.0',
        name: 'test-mcp',
        tools: [],
      };

      expect(() => ManifestSchema.parse(manifest)).toThrow();
    });

    it('should reject manifest without tools', () => {
      const manifest = {
        schemaVersion: '1.0',
        name: 'test-mcp',
        version: '1.0.0',
      };

      expect(() => ManifestSchema.parse(manifest)).toThrow();
    });
  });
});

describe('ToolSchema', () => {
  it('should require action and actionHash', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'https://example.com/action.js',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    const result = ToolSchema.parse(tool);
    expect(result.action).toBe('https://example.com/action.js');
    expect(result.actionHash).toBe('sha256:0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('should reject missing actionHash', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'https://example.com/action.js',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });

  it('should reject invalid actionHash format', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'https://example.com/action.js',
      actionHash: 'sha256:abc123',  // Too short
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });

  it('should require inputSchema properties', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object' },  // Missing properties
      action: 'https://example.com/action.js',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });
});

describe('SecretSchema', () => {
  it('should accept string scope', () => {
    const secret = {
      name: 'TOKEN',
      scope: 'https://api.example.com/*',
    };

    const result = SecretSchema.parse(secret);
    expect(result.scope).toBe('https://api.example.com/*');
  });

  it('should accept array scope', () => {
    const secret = {
      name: 'TOKEN',
      scope: ['https://api.example.com/*', 'https://api2.example.com/*'],
    };

    const result = SecretSchema.parse(secret);
    expect(result.scope).toEqual(['https://api.example.com/*', 'https://api2.example.com/*']);
  });
});