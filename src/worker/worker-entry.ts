/**
 * Worker process entry point.
 * Handles action execution in an isolated process.
 * @module worker/worker-entry
 */

import * as readline from 'node:readline';
import { executeAction } from '../sandbox/executor.js';
import { WorkerRequest, WorkerResponse, createPongResponse, createSuccessResponse, createErrorResponse } from './protocol.js';
import type { AuditEvent, AuditLogger } from '../audit/logger.js';

/**
 * Manifest type for context (simplified).
 */
interface SimplifiedManifest {
  name: string;
  version: string;
}

/**
 * Audit proxy that sends structured audit events to the main process via stdout.
 * The main process's WorkerManager intercepts these messages (type: 'audit')
 * and routes them to the single AuditLogger instance.
 *
 * This avoids file write race conditions - only the main process writes to disk.
 */
export class WorkerAuditProxy implements AuditLogger {
  log(event: AuditEvent): void {
    console.log(JSON.stringify({ type: 'audit', event }));
  }

  logFetch(url: string, status?: number, duration?: number, manifestName?: string): void {
    this.log({ timestamp: new Date().toISOString(), event: 'fetch', url, status: status?.toString(), duration_ms: duration, manifestName });
  }

  logRedirect(from: string, to: string, manifestName?: string): void {
    this.log({ timestamp: new Date().toISOString(), event: 'redirect', url: to, details: { from }, manifestName });
  }

  logSecretAccess(secretName: string, url: string, allowed: boolean, manifestName?: string): void {
    this.log({ timestamp: new Date().toISOString(), event: 'secret-access', secretName, url, status: allowed ? 'allowed' : 'denied', manifestName });
  }

  logActionStart(actionName: string, manifestName?: string): void {
    this.log({ timestamp: new Date().toISOString(), event: 'action-start', actionName, manifestName });
  }

  logActionEnd(actionName: string, status: string, duration_ms: number, manifestName?: string): void {
    this.log({ timestamp: new Date().toISOString(), event: 'action-end', actionName, status, duration_ms, manifestName });
  }

  logActionLog(level: string, message: string, manifestName?: string): void {
    this.log({ timestamp: new Date().toISOString(), event: 'action-log', status: level, details: { message }, manifestName });
  }

  logError(message: string, details?: Record<string, unknown>, manifestName?: string): void {
    this.log({ timestamp: new Date().toISOString(), event: 'error', details: { message, ...details }, manifestName });
  }

  async close(): Promise<void> {
    // No-op: the worker proxy has no resources to clean up
  }
}

/**
 * Main worker loop.
 * Reads JSON requests from stdin, executes actions, writes responses to stdout.
 */
async function main(): Promise<void> {
  const auditProxy = new WorkerAuditProxy();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line: string) => {
    let request: WorkerRequest;

    try {
      request = JSON.parse(line) as WorkerRequest;
    } catch {
      auditProxy.logError('Invalid JSON from main process', { line: line.substring(0, 200) });
      return;
    }

    try {
      const response = await handleRequest(request, auditProxy);
      console.log(JSON.stringify(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      auditProxy.logError('Worker request failed', { error: message });
      const response: WorkerResponse = createErrorResponse(request.id, 'EXECUTION', message);
      console.log(JSON.stringify(response));
    }
  });

  // Handle shutdown
  process.on('SIGTERM', () => {
    rl.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    rl.close();
    process.exit(0);
  });
}

/**
 * Handle a worker request.
 */
export async function handleRequest(request: WorkerRequest, auditLogger?: AuditLogger): Promise<WorkerResponse> {
  switch (request.type) {
    case 'ping':
      return createPongResponse(request.id);

    case 'shutdown':
      // Exit after sending response
      setTimeout(() => process.exit(0), 100);
      return createSuccessResponse(request.id, { content: [{ type: 'text', text: 'Shutting down' }] });

    case 'execute': {
      const payload = request.payload;
      if (!payload) {
        return createErrorResponse(request.id, 'VALIDATION', 'Missing payload');
      }

      try {
        const manifest: SimplifiedManifest = {
          name: payload.manifest.name,
          version: payload.manifest.version,
        };

        const memoryLimit = payload.memoryLimit ?? 128 * 1024 * 1024;
        const result = await executeAction(
          payload.actionCode,
          payload.input,
          {
            manifest,
            secrets: payload.secrets ?? {},
            secretScopes: payload.secretScopes ?? {},
            timeout: payload.timeout ?? 60000,
            auditLogger,
          },
          {
            memoryLimit,
            cpuTimeLimit: 30000,
            wallTimeLimit: payload.timeout ?? 60000,
          }
        );

        return createSuccessResponse(request.id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        auditLogger?.logError('Worker execution failed', { error: message });
        return createErrorResponse(request.id, 'EXECUTION', message);
      }
    }

    default:
      return createErrorResponse(request.id, 'UNKNOWN', `Unknown request type: ${(request as { type: string }).type}`);
  }
}

// Start worker
main().catch((error) => {
  console.error('Worker error:', error);
  process.exit(1);
});
