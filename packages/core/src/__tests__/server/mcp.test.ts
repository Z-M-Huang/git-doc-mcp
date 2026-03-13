/**
 * Unit tests for server/mcp.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MCP SDK
const mockRegisterTool = vi.fn();
const mockRegisterResource = vi.fn();
const mockRegisterPrompt = vi.fn();
const mockConnect = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: mockRegisterTool,
    registerResource: mockRegisterResource,
    registerPrompt: mockRegisterPrompt,
    connect: mockConnect,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

import { createMcpServer, startMcpServer, jsonSchemaToZod } from '../../server/mcp.js';
import { z } from 'zod';

describe('jsonSchemaToZod', () => {
  it('should convert string property', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    const result = schema.safeParse({ name: 'test' });
    expect(result.success).toBe(true);
  });

  it('should convert number property', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    });
    expect(schema.safeParse({ count: 42 }).success).toBe(true);
    expect(schema.safeParse({ count: 'not-a-number' }).success).toBe(false);
  });

  it('should convert integer property to number', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    });
    expect(schema.safeParse({ id: 1 }).success).toBe(true);
  });

  it('should convert boolean property', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
    });
    expect(schema.safeParse({ flag: true }).success).toBe(true);
  });

  it('should convert array property', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { items: { type: 'array' } },
      required: ['items'],
    });
    expect(schema.safeParse({ items: [1, 2, 3] }).success).toBe(true);
  });

  it('should convert nested object to record', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { config: { type: 'object' } },
      required: ['config'],
    });
    expect(schema.safeParse({ config: { key: 'value' } }).success).toBe(true);
  });

  it('should convert unknown type to z.unknown()', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { custom: { type: 'custom' } },
    });
    expect(schema.safeParse({ custom: 'anything' }).success).toBe(true);
  });

  it('should make non-required fields optional', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { opt: { type: 'string' } },
      // Not in required
    });
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ opt: 'hello' }).success).toBe(true);
  });

  it('should handle empty properties', () => {
    const schema = jsonSchemaToZod({ type: 'object' });
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('should preserve description', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string', description: 'User name' } },
    });
    // Just verify it doesn't throw
    expect(schema).toBeDefined();
  });
});

describe('createMcpServer', () => {
  beforeEach(() => {
    mockRegisterTool.mockClear();
    mockRegisterResource.mockClear();
    mockRegisterPrompt.mockClear();
  });

  const baseManifest = {
    name: 'test-server',
    version: '1.0.0',
    description: 'Test',
    tools: [{
      name: 'echo',
      description: 'Echo tool',
      action: 'https://example.com/echo.js',
      actionHash: 'sha256:abc',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }],
  };

  it('should register tools', () => {
    createMcpServer({ manifest: baseManifest, onToolCall: vi.fn() });
    expect(mockRegisterTool).toHaveBeenCalledTimes(1);
    expect(mockRegisterTool.mock.calls[0][0]).toBe('echo');
  });

  it('should register tool with title and annotations', () => {
    const manifest = {
      ...baseManifest,
      tools: [{
        ...baseManifest.tools[0],
        title: 'Echo Tool',
        annotations: { readOnlyHint: true },
      }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn() });
    const toolOptions = mockRegisterTool.mock.calls[0][1];
    expect(toolOptions.title).toBe('Echo Tool');
    expect(toolOptions.annotations).toEqual({ readOnlyHint: true });
  });

  it('should invoke onToolCall when tool callback fires', async () => {
    const onToolCall = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });
    createMcpServer({ manifest: baseManifest, onToolCall });
    // The third argument to registerTool is the callback
    const callback = mockRegisterTool.mock.calls[0][2];
    const result = await callback({ text: 'hello' });
    expect(onToolCall).toHaveBeenCalledWith('echo', { text: 'hello' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'result' }] });
  });

  it('should register resources when provided', () => {
    const manifest = {
      ...baseManifest,
      resources: [{
        name: 'readme',
        uri: 'https://example.com/README.md',
        description: 'Readme file',
        mimeType: 'text/markdown',
      }],
    };
    createMcpServer({
      manifest,
      onToolCall: vi.fn(),
      onResourceRead: vi.fn(),
    });
    expect(mockRegisterResource).toHaveBeenCalledTimes(1);
  });

  it('should invoke onResourceRead when resource callback fires', async () => {
    const onResourceRead = vi.fn().mockResolvedValue('# README content');
    const manifest = {
      ...baseManifest,
      resources: [{
        name: 'readme',
        uri: 'https://example.com/README.md',
        description: 'Readme file',
        mimeType: 'text/markdown',
      }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn(), onResourceRead });
    // The fourth argument to registerResource is the callback
    const callback = mockRegisterResource.mock.calls[0][3];
    const result = await callback(new URL('https://example.com/README.md'));
    expect(onResourceRead).toHaveBeenCalledWith('https://example.com/README.md');
    expect(result.contents[0].text).toBe('# README content');
    expect(result.contents[0].mimeType).toBe('text/markdown');
  });

  it('should register resource without mimeType', async () => {
    const onResourceRead = vi.fn().mockResolvedValue('plain text');
    const manifest = {
      ...baseManifest,
      resources: [{
        name: 'data',
        uri: 'https://example.com/data.txt',
        description: 'Data file',
      }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn(), onResourceRead });
    const callback = mockRegisterResource.mock.calls[0][3];
    const result = await callback(new URL('https://example.com/data.txt'));
    expect(result.contents[0].mimeType).toBeUndefined();
  });

  it('should not register resources without handler', () => {
    const manifest = {
      ...baseManifest,
      resources: [{ name: 'r', uri: 'https://example.com/r', description: 'r' }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn() });
    expect(mockRegisterResource).not.toHaveBeenCalled();
  });

  it('should register prompts when provided', () => {
    const manifest = {
      ...baseManifest,
      prompts: [{
        name: 'greet',
        description: 'Greeting',
        args: [{ name: 'name', description: 'Name to greet', required: true }],
      }],
    };
    createMcpServer({
      manifest,
      onToolCall: vi.fn(),
      onPromptGet: vi.fn(),
    });
    expect(mockRegisterPrompt).toHaveBeenCalledTimes(1);
  });

  it('should invoke onPromptGet when prompt callback fires', async () => {
    const onPromptGet = vi.fn().mockResolvedValue('Hello World');
    const manifest = {
      ...baseManifest,
      prompts: [{
        name: 'greet',
        description: 'Greeting',
        args: [{ name: 'name', description: 'Name to greet', required: true }],
      }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn(), onPromptGet });
    // The third argument to registerPrompt is the callback
    const callback = mockRegisterPrompt.mock.calls[0][2];
    const result = await callback({ name: 'World' });
    expect(onPromptGet).toHaveBeenCalledWith('greet', { name: 'World' });
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content.text).toBe('Hello World');
  });

  it('should register prompt with optional args', () => {
    const manifest = {
      ...baseManifest,
      prompts: [{
        name: 'flex',
        description: 'Flexible prompt',
        args: [
          { name: 'required_arg', description: 'Required', required: true },
          { name: 'optional_arg', description: 'Optional', required: false },
        ],
      }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn(), onPromptGet: vi.fn() });
    expect(mockRegisterPrompt).toHaveBeenCalledTimes(1);
  });

  it('should register prompt without args', () => {
    const manifest = {
      ...baseManifest,
      prompts: [{
        name: 'simple',
        description: 'No args prompt',
      }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn(), onPromptGet: vi.fn() });
    expect(mockRegisterPrompt).toHaveBeenCalledTimes(1);
  });

  it('should register prompt with title', () => {
    const manifest = {
      ...baseManifest,
      prompts: [{
        name: 'titled',
        title: 'My Prompt Title',
        description: 'Has a title',
      }],
    };
    createMcpServer({ manifest, onToolCall: vi.fn(), onPromptGet: vi.fn() });
    const promptOptions = mockRegisterPrompt.mock.calls[0][1];
    expect(promptOptions.title).toBe('My Prompt Title');
  });

  it('should include instructions when manifest has them', () => {
    const manifest = {
      ...baseManifest,
      instructions: 'Always be helpful',
    };
    createMcpServer({ manifest, onToolCall: vi.fn() });
    // Just verifying it doesn't throw
    expect(mockRegisterTool).toHaveBeenCalled();
  });
});

describe('startMcpServer', () => {
  it('should connect transport to server', async () => {
    const mockServer = {
      registerTool: vi.fn(),
      registerResource: vi.fn(),
      registerPrompt: vi.fn(),
      connect: mockConnect,
    };
    // @ts-expect-error - mock object
    await startMcpServer(mockServer);
    expect(mockConnect).toHaveBeenCalled();
  });
});
