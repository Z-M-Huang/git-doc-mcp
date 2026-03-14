/**
 * Unit tests for audit/logger.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

// Mock fs
const mockAppendFile = vi.fn();
const mockMkdir = vi.fn();
const mockStat = vi.fn();
const mockRename = vi.fn();
vi.mock('node:fs/promises', () => ({
  appendFile: (...args: unknown[]) => mockAppendFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  rename: (...args: unknown[]) => mockRename(...args),
}));

import { FileAuditLogger, NoopAuditLogger, createAuditLogger } from '../../audit/logger.js';

beforeEach(() => {
  mockAppendFile.mockReset().mockResolvedValue(undefined);
  mockMkdir.mockReset().mockResolvedValue(undefined);
  mockStat.mockReset().mockRejectedValue(new Error('ENOENT')); // File doesn't exist by default
  mockRename.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
});

describe('FileAuditLogger', () => {
  it('should buffer events and flush on timer', async () => {
    const logger = new FileAuditLogger('/tmp/test-audit');
    logger.logFetch('https://example.com', 200, 50, 'test');

    // Should not have written yet (buffered)
    expect(mockAppendFile).not.toHaveBeenCalled();

    // Advance past flush interval
    await vi.advanceTimersByTimeAsync(150);

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/test-audit', { recursive: true });
    expect(mockAppendFile).toHaveBeenCalledTimes(1);

    // Verify the written data is valid JSON-lines
    const writtenData = mockAppendFile.mock.calls[0][1] as string;
    const lines = writtenData.trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe('fetch');
      expect(parsed.url).toBe('https://example.com');
    }

    await logger.close();
  });

  it('should flush immediately when buffer exceeds 50 entries', async () => {
    const logger = new FileAuditLogger('/tmp/test-audit');

    // Add 50 entries to trigger immediate flush
    for (let i = 0; i < 50; i++) {
      logger.logFetch(`https://example.com/${i}`);
    }

    // Give the async flush a tick to complete
    await vi.advanceTimersByTimeAsync(10);

    expect(mockAppendFile).toHaveBeenCalled();
    await logger.close();
  });

  it('should rotate when file exceeds 10MB (AC15)', async () => {
    mockStat.mockResolvedValue({ size: 11 * 1024 * 1024 }); // > 10MB

    const logger = new FileAuditLogger('/tmp/test-audit');
    logger.logFetch('https://example.com');

    await vi.advanceTimersByTimeAsync(150);

    expect(mockRename).toHaveBeenCalled();
    const renameCall = mockRename.mock.calls[0];
    expect(renameCall[0]).toContain('audit.jsonl');
    expect(renameCall[1]).toContain('audit-');

    await logger.close();
  });

  it('should write all event types correctly', async () => {
    const logger = new FileAuditLogger('/tmp/test-audit');

    logger.logFetch('https://api.com', 200, 100, 'manifest1');
    logger.logRedirect('https://a.com', 'https://b.com', 'manifest1');
    logger.logSecretAccess('TOKEN', 'https://api.com', true, 'manifest1');
    logger.logActionStart('echo', 'manifest1');
    logger.logActionEnd('echo', 'success', 150, 'manifest1');
    logger.logError('bad thing happened', { url: 'https://evil.com' }, 'manifest1');

    await vi.advanceTimersByTimeAsync(150);

    const writtenData = mockAppendFile.mock.calls[0][1] as string;
    const events = writtenData.trim().split('\n').map(l => JSON.parse(l));
    expect(events).toHaveLength(6);
    expect(events.map(e => e.event)).toEqual([
      'fetch', 'redirect', 'secret-access', 'action-start', 'action-end', 'error'
    ]);

    await logger.close();
  });

  it('should not crash if write fails', async () => {
    mockAppendFile.mockRejectedValue(new Error('disk full'));
    const logger = new FileAuditLogger('/tmp/test-audit');
    logger.logFetch('https://example.com');

    // Should not throw
    await vi.advanceTimersByTimeAsync(150);
    await logger.close();
  });

  it('should flush remaining buffer on close', async () => {
    const logger = new FileAuditLogger('/tmp/test-audit');
    logger.logFetch('https://example.com');

    await logger.close();

    expect(mockAppendFile).toHaveBeenCalled();
  });
});

describe('NoopAuditLogger', () => {
  it('should not throw on any method call', async () => {
    const logger = new NoopAuditLogger();
    logger.logFetch('https://example.com');
    logger.logRedirect('a', 'b');
    logger.logSecretAccess('s', 'u', true);
    logger.logActionStart('a');
    logger.logActionEnd('a', 's', 100);
    logger.logError('msg');
    await logger.close();
  });
});

describe('createAuditLogger', () => {
  it('should return a FileAuditLogger', () => {
    const logger = createAuditLogger('/tmp/test');
    expect(logger).toBeInstanceOf(FileAuditLogger);
    // Clean up
    logger.close();
  });
});
