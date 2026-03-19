/**
 * Worker process manager.
 * @module worker/process
 */

import * as childProcess from 'node:child_process';
import * as url from 'node:url';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { WorkerRequest, WorkerResponse } from './protocol.js';
import type { AuditLogger, AuditEvent } from '../audit/logger.js';

// ESM-compatible __dirname
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Sanitized environment variables to pass to worker.
 * Only allow specific, safe environment variables.
 */
const ALLOWED_ENV_VARS = [
  'NODE_ENV',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'PATH',
];

/**
 * Worker process options.
 */
export interface WorkerOptions {
  /** Worker process timeout in ms (default: 60000) */
  timeout?: number;
  /** Maximum restart attempts (default: 2) */
  maxRestarts?: number;
  /** Logger function */
  logger?: (level: string, message: string) => void;
  /** Optional audit logger for forwarding worker audit events */
  auditLogger?: AuditLogger;
}

/**
 * Default worker options.
 */
const DEFAULT_WORKER_OPTIONS: Required<Omit<WorkerOptions, 'auditLogger'>> = {
  timeout: 60000,
  maxRestarts: 2,
  logger: console.error,
};

/**
 * Pending request tracking.
 */
interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Worker process manager.
 * Handles spawning, communication, and lifecycle of worker processes.
 */
export class WorkerManager {
  private worker: childProcess.ChildProcess | null = null;
  private isHealthy = false;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private buffer = '';
  private options: Required<Omit<WorkerOptions, 'auditLogger'>> & { auditLogger?: AuditLogger };

  constructor(options: WorkerOptions = {}) {
    const { auditLogger, ...rest } = options;
    this.options = { ...DEFAULT_WORKER_OPTIONS, ...rest, auditLogger };
  }

  /**
 * Spawn a new worker process.
   */
  private async spawnWorker(): Promise<void> {
    const workerPath = path.join(__dirname, 'worker-entry.js');

    // Create sanitized environment
    const sanitizedEnv: Record<string, string> = {
      NODE_ENV: 'production',
    };

    // Only copy allowed environment variables
    for (const key of ALLOWED_ENV_VARS) {
      if (process.env[key] !== undefined) {
        sanitizedEnv[key] = process.env[key]!;
      }
    }

    this.worker = childProcess.fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: sanitizedEnv,
    });

    this.isHealthy = true;
    this.buffer = '';

    // Handle stdout (JSON responses)
    this.worker.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data);
    });

    // Handle stderr (logs)
    this.worker.stderr?.on('data', (data: Buffer) => {
      this.options.logger('info', data.toString());
    });

    // Handle process exit
    this.worker.on('exit', (code, signal) => {
      this.isHealthy = false;
      this.options.logger('warn', `Worker exited: code=${code}, signal=${signal}`);

      // Reject all pending requests
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('Worker process crashed'));
      }
      this.pendingRequests.clear();
    });

    // Handle errors
    this.worker.on('error', (error) => {
      this.isHealthy = false;
      this.options.logger('error', `Worker error: ${error.message}`);
    });

    // Wait for worker to be ready
    await this.pingWorker();
  }

  /**
   * Handle stdout data from worker.
   */
  private handleStdout(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete lines (newline-delimited JSON)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) {
        this.handleResponse(line);
      }
    }
  }

  /**
   * Handle a response from the worker.
   */
  private handleResponse(line: string): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      // Handle audit messages from worker (forwarded via WorkerAuditProxy)
      if (parsed.type === 'audit' && parsed.event && this.options.auditLogger) {
        this.options.auditLogger.log(parsed.event as AuditEvent);
        return;
      }

      const response = parsed as unknown as WorkerResponse;
      const pending = this.pendingRequests.get(response.id);

      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    } catch {
      this.options.logger('error', `Failed to parse response: ${line}`);
    }
  }

  /**
   * Send a request to the worker.
   */
  private sendRequest(request: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.isHealthy) {
        reject(new Error('Worker not available'));
        return;
      }

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(request.id);

        // Kill the worker on timeout
        this.options.logger('warn', `Request ${request.id} timed out, killing worker`);
        this.killWorker();

        reject(new Error('Request timeout'));
      }, this.options.timeout);

      this.pendingRequests.set(request.id, { resolve, reject, timeoutId });

      // Send request via stdin
      const json = JSON.stringify(request) + '\n';
      this.worker.stdin?.write(json);
    });
  }

  /**
   * Kill the worker process.
   */
  private killWorker(): void {
    if (this.worker) {
      this.isHealthy = false;
      this.worker.kill('SIGKILL');
      this.worker = null;
    }
  }

  /**
   * Ping the worker to check if it's alive.
   */
  private async pingWorker(): Promise<void> {
    const request: WorkerRequest = {
      id: crypto.randomUUID(),
      type: 'ping',
    };

    const response = await this.sendRequest(request);
    if (response.type !== 'pong') {
      throw new Error('Worker ping failed');
    }
  }

  /**
   * Execute an action in the worker.
   */
  async executeAction(request: WorkerRequest): Promise<WorkerResponse> {
    let attempts = 0;
    const maxAttempts = this.options.maxRestarts + 1;

    while (attempts < maxAttempts) {
      try {
        // Ensure worker is running
        if (!this.worker || !this.isHealthy) {
          await this.spawnWorker();
        }

        return await this.sendRequest(request);
      } catch (error) {
        attempts++;
        this.isHealthy = false;

        if (attempts >= maxAttempts) {
          throw error;
        }

        this.options.logger('warn', `Worker failed, restarting... (attempt ${attempts})`);
      }
    }

    throw new Error('Worker failed after maximum restarts');
  }

  /**
   * Shutdown the worker.
   */
  async shutdown(): Promise<void> {
    if (this.worker) {
      const request: WorkerRequest = {
        id: crypto.randomUUID(),
        type: 'shutdown',
      };

      try {
        await this.sendRequest(request);
      } catch {
        // Ignore shutdown errors
      }

      this.worker.kill();
      this.worker = null;
      this.isHealthy = false;
    }
  }
}