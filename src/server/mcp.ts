/**
 * MCP server setup using @modelcontextprotocol/sdk.
 * @module server/mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Manifest, Tool, Resource, Prompt } from '../manifest/schema.js';

/**
 * Result from a prompt get handler, matching MCP GetPromptResult shape.
 *
 * For resource content, `resource.text` is required per MCP TextResourceContents.
 * Use empty string if the resource text is not available at prompt resolution time.
 */
export interface PromptResult {
  description?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content:
      | { type: 'text'; text: string }
      | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string } };
  }>;
}

/**
 * MCP server options.
 */
export interface McpServerOptions {
  manifest: Manifest;
  /** Tool execution handler */
  onToolCall: (name: string, input: unknown) => Promise<unknown>;
  /** Resource read handler */
  onResourceRead?: (uri: string) => Promise<string>;
  /** Prompt get handler - returns structured messages matching MCP PromptMessage[] */
  onPromptGet?: (name: string, args: Record<string, string>) => Promise<PromptResult>;
}

/**
 * Create and configure MCP server from manifest.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { manifest, onToolCall, onResourceRead, onPromptGet } = options;

  // Build server options
  const serverOptions = {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    ...(manifest.instructions ? { instructions: manifest.instructions } : {}),
  };

  // Create server instance
  const server = new McpServer(
    {
      name: manifest.name,
      version: manifest.version,
    },
    serverOptions
  );

  // Register tools
  for (const tool of manifest.tools ?? []) {
    registerTool(server, tool, onToolCall);
  }

  // Register resources
  for (const resource of manifest.resources ?? []) {
    registerResource(server, resource, onResourceRead);
  }

  // Register prompts
  for (const prompt of manifest.prompts ?? []) {
    registerPrompt(server, prompt, onPromptGet);
  }

  return server;
}

/**
 * Register a tool with the MCP server.
 */
function registerTool(
  server: McpServer,
  tool: Tool,
  onToolCall: (name: string, input: unknown) => Promise<unknown>
): void {
  // Convert JSON Schema to Zod schema
  const zodSchema = jsonSchemaToZod(tool.inputSchema);

  // Build tool options
  const toolOptions: {
    description: string;
    inputSchema: z.ZodObject<Record<string, z.ZodType>>;
    title?: string;
    annotations?: Tool['annotations'];
  } = {
    description: tool.description,
    inputSchema: zodSchema,
  };

  if (tool.title) {
    toolOptions.title = tool.title;
  }
  if (tool.annotations) {
    toolOptions.annotations = tool.annotations;
  }

  server.registerTool(
    tool.name,
    toolOptions,
    async (input) => {
      const result = await onToolCall(tool.name, input);
      return result as { content: Array<{ type: 'text'; text: string }> };
    }
  );
}

/**
 * Register a resource with the MCP server.
 */
function registerResource(
  server: McpServer,
  resource: Resource,
  onResourceRead?: (uri: string) => Promise<string>
): void {
  if (!onResourceRead) return;

  const resourceOptions: {
    description?: string;
    mimeType?: string;
  } = {};

  if (resource.description) {
    resourceOptions.description = resource.description;
  }
  if (resource.mimeType) {
    resourceOptions.mimeType = resource.mimeType;
  }

  server.registerResource(
    resource.name,
    resource.uri,
    resourceOptions,
    async (uri) => {
      const content = await onResourceRead(uri.href);
      const contents: { uri: string; text: string; mimeType?: string } = {
        uri: uri.href,
        text: content,
      };
      if (resource.mimeType) {
        contents.mimeType = resource.mimeType;
      }
      return {
        contents: [contents],
      };
    }
  );
}

/**
 * Register a prompt with the MCP server.
 */
function registerPrompt(
  server: McpServer,
  prompt: Prompt,
  onPromptGet?: (name: string, args: Record<string, string>) => Promise<PromptResult>
): void {
  if (!onPromptGet) return;

  // Build Zod schema from prompt args
  const argsSchemaRecord: Record<string, z.ZodType> = {};
  for (const arg of prompt.args ?? []) {
    let schema: z.ZodType = z.string();
    if (arg.description) {
      schema = schema.describe(arg.description);
    }
    if (!arg.required) {
      schema = schema.optional();
    }
    argsSchemaRecord[arg.name] = schema;
  }

  server.registerPrompt(
    prompt.name,
    {
      description: prompt.description,
      ...(prompt.title ? { title: prompt.title } : {}),
      ...(Object.keys(argsSchemaRecord).length > 0 ? { argsSchema: argsSchemaRecord } : {}),
    },
    async (args) => {
      const result = await onPromptGet(prompt.name, args as Record<string, string>);
      return {
        ...(result.description ? { description: result.description } : {}),
        messages: result.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      };
    }
  );
}

/**
 * Convert JSON Schema to Zod schema.
 * This is a simplified implementation for basic types.
 */
export function jsonSchemaToZod(schema: { type: string; properties?: Record<string, unknown>; required?: string[] }): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};

  if (schema.type === 'object' && schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const propSchema = prop as { type: string; description?: string };
      let zodType: z.ZodType;

      switch (propSchema.type) {
        case 'string':
          zodType = z.string();
          break;
        case 'number':
        case 'integer':
          zodType = z.number();
          break;
        case 'boolean':
          zodType = z.boolean();
          break;
        case 'array':
          zodType = z.array(z.unknown());
          break;
        case 'object':
          zodType = z.record(z.unknown());
          break;
        default:
          zodType = z.unknown();
      }

      if (propSchema.description) {
        zodType = zodType.describe(propSchema.description);
      }

      // Check if required
      const isRequired = schema.required?.includes(key);
      if (!isRequired) {
        zodType = zodType.optional();
      }

      shape[key] = zodType;
    }
  }

  return z.object(shape);
}

/**
 * Start the MCP server with stdio transport.
 */
export async function startMcpServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}