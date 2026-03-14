/**
 * Unit tests for manifest schema validation.
 * @module __tests__/manifest/schema.test
 */

import { describe, it, expect } from 'vitest';
import { ManifestSchema, ToolSchema, SecretSchema, PromptSchema, ResourceSchema } from '../../manifest/schema.js';

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

  it('should accept relative file path for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: './actions/echo.js',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    const result = ToolSchema.parse(tool);
    expect(result.action).toBe('./actions/echo.js');
  });

  it('should accept absolute file path for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: '/home/user/actions/echo.js',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    const result = ToolSchema.parse(tool);
    expect(result.action).toBe('/home/user/actions/echo.js');
  });

  it('should accept relative path without dot prefix for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'actions/echo.js',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    const result = ToolSchema.parse(tool);
    expect(result.action).toBe('actions/echo.js');
  });

  it('should reject ftp:// scheme for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'ftp://example.com/action.js',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });

  it('should reject data: URI for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'data:text/javascript,console.log("hi")',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });

  it('should reject mailto: URI for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'mailto:test@example.com',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });

  it('should reject javascript: URI for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'javascript:alert(1)',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });

  it('should reject blob: URI for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'blob:https://example.com/123',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });

  it('should reject file: URI for action', () => {
    const tool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      action: 'file:///etc/passwd',
      actionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => ToolSchema.parse(tool)).toThrow();
  });
});

describe('ResourceSchema', () => {
  it('should accept HTTPS URL for resource uri', () => {
    const resource = {
      name: 'readme',
      uri: 'https://example.com/README.md',
    };

    const result = ResourceSchema.parse(resource);
    expect(result.uri).toBe('https://example.com/README.md');
  });

  it('should accept local file path for resource uri', () => {
    const resource = {
      name: 'readme',
      uri: './docs/README.md',
    };

    const result = ResourceSchema.parse(resource);
    expect(result.uri).toBe('./docs/README.md');
  });

  it('should reject ftp:// scheme for resource uri', () => {
    const resource = {
      name: 'readme',
      uri: 'ftp://example.com/README.md',
    };

    expect(() => ResourceSchema.parse(resource)).toThrow();
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

describe('PromptSchema', () => {
  it('should accept prompt without messages (backward compat)', () => {
    const prompt = {
      name: 'greet',
      description: 'Greet the user',
      args: [{ name: 'name', required: true }],
    };
    const result = PromptSchema.parse(prompt);
    expect(result.messages).toBeUndefined();
    expect(result.args).toHaveLength(1);
  });

  it('should accept prompt with text messages', () => {
    const prompt = {
      name: 'explain',
      description: 'Explain code',
      args: [{ name: 'path', required: true }],
      messages: [
        { role: 'user', content: { type: 'text', text: 'Explain {{path}}' } },
      ],
    };
    const result = PromptSchema.parse(prompt);
    expect(result.messages).toHaveLength(1);
    expect(result.messages![0].role).toBe('user');
    expect(result.messages![0].content.type).toBe('text');
  });

  it('should accept prompt with resource messages', () => {
    const prompt = {
      name: 'review',
      description: 'Review code',
      messages: [
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: {
              uri: 'https://example.com/{{path}}',
              mimeType: 'text/plain',
            },
          },
        },
        { role: 'user', content: { type: 'text', text: 'Review the above' } },
      ],
    };
    const result = PromptSchema.parse(prompt);
    expect(result.messages).toHaveLength(2);
    expect(result.messages![0].content.type).toBe('resource');
    expect(result.messages![1].content.type).toBe('text');
  });

  it('should accept multi-turn assistant messages', () => {
    const prompt = {
      name: 'guided',
      description: 'Guided analysis',
      messages: [
        { role: 'user', content: { type: 'text', text: 'Analyze this code' } },
        { role: 'assistant', content: { type: 'text', text: 'I will look at structure first' } },
        { role: 'user', content: { type: 'text', text: 'Now check for bugs' } },
      ],
    };
    const result = PromptSchema.parse(prompt);
    expect(result.messages).toHaveLength(3);
    expect(result.messages![1].role).toBe('assistant');
  });

  it('should reject empty messages array', () => {
    const prompt = {
      name: 'empty',
      description: 'Empty messages',
      messages: [],
    };
    expect(() => PromptSchema.parse(prompt)).toThrow();
  });

  it('should reject invalid role', () => {
    const prompt = {
      name: 'bad-role',
      description: 'Bad role',
      messages: [
        { role: 'system', content: { type: 'text', text: 'hi' } },
      ],
    };
    expect(() => PromptSchema.parse(prompt)).toThrow();
  });

  it('should reject invalid content type', () => {
    const prompt = {
      name: 'bad-type',
      description: 'Bad content type',
      messages: [
        { role: 'user', content: { type: 'image', url: 'https://example.com/img.png' } },
      ],
    };
    expect(() => PromptSchema.parse(prompt)).toThrow();
  });
});