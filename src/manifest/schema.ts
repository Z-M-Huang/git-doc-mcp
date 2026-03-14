/**
 * Zod schema for git-doc-mcp manifest files.
 * @module manifest/schema
 */

import { z } from 'zod';

/**
 * Schema version for future compatibility.
 */
export const SchemaVersionSchema = z.string().regex(/^\d+\.\d+$/);

/**
 * Secret scope pattern for URL validation.
 * Examples: "https://api.github.com/*", "https://raw.githubusercontent.com"
 */
export const SecretScopeSchema = z.string().min(1);

/**
 * Secret declaration in a manifest.
 */
export const SecretSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  scope: z.union([
    SecretScopeSchema,
    z.array(SecretScopeSchema).min(1),
  ]),
  required: z.boolean().default(false),
});

/**
 * Tool annotation hints for MCP clients.
 */
export const ToolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().default(false),
  destructiveHint: z.boolean().default(false),
  idempotentHint: z.boolean().default(false),
  openWorldHint: z.boolean().default(false),
});

/**
 * JSON Schema for tool input validation.
 */
export const InputSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.unknown()),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
});

/**
 * Tool definition in a manifest.
 */
export const ToolSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().optional(),
  description: z.string().min(1),
  inputSchema: InputSchemaSchema,
  action: z.string().url(),
  actionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  annotations: ToolAnnotationsSchema.optional(),
});

/**
 * Resource definition in a manifest.
 */
export const ResourceSchema = z.object({
  name: z.string().min(1),
  uri: z.string().url(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

/**
 * Prompt argument definition.
 */
export const PromptArgSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().default(false),
});

/**
 * Text content in a prompt message (MCP TextContent).
 */
export const PromptTextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
});

/**
 * Embedded resource content in a prompt message (MCP EmbeddedResource).
 */
export const PromptResourceContentSchema = z.object({
  type: z.literal('resource'),
  resource: z.object({
    uri: z.string().min(1),
    text: z.string().optional(),
    mimeType: z.string().optional(),
  }),
});

/**
 * Content block in a prompt message.
 * Matches MCP ContentBlock subset relevant for declarative prompts.
 */
export const PromptContentSchema = z.discriminatedUnion('type', [
  PromptTextContentSchema,
  PromptResourceContentSchema,
]);

/**
 * A message in a prompt template (MCP PromptMessage).
 */
export const PromptMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: PromptContentSchema,
});

/**
 * Prompt definition in a manifest.
 *
 * When `messages` is provided, they are returned directly (with {{arg}} substitution).
 * When omitted, a single user message is built from `description` + args.
 */
export const PromptSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().optional(),
  description: z.string().min(1),
  args: z.array(PromptArgSchema).optional(),
  messages: z.array(PromptMessageSchema).min(1).optional(),
});

/**
 * Complete manifest schema.
 */
export const ManifestSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  name: z.string().min(1).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/),
  description: z.string().optional(),
  instructions: z.string().optional(),
  secrets: z.array(SecretSchema).optional(),
  tools: z.array(ToolSchema).min(1),
  resources: z.array(ResourceSchema).optional(),
  prompts: z.array(PromptSchema).optional(),
});

/**
 * Parsed manifest type.
 */
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Secret type.
 */
export type Secret = z.infer<typeof SecretSchema>;

/**
 * Tool type.
 */
export type Tool = z.infer<typeof ToolSchema>;

/**
 * Resource type.
 */
export type Resource = z.infer<typeof ResourceSchema>;

/**
 * Prompt type.
 */
export type Prompt = z.infer<typeof PromptSchema>;

/**
 * Prompt message type.
 */
export type PromptMessage = z.infer<typeof PromptMessageSchema>;

/**
 * Prompt content type.
 */
export type PromptContent = z.infer<typeof PromptContentSchema>;

/**
 * Tool annotations type.
 */
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

/**
 * Parse and validate a manifest from YAML content.
 */
export function parseManifest(yamlContent: string, parseYaml: (content: string) => unknown): Manifest {
  const raw = parseYaml(yamlContent);
  return ManifestSchema.parse(raw);
}

/**
 * Validate a manifest object.
 */
export function validateManifest(manifest: unknown): Manifest {
  return ManifestSchema.parse(manifest);
}