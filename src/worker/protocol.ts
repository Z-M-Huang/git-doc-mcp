/**
 * IPC protocol for worker process communication.
 * @module worker/protocol
 */

/**
 * Tool result type.
 */
export interface CallToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/**
 * Worker request from main process.
 */
export interface WorkerRequest {
  /** UUID for correlation */
  id: string;
  /** Request type */
  type: 'execute' | 'ping' | 'shutdown';
  /** Execute payload */
  payload?: {
    actionUrl: string;
    actionCode: string;
    input: unknown;
    secrets: Record<string, string>;
    timeout: number;
    manifest: {
      name: string;
      version: string;
    };
    secretScopes: Record<string, string[]>;
    /** Memory limit in bytes for sandbox isolate. Optional for backward compat. */
    memoryLimit?: number;
  };
}

/**
 * Worker response to main process.
 */
export interface WorkerResponse {
  /** Matches request ID */
  id: string;
  /** Response type */
  type: 'result' | 'error' | 'pong';
  /** Tool result (if successful) */
  result?: CallToolResult;
  /** Error details (if failed) */
  error?: {
    code: 'TIMEOUT' | 'MEMORY' | 'VALIDATION' | 'EXECUTION' | 'UNKNOWN';
    message: string;
  };
}

/**
 * Error codes for worker errors.
 */
export type WorkerErrorCode = 'TIMEOUT' | 'MEMORY' | 'VALIDATION' | 'EXECUTION' | 'UNKNOWN';

/**
 * Create a worker error response.
 */
export function createErrorResponse(
  id: string,
  code: WorkerErrorCode,
  message: string
): WorkerResponse {
  return {
    id,
    type: 'error',
    error: { code, message },
  };
}

/**
 * Create a worker success response.
 */
export function createSuccessResponse(
  id: string,
  result: CallToolResult
): WorkerResponse {
  return {
    id,
    type: 'result',
    result,
  };
}

/**
 * Create a pong response.
 */
export function createPongResponse(id: string): WorkerResponse {
  return {
    id,
    type: 'pong',
  };
}

/**
 * Parse a worker request from JSON.
 */
export function parseWorkerRequest(data: string): WorkerRequest | null {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed.id === 'string' && typeof parsed.type === 'string') {
      return parsed as WorkerRequest;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize a worker response to JSON.
 */
export function serializeWorkerResponse(response: WorkerResponse): string {
  return JSON.stringify(response);
}