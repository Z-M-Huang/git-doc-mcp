/**
 * Unit tests for worker/worker-entry.ts (handleRequest and WorkerAuditProxy).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock executeAction since it depends on isolated-vm
vi.mock('../../sandbox/executor.js', () => ({
  executeAction: vi.fn(),
}));

import { handleRequest, WorkerAuditProxy } from '../../worker/worker-entry.js';
import { executeAction } from '../../sandbox/executor.js';

const mockedExecuteAction = vi.mocked(executeAction);

beforeEach(() => {
  mockedExecuteAction.mockReset();
});

describe('handleRequest', () => {
  it('should respond to ping with pong', async () => {
    const response = await handleRequest({ id: 'ping-1', type: 'ping' });
    expect(response.type).toBe('pong');
    expect(response.id).toBe('ping-1');
  });

  it('should respond to shutdown with success', async () => {
    // Mock process.exit to prevent test from ending
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const response = await handleRequest({ id: 'shut-1', type: 'shutdown' });
    expect(response.type).toBe('result');
    expect(response.id).toBe('shut-1');
    exitSpy.mockRestore();
  });

  it('should return VALIDATION error when payload is missing', async () => {
    const response = await handleRequest({ id: 'exec-1', type: 'execute' });
    expect(response.type).toBe('error');
    expect(response.error?.code).toBe('VALIDATION');
  });

  it('should execute action and return result', async () => {
    const expectedResult = { content: [{ type: 'text' as const, text: 'hello' }] };
    mockedExecuteAction.mockResolvedValue(expectedResult);

    const response = await handleRequest({
      id: 'exec-2',
      type: 'execute',
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'export default async function(i) { return { content: [] }; }',
        input: { text: 'test' },
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    });

    expect(response.type).toBe('result');
    expect(response.result).toEqual(expectedResult);
  });

  it('should return EXECUTION error when action throws', async () => {
    mockedExecuteAction.mockRejectedValue(new Error('sandbox crash'));

    const response = await handleRequest({
      id: 'exec-3',
      type: 'execute',
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'bad code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    });

    expect(response.type).toBe('error');
    expect(response.error?.code).toBe('EXECUTION');
    expect(response.error?.message).toContain('sandbox crash');
  });

  it('should return UNKNOWN error for unknown request type', async () => {
    const response = await handleRequest({ id: 'unk-1', type: 'unknown' as any });
    expect(response.type).toBe('error');
    expect(response.error?.code).toBe('UNKNOWN');
  });
});

describe('WorkerAuditProxy', () => {
  let proxy: WorkerAuditProxy;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    proxy = new WorkerAuditProxy();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should send fetch audit event via console.log', () => {
    proxy.logFetch('https://example.com', 200, 100, 'test-manifest');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.type).toBe('audit');
    expect(parsed.event.event).toBe('fetch');
    expect(parsed.event.url).toBe('https://example.com');
  });

  it('should send error audit event via console.log', () => {
    proxy.logError('test error', { detail: 'value' });
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.type).toBe('audit');
    expect(parsed.event.event).toBe('error');
    expect(parsed.event.details.message).toBe('test error');
    expect(parsed.event.details.detail).toBe('value');
  });

  it('should send secret-access audit event', () => {
    proxy.logSecretAccess('TOKEN', 'https://api.github.com/repos', true, 'test');
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.event.event).toBe('secret-access');
    expect(parsed.event.secretName).toBe('TOKEN');
    expect(parsed.event.status).toBe('allowed');
  });

  it('should send redirect audit event', () => {
    proxy.logRedirect('https://a.com/', 'https://b.com/', 'test');
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.event.event).toBe('redirect');
    expect(parsed.event.url).toBe('https://b.com/');
  });

  it('close should not throw', async () => {
    await expect(proxy.close()).resolves.toBeUndefined();
  });

  it('should send action-start audit event', () => {
    proxy.logActionStart('echo', 'test-manifest');
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.event.event).toBe('action-start');
    expect(parsed.event.actionName).toBe('echo');
    expect(parsed.event.manifestName).toBe('test-manifest');
  });

  it('should send action-end audit event', () => {
    proxy.logActionEnd('echo', 'success', 150, 'test-manifest');
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.event.event).toBe('action-end');
    expect(parsed.event.actionName).toBe('echo');
    expect(parsed.event.status).toBe('success');
    expect(parsed.event.duration_ms).toBe(150);
  });
});

describe('handleRequest with auditLogger', () => {
  it('should log execution errors to auditLogger', async () => {
    const auditLogger = { logError: vi.fn(), log: vi.fn(), logFetch: vi.fn(), logRedirect: vi.fn(), logSecretAccess: vi.fn(), logActionStart: vi.fn(), logActionEnd: vi.fn(), close: vi.fn() };
    mockedExecuteAction.mockRejectedValue(new Error('sandbox crash'));

    const response = await handleRequest({
      id: 'audit-err',
      type: 'execute',
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'bad code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    }, auditLogger);

    expect(response.type).toBe('error');
    expect(auditLogger.logError).toHaveBeenCalledWith('Worker execution failed', expect.objectContaining({ error: 'sandbox crash' }));
  });

  it('should pass auditLogger to executeAction', async () => {
    const auditLogger = { logError: vi.fn(), log: vi.fn(), logFetch: vi.fn(), logRedirect: vi.fn(), logSecretAccess: vi.fn(), logActionStart: vi.fn(), logActionEnd: vi.fn(), close: vi.fn() };
    mockedExecuteAction.mockResolvedValue({ content: [{ type: 'text' as const, text: 'ok' }] });

    await handleRequest({
      id: 'audit-pass',
      type: 'execute',
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    }, auditLogger);

    // Verify auditLogger was passed in contextOptions
    expect(mockedExecuteAction).toHaveBeenCalledWith(
      'code',
      {},
      expect.objectContaining({ auditLogger }),
      expect.any(Object)
    );
  });

  it('should pass payload.memoryLimit to executeAction sandbox options (AC21)', async () => {
    mockedExecuteAction.mockResolvedValue({ content: [{ type: 'text' as const, text: 'ok' }] });

    await handleRequest({
      id: 'mem-1',
      type: 'execute',
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
        memoryLimit: 256 * 1024 * 1024,
      },
    });

    expect(mockedExecuteAction).toHaveBeenCalledWith(
      'code',
      {},
      expect.any(Object),
      expect.objectContaining({ memoryLimit: 256 * 1024 * 1024 })
    );
  });

  it('should default memoryLimit to 128MB when not in payload (AC22)', async () => {
    mockedExecuteAction.mockResolvedValue({ content: [{ type: 'text' as const, text: 'ok' }] });

    await handleRequest({
      id: 'mem-2',
      type: 'execute',
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'code',
        input: {},
        secrets: {},
        timeout: 5000,
        manifest: { name: 'test', version: '1.0.0' },
        secretScopes: {},
      },
    });

    expect(mockedExecuteAction).toHaveBeenCalledWith(
      'code',
      {},
      expect.any(Object),
      expect.objectContaining({ memoryLimit: 128 * 1024 * 1024 })
    );
  });

  it('should use default timeout and empty secrets when not provided', async () => {
    mockedExecuteAction.mockResolvedValue({ content: [{ type: 'text' as const, text: 'ok' }] });

    await handleRequest({
      id: 'defaults',
      type: 'execute',
      payload: {
        actionUrl: 'https://example.com/action.js',
        actionCode: 'code',
        input: { data: 1 },
        manifest: { name: 'test', version: '1.0.0' },
      },
    });

    expect(mockedExecuteAction).toHaveBeenCalledWith(
      'code',
      { data: 1 },
      expect.objectContaining({ secrets: {}, secretScopes: {}, timeout: 60000 }),
      expect.objectContaining({ wallTimeLimit: 60000 })
    );
  });
});
