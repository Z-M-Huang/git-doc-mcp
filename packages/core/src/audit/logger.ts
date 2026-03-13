/**
 * Structured audit logger for security events.
 * Writes JSON-lines to ~/.git-doc-mcp/logs/audit.jsonl with auto-rotation at 10MB.
 *
 * IMPORTANT: This logger runs ONLY in the main process.
 * Worker processes use WorkerAuditProxy (defined in worker-entry.ts)
 * which sends audit events via IPC to avoid file write race conditions.
 *
 * @module audit/logger
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Audit event types for security-relevant operations.
 */
export interface AuditEvent {
  timestamp: string;
  event: 'action-start' | 'action-end' | 'fetch' | 'redirect' | 'secret-access' | 'error' | 'action-log';
  actionName?: string;
  url?: string;
  secretName?: string;
  status?: string;
  duration_ms?: number;
  manifestName?: string;
  details?: Record<string, unknown>;
}

/**
 * Audit logger interface.
 */
export interface AuditLogger {
  log(event: AuditEvent): void;
  logFetch(url: string, status?: number, duration?: number, manifestName?: string): void;
  logRedirect(from: string, to: string, manifestName?: string): void;
  logSecretAccess(secretName: string, url: string, allowed: boolean, manifestName?: string): void;
  logActionStart(actionName: string, manifestName?: string): void;
  logActionEnd(actionName: string, status: string, duration_ms: number, manifestName?: string): void;
  logActionLog(level: string, message: string, manifestName?: string): void;
  logError(message: string, details?: Record<string, unknown>, manifestName?: string): void;
  close(): Promise<void>;
}

/**
 * Maximum audit log file size before rotation (10MB).
 */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/**
 * Buffer flush thresholds.
 */
const FLUSH_INTERVAL_MS = 100;
const FLUSH_BUFFER_SIZE = 50;

/**
 * File-based audit logger.
 * Writes JSON-lines to disk with buffering and auto-rotation.
 */
export class FileAuditLogger implements AuditLogger {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private logDir: string;
  private logFile: string;
  private dirCreated = false;
  private flushing = false;

  constructor(logDir?: string) {
    this.logDir = logDir ?? path.join(os.homedir(), '.git-doc-mcp', 'logs');
    this.logFile = path.join(this.logDir, 'audit.jsonl');
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    // Unref the timer so it doesn't prevent Node from exiting
    if (this.flushTimer && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  log(event: AuditEvent): void {
    this.buffer.push(JSON.stringify(event));
    if (this.buffer.length >= FLUSH_BUFFER_SIZE) {
      this.flush().catch(() => {});
    }
  }

  logFetch(url: string, status?: number, duration?: number, manifestName?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      event: 'fetch',
      url,
      status: status?.toString(),
      duration_ms: duration,
      manifestName,
    });
  }

  logRedirect(from: string, to: string, manifestName?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      event: 'redirect',
      url: to,
      details: { from },
      manifestName,
    });
  }

  logSecretAccess(secretName: string, url: string, allowed: boolean, manifestName?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      event: 'secret-access',
      secretName,
      url,
      status: allowed ? 'allowed' : 'denied',
      manifestName,
    });
  }

  logActionStart(actionName: string, manifestName?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      event: 'action-start',
      actionName,
      manifestName,
    });
  }

  logActionEnd(actionName: string, status: string, duration_ms: number, manifestName?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      event: 'action-end',
      actionName,
      status,
      duration_ms,
      manifestName,
    });
  }

  logActionLog(level: string, message: string, manifestName?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      event: 'action-log',
      status: level,
      details: { message },
      manifestName,
    });
  }

  logError(message: string, details?: Record<string, unknown>, manifestName?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      event: 'error',
      details: { message, ...details },
      manifestName,
    });
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;

    this.flushing = true;
    const lines = this.buffer.splice(0);

    try {
      if (!this.dirCreated) {
        await fs.mkdir(this.logDir, { recursive: true });
        this.dirCreated = true;
      }

      // Check for rotation before writing
      await this.rotate();

      // Append all buffered lines
      const data = lines.join('\n') + '\n';
      await fs.appendFile(this.logFile, data, 'utf-8');
    } catch {
      // Audit failures never crash the process
    } finally {
      this.flushing = false;
    }
  }

  private async rotate(): Promise<void> {
    try {
      const stat = await fs.stat(this.logFile);
      if (stat.size >= MAX_LOG_SIZE) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rotatedFile = path.join(this.logDir, `audit-${timestamp}.jsonl`);
        await fs.rename(this.logFile, rotatedFile);
      }
    } catch {
      // File doesn't exist yet or can't stat — no rotation needed
    }
  }
}

/**
 * No-op audit logger for testing or when audit logging is disabled.
 */
export class NoopAuditLogger implements AuditLogger {
  log(): void {}
  logFetch(): void {}
  logRedirect(): void {}
  logSecretAccess(): void {}
  logActionStart(): void {}
  logActionEnd(): void {}
  logActionLog(): void {}
  logError(): void {}
  async close(): Promise<void> {}
}

/**
 * Create an audit logger instance.
 */
export function createAuditLogger(logDir?: string): AuditLogger {
  return new FileAuditLogger(logDir);
}
