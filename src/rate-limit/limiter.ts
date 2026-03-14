/**
 * Sliding-window rate limiter.
 * @module rate-limit/limiter
 */

/**
 * A simple sliding-window rate limiter.
 *
 * Tracks call timestamps in an array and prunes entries
 * outside the sliding window on each acquire attempt.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter(60, 60_000); // 60 calls per minute
 * if (!limiter.tryAcquire()) {
 *   // Rate limited
 * }
 * ```
 */
export class RateLimiter {
  private timestamps: number[] = [];

  /**
   * @param maxCalls - Maximum number of calls allowed in the window
   * @param windowMs - Window size in milliseconds
   */
  constructor(
    private readonly maxCalls: number = 60,
    private readonly windowMs: number = 60_000
  ) {}

  /**
   * Try to acquire a rate limit slot.
   * @returns true if the call is allowed, false if rate limited
   */
  tryAcquire(): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Prune expired timestamps
    this.timestamps = this.timestamps.filter(t => t > windowStart);

    if (this.timestamps.length >= this.maxCalls) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  /**
   * Get the current number of calls in the window.
   */
  get currentCount(): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    return this.timestamps.filter(t => t > windowStart).length;
  }
}
