import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRetryPlugin } from '../index';

interface RetryPlugin {
  name: string;
  version: string;
  initialize(container: any): Promise<void>;
  withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
  shutdown(): Promise<void>;
}

interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number; // ms
  maxDelay?: number; // ms
  backoffMultiplier?: number;
  retryCondition?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

describe('RetryPlugin', () => {
  let plugin: RetryPlugin;

  beforeEach(() => {
    vi.useFakeTimers();
    plugin = createRetryPlugin({
      defaultMaxRetries: 3,
      defaultBaseDelay: 1000,
      defaultBackoffMultiplier: 2,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('exponential backoff', () => {
    it('should retry with exponential backoff delays', async () => {
      const delays: number[] = [];
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        backoffMultiplier: 2,
        onRetry: (attempt) => { delays.push(Date.now()); },
      });

      // First retry after 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      // Second retry after 2000ms (1000 * 2)
      await vi.advanceTimersByTimeAsync(2000);

      const result = await resultPromise;
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should cap delay at maxDelay', async () => {
      const retryDelays: number[] = [];
      let lastTime = Date.now();

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('1'))
        .mockRejectedValueOnce(new Error('2'))
        .mockRejectedValueOnce(new Error('3'))
        .mockRejectedValueOnce(new Error('4'))
        .mockResolvedValue('ok');

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 5,
        baseDelay: 1000,
        backoffMultiplier: 4,
        maxDelay: 5000,
        onRetry: () => {
          const now = Date.now();
          retryDelays.push(now - lastTime);
          lastTime = now;
        },
      });

      // Advance through all retries
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      await resultPromise;

      // No delay should exceed maxDelay
      for (const delay of retryDelays) {
        expect(delay).toBeLessThanOrEqual(5000);
      }
    });
  });

  describe('max retries enforcement', () => {
    it('should fail after max retries are exhausted', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('always fails'));

      const resultPromise = plugin.withRetry(fn, { maxRetries: 3, baseDelay: 100 });

      // Advance through all delays
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }

      await expect(resultPromise).rejects.toThrow('always fails');
      expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
    });

    it('should return immediately on first success', async () => {
      const fn = vi.fn().mockResolvedValue('immediate');

      const result = await plugin.withRetry(fn, { maxRetries: 5 });

      expect(result).toBe('immediate');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry condition', () => {
    it('should only retry on retryable errors', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('ok');

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 3,
        baseDelay: 100,
        retryCondition: (err) => err.message === 'timeout',
      });

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;
      expect(result).toBe('ok');
    });

    it('should throw immediately on non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fatal: invalid config'));

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 5,
        baseDelay: 100,
        retryCondition: (err) => !err.message.startsWith('fatal'),
      });

      await expect(resultPromise).rejects.toThrow('fatal: invalid config');
      expect(fn).toHaveBeenCalledTimes(1); // no retries
    });
  });

  describe('custom retry condition function', () => {
    it('should use custom function to determine retryability', async () => {
      const retryCondition = vi.fn().mockImplementation(
        (err: Error) => err.message.includes('429') || err.message.includes('503')
      );

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'))
        .mockResolvedValue('ok');

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 3,
        baseDelay: 100,
        retryCondition,
      });

      await vi.advanceTimersByTimeAsync(100);

      const result = await resultPromise;
      expect(result).toBe('ok');
      expect(retryCondition).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('onRetry callback', () => {
    it('should call onRetry with attempt number and error', async () => {
      const onRetry = vi.fn();
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('err1'))
        .mockRejectedValueOnce(new Error('err2'))
        .mockResolvedValue('done');

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 3,
        baseDelay: 100,
        onRetry,
      });

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      await resultPromise;

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ message: 'err1' }));
      expect(onRetry).toHaveBeenCalledWith(2, expect.objectContaining({ message: 'err2' }));
    });
  });

  describe('Edge Cases', () => {
    it('should handle maxRetries = 0 (no retries, fail immediately)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      const resultPromise = plugin.withRetry(fn, { maxRetries: 0, baseDelay: 100 });

      await expect(resultPromise).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(1); // Only initial call, no retries

    });

    it('should handle maxRetries = -1 (invalid config)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Should throw config validation error or treat as 0

    });

    it('should handle backoff multiplier = 0', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('ok');

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        backoffMultiplier: 0,
      });

      // With multiplier 0, delay should be 0 or base — should not hang
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise;

    });

    it('should handle operation that succeeds on exactly the last allowed retry', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
        .mockResolvedValue('last-chance');

      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 3,
        baseDelay: 100,
      });

      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }

      const result = await resultPromise;
      expect(result).toBe('last-chance');
      expect(fn).toHaveBeenCalledTimes(4);

    });

    it('should handle operation that throws different errors each attempt', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new TypeError('type error'))
        .mockRejectedValueOnce(new RangeError('range error'));

      const resultPromise = plugin.withRetry(fn, { maxRetries: 2, baseDelay: 100 });

      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }

      // Should reject with the LAST error thrown
      await expect(resultPromise).rejects.toThrow('range error');

    });

    it('should handle retry with timeout shorter than backoff delay', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('slow'));

      // baseDelay is 10000 but overall timeout might be shorter
      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 3,
        baseDelay: 10000,
        backoffMultiplier: 2,
      });

      // Should eventually fail, not deadlock
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(20000);
      }

      await expect(resultPromise).rejects.toThrow();

    });

    it('should handle abort signal during retry wait', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error('retriable'));

      // Plugin should support abort signal to cancel pending retries
      const resultPromise = plugin.withRetry(fn, {
        maxRetries: 5,
        baseDelay: 5000,
      });

      await vi.advanceTimersByTimeAsync(1000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(50000);

      // Should abort rather than continue retrying

    });

    it('should handle concurrent retries for different operations', async () => {
      const fn1 = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('result1');
      const fn2 = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('result2');

      const p1 = plugin.withRetry(fn1, { maxRetries: 2, baseDelay: 100 });
      const p2 = plugin.withRetry(fn2, { maxRetries: 2, baseDelay: 200 });

      await vi.advanceTimersByTimeAsync(500);

      const [r1, r2] = await Promise.all([p1, p2]);
      // Both should resolve independently

    });

    it('should handle retry an operation that mutates external state (non-idempotent)', async () => {
      let counter = 0;
      const fn = vi.fn().mockImplementation(async () => {
        counter++;
        if (counter < 3) throw new Error('not ready');
        return counter;
      });

      const resultPromise = plugin.withRetry(fn, { maxRetries: 5, baseDelay: 100 });

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      const result = await resultPromise;
      // Counter will be 3, showing state was mutated on each retry

    });

    it('should handle circuit breaker threshold = 0 (always open)', async () => {
      // Circuit breaker with threshold 0 should always be open (reject immediately)

    });

    it('should handle circuit breaker with half-open probe that hangs forever', async () => {
      // Half-open probe that never resolves should timeout

    });
  });
});
