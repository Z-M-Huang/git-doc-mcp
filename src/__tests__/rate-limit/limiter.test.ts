/**
 * Unit tests for rate-limit/limiter.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../../rate-limit/limiter.js';

describe('RateLimiter', () => {
  it('should allow calls within budget (AC18)', () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire()).toBe(true);
    }
  });

  it('should reject calls exceeding budget (AC17)', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should allow calls after window expires (AC19)', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 1000); // 2 calls per second

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(1001);

    // Should allow again
    expect(limiter.tryAcquire()).toBe(true);
    vi.useRealTimers();
  });

  it('should use default values (60 calls, 60s window)', () => {
    const limiter = new RateLimiter();
    // Should allow 60 calls
    for (let i = 0; i < 60; i++) {
      expect(limiter.tryAcquire()).toBe(true);
    }
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should track current count correctly', () => {
    const limiter = new RateLimiter(10, 60_000);
    expect(limiter.currentCount).toBe(0);
    limiter.tryAcquire();
    expect(limiter.currentCount).toBe(1);
    limiter.tryAcquire();
    expect(limiter.currentCount).toBe(2);
  });

  it('should handle sliding window correctly', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 1000);

    limiter.tryAcquire(); // t=0
    vi.advanceTimersByTime(600);
    limiter.tryAcquire(); // t=600
    expect(limiter.tryAcquire()).toBe(false); // full

    vi.advanceTimersByTime(401); // t=1001 -- first call expired
    expect(limiter.tryAcquire()).toBe(true); // slot freed

    vi.useRealTimers();
  });
});
