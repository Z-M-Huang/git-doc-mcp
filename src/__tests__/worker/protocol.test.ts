/**
 * Unit tests for worker IPC protocol.
 */

import { describe, it, expect } from 'vitest';
import {
  createErrorResponse,
  createSuccessResponse,
  createPongResponse,
  parseWorkerRequest,
  serializeWorkerResponse,
} from '../../worker/protocol.js';

describe('createErrorResponse', () => {
  it('should create error response with correct structure', () => {
    const response = createErrorResponse('test-id', 'EXECUTION', 'Something went wrong');
    expect(response).toEqual({
      id: 'test-id',
      type: 'error',
      error: { code: 'EXECUTION', message: 'Something went wrong' },
    });
  });

  it('should set all error codes correctly', () => {
    const codes = ['TIMEOUT', 'MEMORY', 'VALIDATION', 'EXECUTION', 'UNKNOWN'] as const;
    for (const code of codes) {
      const response = createErrorResponse('id', code, 'msg');
      expect(response.error?.code).toBe(code);
    }
  });
});

describe('createSuccessResponse', () => {
  it('should create success response with result', () => {
    const result = { content: [{ type: 'text' as const, text: 'Hello' }] };
    const response = createSuccessResponse('test-id', result);
    expect(response).toEqual({
      id: 'test-id',
      type: 'result',
      result,
    });
  });

  it('should preserve isError in result', () => {
    const result = { content: [{ type: 'text' as const, text: 'Error' }], isError: true };
    const response = createSuccessResponse('id', result);
    expect(response.result?.isError).toBe(true);
  });
});

describe('createPongResponse', () => {
  it('should create pong response', () => {
    const response = createPongResponse('ping-id');
    expect(response).toEqual({
      id: 'ping-id',
      type: 'pong',
    });
  });
});

describe('parseWorkerRequest', () => {
  it('should parse valid execute request', () => {
    const json = JSON.stringify({ id: 'req-1', type: 'execute', payload: { actionCode: 'code' } });
    const request = parseWorkerRequest(json);
    expect(request).not.toBeNull();
    expect(request?.id).toBe('req-1');
    expect(request?.type).toBe('execute');
  });

  it('should parse valid ping request', () => {
    const json = JSON.stringify({ id: 'ping-1', type: 'ping' });
    const request = parseWorkerRequest(json);
    expect(request?.type).toBe('ping');
  });

  it('should return null for invalid JSON', () => {
    expect(parseWorkerRequest('not json{')).toBeNull();
  });

  it('should return null for missing id', () => {
    expect(parseWorkerRequest('{"type":"ping"}')).toBeNull();
  });

  it('should return null for missing type', () => {
    expect(parseWorkerRequest('{"id":"test"}')).toBeNull();
  });

  it('should return null for non-string id', () => {
    expect(parseWorkerRequest('{"id":123,"type":"ping"}')).toBeNull();
  });
});

describe('serializeWorkerResponse', () => {
  it('should serialize to valid JSON', () => {
    const response = createPongResponse('id-1');
    const json = serializeWorkerResponse(response);
    expect(JSON.parse(json)).toEqual(response);
  });
});

describe('roundtrip', () => {
  it('should serialize and parse responses consistently', () => {
    const original = createSuccessResponse('roundtrip-id', {
      content: [{ type: 'text', text: 'test result' }],
    });
    const json = serializeWorkerResponse(original);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe(original.id);
    expect(parsed.type).toBe(original.type);
    expect(parsed.result).toEqual(original.result);
  });
});
