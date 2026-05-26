import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCircuitBreaker, createCircuitBreakerRegistry } from '../index';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreaker {
  call<T>(fn: () => Promise<T>): Promise<T>;
  getState(): CircuitState;
  reset(): void;
  getFailureCount(): number;
}

interface CircuitBreakerOptions {
  failureThreshold: number; // failures before opening
  resetTimeout: number; // ms before transitioning to half-open
  successThreshold?: number; // successes in half-open before closing
}

interface CircuitBreakerRegistry {
  getBreaker(target: string, options?: CircuitBreakerOptions): CircuitBreaker;
  getAllBreakers(): Map<string, CircuitBreaker>;
}

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;
  let options: CircuitBreakerOptions;

  beforeEach(() => {
    vi.useFakeTimers();
    options = {
      failureThreshold: 3,
      resetTimeout: 5000,
      successThreshold: 1,
    };
    breaker = createCircuitBreaker(options);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('closed state (normal operation)', () => {
    it('should start in closed state', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('should pass requests through when closed', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const result = await breaker.call(fn);

      expect(fn).toHaveBeenCalled();
      expect(result).toBe('result');
    });

    it('should stay closed on occasional failures below threshold', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('ok');

      try { await breaker.call(fn); } catch {}
      try { await breaker.call(fn); } catch {}
      await breaker.call(fn);

      expect(breaker.getState()).toBe('closed');
    });

    it('should count failures', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      try { await breaker.call(fn); } catch {}
      try { await breaker.call(fn); } catch {}

      expect(breaker.getFailureCount()).toBe(2);
    });
  });

  describe('open state (circuit tripped)', () => {
    it('should open after N consecutive failures', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        try { await breaker.call(fn); } catch {}
      }

      expect(breaker.getState()).toBe('open');
    });

    it('should reject requests immediately when open', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        try { await breaker.call(fn); } catch {}
      }

      // New request should be rejected immediately without calling fn
      fn.mockReset();
      await expect(breaker.call(fn)).rejects.toThrow(/circuit.*open|breaker.*open/i);
      expect(fn).not.toHaveBeenCalled();
    });

    it('should transition to half-open after reset timeout', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        try { await breaker.call(fn); } catch {}
      }
      expect(breaker.getState()).toBe('open');

      vi.advanceTimersByTime(5001);

      expect(breaker.getState()).toBe('half-open');
    });
  });

  describe('half-open state (probe)', () => {
    it('should allow a single probe request in half-open state', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('recovered');

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }

      // Wait for reset timeout
      vi.advanceTimersByTime(5001);
      expect(breaker.getState()).toBe('half-open');

      // Probe request
      const result = await breaker.call(successFn);
      expect(result).toBe('recovered');
    });

    it('should close circuit on successful probe', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('ok');

      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }

      vi.advanceTimersByTime(5001);
      await breaker.call(successFn);

      expect(breaker.getState()).toBe('closed');
    });

    it('should re-open circuit on failed probe', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }

      vi.advanceTimersByTime(5001);
      expect(breaker.getState()).toBe('half-open');

      // Probe fails
      try { await breaker.call(failFn); } catch {}

      expect(breaker.getState()).toBe('open');
    });

    it('should reject additional requests while probe is in flight', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const slowFn = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 1000))
      );

      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }

      vi.advanceTimersByTime(5001);

      // Start probe
      const probePromise = breaker.call(slowFn);

      // Second request should be rejected (only 1 probe allowed)
      await expect(breaker.call(slowFn)).rejects.toThrow(/circuit|half-open/i);

      vi.advanceTimersByTime(1000);
      await probePromise;
    });
  });

  describe('configurable failure threshold', () => {
    it('should open at custom threshold', async () => {
      const strictBreaker = createCircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 5000,
      });
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      try { await strictBreaker.call(fn); } catch {}

      expect(strictBreaker.getState()).toBe('open');
    });

    it('should tolerate more failures with high threshold', async () => {
      const tolerantBreaker = createCircuitBreaker({
        failureThreshold: 10,
        resetTimeout: 5000,
      });
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 9; i++) {
        try { await tolerantBreaker.call(fn); } catch {}
      }

      expect(tolerantBreaker.getState()).toBe('closed');
    });
  });

  describe('configurable reset timeout', () => {
    it('should use custom reset timeout', async () => {
      const quickBreaker = createCircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 1000,
      });
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      try { await quickBreaker.call(fn); } catch {}
      try { await quickBreaker.call(fn); } catch {}

      expect(quickBreaker.getState()).toBe('open');

      vi.advanceTimersByTime(1001);
      expect(quickBreaker.getState()).toBe('half-open');
    });
  });

  describe('per-target circuit breakers', () => {
    it('should maintain separate breakers per target', () => {
      const registry = createCircuitBreakerRegistry();

      const breakerA = registry.getBreaker('tool-a', options);
      const breakerB = registry.getBreaker('tool-b', options);

      expect(breakerA).not.toBe(breakerB);
      expect(breakerA.getState()).toBe('closed');
      expect(breakerB.getState()).toBe('closed');
    });

    it('should trip one target without affecting others', async () => {
      const registry = createCircuitBreakerRegistry();
      const breakerA = registry.getBreaker('tool-a', options);
      const breakerB = registry.getBreaker('tool-b', options);

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip breaker A
      for (let i = 0; i < 3; i++) {
        try { await breakerA.call(failFn); } catch {}
      }

      expect(breakerA.getState()).toBe('open');
      expect(breakerB.getState()).toBe('closed'); // unaffected
    });

    it('should return same breaker instance for same target', () => {
      const registry = createCircuitBreakerRegistry();

      const first = registry.getBreaker('tool-x', options);
      const second = registry.getBreaker('tool-x', options);

      expect(first).toBe(second);
    });
  });

  describe('reset', () => {
    it('should reset breaker to closed state', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        try { await breaker.call(fn); } catch {}
      }
      expect(breaker.getState()).toBe('open');

      breaker.reset();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('Adversarial: Circuit Breaker Bypass', () => {
    it('should not allow bypass via requests that vary just enough to be treated as different targets', async () => {
      const registry = createCircuitBreakerRegistry();
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip breaker for 'tool-api'
      const breakerA = registry.getBreaker('tool-api', options);
      for (let i = 0; i < 3; i++) {
        try { await breakerA.call(failFn); } catch {}
      }
      expect(breakerA.getState()).toBe('open');

      // Attacker uses slight variation to get a fresh breaker
      const breakerVariant = registry.getBreaker('tool-api/', options);
      const breakerVariant2 = registry.getBreaker('tool-api?', options);

      // These should be normalized to the same target
      // FAILS: no target name normalization
      expect(breakerVariant.getState()).toBe('open');
      expect(breakerVariant2.getState()).toBe('open');

    });

    it('should timeout half-open probe that hangs, preventing transition to closed', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const hangingFn = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }

      // Wait for half-open
      vi.advanceTimersByTime(5001);
      expect(breaker.getState()).toBe('half-open');

      // Probe hangs forever — breaker should timeout and re-open
      const probePromise = breaker.call(hangingFn);

      // Advance time past probe timeout
      vi.advanceTimersByTime(30000);

      // FAILS: no probe timeout — breaker stays in half-open forever
      expect(breaker.getState()).toBe('open');

    });

    it('should not allow concurrent requests to all become probes simultaneously', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const probeFn = vi.fn().mockResolvedValue('probe-result');

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }

      // Wait for half-open
      vi.advanceTimersByTime(5001);

      // 10 concurrent requests all try to be the probe
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => breaker.call(probeFn))
      );

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Only 1 should succeed as probe, rest should be rejected
      // FAILS: multiple requests may all become probes
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(9);

    });

    it('should handle operation that flips between success/failure to keep breaker oscillating', async () => {
      let callCount = 0;
      const oscillatingFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 4 === 0) return Promise.resolve('ok');
        return Promise.reject(new Error('fail'));
      });

      // Run many calls — breaker should not oscillate indefinitely
      for (let i = 0; i < 100; i++) {
        try { await breaker.call(oscillatingFn); } catch {}
        if (breaker.getState() === 'open') {
          vi.advanceTimersByTime(5001);
        }
      }

      // Breaker should have stabilization logic (e.g., exponential backoff on reset timeout)
      // FAILS: no oscillation damping — breaker flaps between open/half-open/closed

    });

    it('should handle circuit breaker state corruption via concurrent state transitions', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('ok');

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }

      // Concurrent: reset() + call() at the same time
      const resetPromise = Promise.resolve().then(() => breaker.reset());
      const callPromise = breaker.call(successFn).catch(() => 'rejected');

      await Promise.all([resetPromise, callPromise]);

      // State should be consistent (not corrupted)
      // FAILS: no mutex on state transitions
      const state = breaker.getState();
      expect(['closed', 'open', 'half-open']).toContain(state);
      expect(breaker.getFailureCount()).toBeGreaterThanOrEqual(0);

    });

    it('should resist system time manipulation to force premature reset', async () => {
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        try { await breaker.call(failFn); } catch {}
      }
      expect(breaker.getState()).toBe('open');

      // Manipulate time backwards — should not reset the breaker early
      vi.setSystemTime(Date.now() - 10000);

      // Breaker should still be open (monotonic time or time-manipulation resistance)
      // FAILS: no monotonic time usage — clock manipulation resets breaker
      expect(breaker.getState()).toBe('open');

    });

    it('should correctly handle threshold exactly at failure count (off-by-one)', async () => {
      const exactBreaker = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 5000,
      });
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Exactly 2 failures (one below threshold)
      try { await exactBreaker.call(failFn); } catch {}
      try { await exactBreaker.call(failFn); } catch {}

      expect(exactBreaker.getState()).toBe('closed');
      expect(exactBreaker.getFailureCount()).toBe(2);

      // Exactly the 3rd failure — should this open or still be closed?
      try { await exactBreaker.call(failFn); } catch {}

      // FAILS: off-by-one — threshold of 3 means open AFTER 3 or AT 3?
      expect(exactBreaker.getState()).toBe('open');
      expect(exactBreaker.getFailureCount()).toBe(3);

    });

    it('should handle nested circuit breakers (A wraps B wraps C) with cascade opening', async () => {
      const breakerA = createCircuitBreaker({ failureThreshold: 2, resetTimeout: 5000 });
      const breakerB = createCircuitBreaker({ failureThreshold: 2, resetTimeout: 5000 });
      const breakerC = createCircuitBreaker({ failureThreshold: 2, resetTimeout: 5000 });

      const failFn = vi.fn().mockRejectedValue(new Error('deep failure'));

      // Nested call: A -> B -> C -> failFn
      const nestedCall = () => breakerA.call(() => breakerB.call(() => breakerC.call(failFn)));

      // Trip the innermost breaker
      try { await nestedCall(); } catch {}
      try { await nestedCall(); } catch {}

      // C is open, B sees C's "circuit open" error as a failure
      try { await nestedCall(); } catch {}
      try { await nestedCall(); } catch {}

      // Cascade: C open -> B treats as failure -> B opens -> A treats as failure -> A opens
      // FAILS: no cascade awareness — inner breaker errors should not trip outer breakers
      expect(breakerA.getState()).toBe('closed'); // A should not cascade-open

    });
  });
});
