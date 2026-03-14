/**
 * Unit tests for worker/process.ts (WorkerManager).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

const { mockFork } = vi.hoisted(() => ({ mockFork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: mockFork }));

import { WorkerManager } from '../../worker/process.js';

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new Writable({ write: (_chunk, _enc, cb) => { cb(); } });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  proc.pid = 1234;
  return proc;
}

function pushResponse(proc: ReturnType<typeof createMockProcess>, data: object) {
  proc.stdout.push(JSON.stringify(data) + '\n');
}

describe('WorkerManager', () => {
  let manager: WorkerManager;

  beforeEach(() => {
    mockFork.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should spawn worker and ping successfully', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);

    manager = new WorkerManager({ timeout: 5000 });

    // Intercept the ping request and respond
    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        }
        cb();
      },
    });

    const request = {
      id: 'test-exec-1',
      type: 'execute' as const,
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'export default async function(input) { return { content: [{ type: "text", text: "hi" }] }; }',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    // Start execute and respond
    const execPromise = manager.executeAction(request);

    // Wait for the execute request to be sent, then respond
    await vi.advanceTimersByTimeAsync(10);
    pushResponse(proc, {
      id: 'test-exec-1',
      type: 'result',
      result: { content: [{ type: 'text', text: 'hello' }] },
    });

    const response = await execPromise;
    expect(response.type).toBe('result');
    expect(response.result?.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('should reject pending requests on worker exit', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);

    manager = new WorkerManager({ timeout: 5000, maxRestarts: 0 });

    // Auto-respond to ping
    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        }
        cb();
      },
    });

    const request = {
      id: 'crash-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const execPromise = manager.executeAction(request);
    await vi.advanceTimersByTimeAsync(10);

    // Simulate worker crash
    proc.emit('exit', 1, null);

    await expect(execPromise).rejects.toThrow(/crashed/);
  });

  it('should forward audit messages to audit logger', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);

    const auditLogger = { log: vi.fn(), close: vi.fn() };
    manager = new WorkerManager({ timeout: 5000, auditLogger: auditLogger as any });

    // Auto-respond to ping
    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        }
        cb();
      },
    });

    const request = {
      id: 'audit-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const execPromise = manager.executeAction(request);
    await vi.advanceTimersByTimeAsync(10);

    // Send an audit message from worker
    pushResponse(proc, {
      type: 'audit',
      event: { timestamp: '2026-01-01T00:00:00Z', event: 'fetch', url: 'https://example.com' },
    });

    // Then send the actual result
    pushResponse(proc, {
      id: 'audit-test',
      type: 'result',
      result: { content: [{ type: 'text', text: 'done' }] },
    });

    const response = await execPromise;
    expect(response.type).toBe('result');
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'fetch', url: 'https://example.com' })
    );
  });

  it('should timeout pending requests', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);

    // Use short timeout, no restarts
    manager = new WorkerManager({ timeout: 100, maxRestarts: 0 });

    // Auto-respond to ping only
    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        }
        // Do NOT respond to execute - let it timeout
        cb();
      },
    });

    const request = {
      id: 'timeout-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 100,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const execPromise = manager.executeAction(request);
    // Attach handler before advancing to avoid unhandled rejection
    const expectPromise = expect(execPromise).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(200);
    await expectPromise;
  });

  it('should restart worker on failure when maxRestarts > 0', async () => {
    const proc1 = createMockProcess();
    const proc2 = createMockProcess();
    mockFork.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    manager = new WorkerManager({ timeout: 5000, maxRestarts: 1, logger: vi.fn() });

    // Proc1: respond to ping, then crash on execute
    proc1.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc1, { id: req.id, type: 'pong' });
        }
        cb();
      },
    });

    // Proc2: respond to ping and execute
    proc2.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc2, { id: req.id, type: 'pong' });
        } else if (req.type === 'execute') {
          pushResponse(proc2, {
            id: req.id,
            type: 'result',
            result: { content: [{ type: 'text', text: 'recovered' }] },
          });
        }
        cb();
      },
    });

    const request = {
      id: 'restart-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const execPromise = manager.executeAction(request);
    await vi.advanceTimersByTimeAsync(10);

    // Crash proc1
    proc1.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(50);

    const response = await execPromise;
    expect(response.type).toBe('result');
    expect(response.result?.content[0]).toEqual({ type: 'text', text: 'recovered' });
  });

  it('should emit error events from worker', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);
    const logger = vi.fn();

    manager = new WorkerManager({ timeout: 5000, logger });

    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        }
        cb();
      },
    });

    const request = {
      id: 'error-event-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const execPromise = manager.executeAction(request);
    await vi.advanceTimersByTimeAsync(10);

    // Emit error event on worker process
    proc.emit('error', new Error('spawn ENOENT'));

    // Now send result so the promise resolves
    pushResponse(proc, {
      id: 'error-event-test',
      type: 'result',
      result: { content: [{ type: 'text', text: 'ok' }] },
    });

    await execPromise;
    expect(logger).toHaveBeenCalledWith('error', expect.stringContaining('spawn ENOENT'));
  });

  it('should handle stderr output from worker', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);
    const logger = vi.fn();

    manager = new WorkerManager({ timeout: 5000, logger });

    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        } else if (req.type === 'execute') {
          // Send stderr before result
          proc.stderr.push(Buffer.from('debug info'));
          pushResponse(proc, {
            id: req.id,
            type: 'result',
            result: { content: [{ type: 'text', text: 'ok' }] },
          });
        }
        cb();
      },
    });

    const request = {
      id: 'stderr-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const response = await manager.executeAction(request);
    expect(response.type).toBe('result');
    expect(logger).toHaveBeenCalledWith('info', 'debug info');
  });

  it('should shutdown worker gracefully', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);

    manager = new WorkerManager({ timeout: 5000 });

    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        } else if (req.type === 'shutdown') {
          pushResponse(proc, { id: req.id, type: 'result', result: { content: [] } });
        }
        cb();
      },
    });

    // Start a request to initialize the worker
    const request = {
      id: 'init-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const execPromise = manager.executeAction(request);
    await vi.advanceTimersByTimeAsync(10);
    pushResponse(proc, {
      id: 'init-test',
      type: 'result',
      result: { content: [{ type: 'text', text: 'done' }] },
    });
    await execPromise;

    // Now shutdown
    await manager.shutdown();
    expect(proc.kill).toHaveBeenCalled();
  });

  it('should handle shutdown when no worker exists', async () => {
    manager = new WorkerManager({ timeout: 5000 });
    // Should not throw
    await manager.shutdown();
  });

  it('should handle malformed JSON from worker', async () => {
    const proc = createMockProcess();
    mockFork.mockReturnValue(proc);

    manager = new WorkerManager({ timeout: 5000, logger: vi.fn() });

    proc.stdin = new Writable({
      write(chunk, _enc, cb) {
        const req = JSON.parse(chunk.toString());
        if (req.type === 'ping') {
          pushResponse(proc, { id: req.id, type: 'pong' });
        }
        cb();
      },
    });

    const request = {
      id: 'malformed-test',
      type: 'execute' as const,
      payload: {
        actionUrl: 'test',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    };

    const execPromise = manager.executeAction(request);
    await vi.advanceTimersByTimeAsync(10);

    // Push malformed JSON then valid result
    proc.stdout.push('this is not json\n');
    pushResponse(proc, {
      id: 'malformed-test',
      type: 'result',
      result: { content: [{ type: 'text', text: 'ok' }] },
    });

    const response = await execPromise;
    expect(response.type).toBe('result');
  });
});
