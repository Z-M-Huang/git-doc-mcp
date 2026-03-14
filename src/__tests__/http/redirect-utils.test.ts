/**
 * Unit tests for http/redirect-utils.ts.
 */

import { describe, it, expect } from 'vitest';
import { stripCrossOriginHeaders } from '../../http/redirect-utils.js';

describe('stripCrossOriginHeaders', () => {
  it('should strip Authorization, Cookie, Proxy-Authorization on cross-origin redirect (AC14)', () => {
    const headers = {
      'Authorization': 'Bearer token123',
      'Cookie': 'session=abc',
      'Proxy-Authorization': 'Basic creds',
      'Accept': 'application/json',
      'X-Custom': 'value',
    };
    const result = stripCrossOriginHeaders(
      headers,
      'https://api.example.com/data',
      'https://cdn.other.com/data'
    );
    expect(result).toEqual({
      'Accept': 'application/json',
      'X-Custom': 'value',
    });
    expect(result['Authorization']).toBeUndefined();
    expect(result['Cookie']).toBeUndefined();
    expect(result['Proxy-Authorization']).toBeUndefined();
  });

  it('should preserve all headers on same-origin redirect (AC15)', () => {
    const headers = {
      'Authorization': 'Bearer token123',
      'Cookie': 'session=abc',
      'Accept': 'application/json',
    };
    const result = stripCrossOriginHeaders(
      headers,
      'https://api.example.com/v1/data',
      'https://api.example.com/v2/data'
    );
    expect(result).toEqual(headers);
  });

  it('should handle case-insensitive header keys', () => {
    const headers = {
      'authorization': 'Bearer lower',
      'COOKIE': 'session=upper',
      'proxy-authorization': 'Basic lower',
      'Accept': 'text/html',
    };
    const result = stripCrossOriginHeaders(
      headers,
      'https://a.com/path',
      'https://b.com/path'
    );
    expect(result).toEqual({ 'Accept': 'text/html' });
  });

  it('should treat different ports as cross-origin', () => {
    const headers = { 'Authorization': 'Bearer token' };
    const result = stripCrossOriginHeaders(
      headers,
      'https://api.example.com:443/data',
      'https://api.example.com:8443/data'
    );
    expect(result['Authorization']).toBeUndefined();
  });

  it('should treat different schemes as cross-origin', () => {
    const headers = { 'Authorization': 'Bearer token' };
    const result = stripCrossOriginHeaders(
      headers,
      'https://api.example.com/data',
      'http://api.example.com/data'
    );
    expect(result['Authorization']).toBeUndefined();
  });

  it('should return empty object when all headers are sensitive', () => {
    const headers = {
      'Authorization': 'Bearer token',
      'Cookie': 'session=abc',
    };
    const result = stripCrossOriginHeaders(
      headers,
      'https://a.com/path',
      'https://b.com/path'
    );
    expect(result).toEqual({});
  });

  it('should handle empty headers object', () => {
    const result = stripCrossOriginHeaders(
      {},
      'https://a.com/path',
      'https://b.com/path'
    );
    expect(result).toEqual({});
  });

  it('should normalize Headers instance and strip sensitive headers on cross-origin', () => {
    const headers = new Headers({
      'Authorization': 'Bearer token123',
      'Accept': 'application/json',
    });
    const result = stripCrossOriginHeaders(
      headers,
      'https://a.com/path',
      'https://b.com/path'
    );
    expect(result['accept']).toBe('application/json');
    expect(result['authorization']).toBeUndefined();
  });

  it('should normalize tuple array headers and strip sensitive headers on cross-origin', () => {
    const headers: [string, string][] = [
      ['Authorization', 'Bearer token123'],
      ['Accept', 'application/json'],
      ['Cookie', 'session=abc'],
    ];
    const result = stripCrossOriginHeaders(
      headers,
      'https://a.com/path',
      'https://b.com/path'
    );
    expect(result['Accept']).toBe('application/json');
    expect(result['Authorization']).toBeUndefined();
    expect(result['Cookie']).toBeUndefined();
  });
});
