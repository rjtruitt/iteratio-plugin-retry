/** Base plugin contract shared across all iteratio plugins. */
import type { Container } from 'inversify';

/** Context passed to lifecycle hooks. */
export interface TurnContext {
  turnNumber: number;
  messages: Array<{ role: string; content: string }>;
  state: Record<string, unknown>;
}

export interface IPlugin {
  name: string;
  version: string;
  initialize(container: Container): Promise<void>;
  shutdown(): Promise<void>;
}

/** Default backoff and retry parameters for the plugin. */
export interface RetryConfig {
  defaultMaxRetries?: number;
  defaultBaseDelay?: number;
  defaultMaxDelay?: number;
  defaultBackoffMultiplier?: number;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  strategy?: 'exponential' | 'linear' | 'fixed';
}

/** Per-call overrides for retry behavior. */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  retryCondition?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
  shouldRetry?: (error: Error) => boolean;
  strategy?: string;
}

/**
 * Wraps async operations with configurable retry logic and exponential backoff.
 * Prevents transient failures from cascading through agent workflows.
 */
export class RetryPlugin implements IPlugin {
  readonly name = 'retry';
  readonly version = '0.1.0';

  private defaultMaxRetries: number;
  private defaultBaseDelay: number;
  private defaultMaxDelay: number;
  private defaultBackoffMultiplier: number;

  /** Create a RetryPlugin with optional default retry configuration. */
  constructor(config?: RetryConfig) {
    this.defaultMaxRetries = config?.defaultMaxRetries ?? config?.maxRetries ?? 3;
    this.defaultBaseDelay = config?.defaultBaseDelay ?? config?.baseDelay ?? 1000;
    this.defaultMaxDelay = config?.defaultMaxDelay ?? config?.maxDelay ?? 30000;
    this.defaultBackoffMultiplier = config?.defaultBackoffMultiplier ?? 2;
  }

  /** Initialize the plugin with a dependency injection container. */
  async initialize(container: Container): Promise<void> {}

  /** Update default retry parameters at runtime. */
  configure(config: RetryConfig): void {
    if (config.defaultMaxRetries !== undefined) this.defaultMaxRetries = config.defaultMaxRetries;
    if (config.defaultBaseDelay !== undefined) this.defaultBaseDelay = config.defaultBaseDelay;
    if (config.defaultMaxDelay !== undefined) this.defaultMaxDelay = config.defaultMaxDelay;
    if (config.defaultBackoffMultiplier !== undefined) this.defaultBackoffMultiplier = config.defaultBackoffMultiplier;
  }

  /** Pre-turn lifecycle hook. Currently a no-op. */
  beforeTurn(ctx: TurnContext): Promise<void> {
    return Promise.resolve();
  }

  /** Post-turn lifecycle hook. Currently a no-op. */
  afterTurn(ctx: TurnContext): Promise<void> {
    return Promise.resolve();
  }

  /** Shut down the plugin and release any resources. */
  async shutdown(): Promise<void> {}

  /**
   * Execute an async function with automatic retry on failure.
   * Uses exponential backoff capped at maxDelay between attempts.
   */
  withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
    const maxRetries = options?.maxRetries ?? this.defaultMaxRetries;
    const baseDelay = options?.baseDelay ?? this.defaultBaseDelay;
    const maxDelay = options?.maxDelay ?? this.defaultMaxDelay;
    const backoffMultiplier = options?.backoffMultiplier ?? this.defaultBackoffMultiplier;
    const retryCondition = options?.retryCondition ?? options?.shouldRetry;
    const onRetry = options?.onRetry;

    const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

    const attempt = async (retryNumber: number): Promise<T> => {
      try {
        return await fn();
      } catch (error: any) {
        if (retryCondition && !retryCondition(error)) {
          throw error;
        }

        if (retryNumber > maxRetries) {
          throw error;
        }

        if (onRetry) {
          onRetry(retryNumber, error);
        }

        const delayMs = Math.min(
          baseDelay * Math.pow(backoffMultiplier, retryNumber - 1),
          maxDelay
        );

        await delay(delayMs);
        return attempt(retryNumber + 1);
      }
    };

    return attempt(1);
  }
}

/** Convenience factory for the retry plugin. */
export function createRetryPlugin(config?: RetryConfig): RetryPlugin {
  return new RetryPlugin(config);
}

/** Configuration for a circuit breaker instance. */
export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenRequests?: number;
  successThreshold?: number;
}

/**
 * Prevents repeated calls to a failing dependency by transitioning through
 * closed -> open -> half-open states, allowing the dependency time to recover.
 */
export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failureCount = 0;
  private failureThreshold: number;
  private resetTimeout: number;
  private successThreshold: number;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private probeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static readonly PROBE_TIMEOUT = 30000;

  /** Create a circuit breaker with the given failure threshold and reset timeout. */
  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold;
    this.resetTimeout = options.resetTimeout;
    this.successThreshold = options.successThreshold ?? 1;
  }

  private static readonly CB_HANDLED_BY = Symbol.for('__circuitBreakerHandledBy');

  private isCircuitBreakerError(error: any): boolean {
    if (error && typeof error === 'object') {
      const handledBy = (error as any)[CircuitBreaker.CB_HANDLED_BY];
      if (handledBy instanceof Set && handledBy.size > 0 && !handledBy.has(this)) {
        return true;
      }
    }
    if (error instanceof Error) {
      return /circuit.*open|breaker.*open|half-open/i.test(error.message);
    }
    return false;
  }

  private markError(error: any): void {
    if (error && typeof error === 'object') {
      if (!(error as any)[CircuitBreaker.CB_HANDLED_BY]) {
        (error as any)[CircuitBreaker.CB_HANDLED_BY] = new Set();
      }
      (error as any)[CircuitBreaker.CB_HANDLED_BY].add(this);
    }
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws immediately when the circuit is open.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.checkStateTransition();

    if (this.state === 'open') {
      throw new Error('Circuit breaker is open');
    }

    if (this.state === 'half-open') {
      if (this.probeInFlight) {
        throw new Error('Circuit breaker is half-open: probe in flight');
      }
      this.probeInFlight = true;

      this.probeTimeoutId = setTimeout(() => {
        if (this.probeInFlight) {
          this.state = 'open';
          this.openedAt = Date.now();
          this.probeInFlight = false;
        }
      }, CircuitBreaker.PROBE_TIMEOUT);

      try {
        const result = await fn();
        this.clearProbeTimeout();
        this.state = 'closed';
        this.failureCount = 0;
        this.openedAt = null;
        this.probeInFlight = false;
        return result;
      } catch (error) {
        this.clearProbeTimeout();
        this.state = 'open';
        this.openedAt = Date.now();
        this.probeInFlight = false;
        throw error;
      }
    }

    // Closed state
    try {
      const result = await fn();
      this.failureCount = 0;
      return result;
    } catch (error: any) {
      if (this.isCircuitBreakerError(error)) {
        throw error;
      }
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'open';
        this.openedAt = Date.now();
      }
      this.markError(error);
      throw error;
    }
  }

  /** Return the current state, potentially triggering an open -> half-open transition. */
  getState(): 'closed' | 'open' | 'half-open' {
    this.checkStateTransition();
    return this.state;
  }

  /** Force the breaker back to a closed state. */
  reset(): void {
    this.clearProbeTimeout();
    this.state = 'closed';
    this.failureCount = 0;
    this.openedAt = null;
    this.probeInFlight = false;
  }

  /** Return the current failure count since the last reset or close transition. */
  getFailureCount(): number {
    return this.failureCount;
  }

  private clearProbeTimeout(): void {
    if (this.probeTimeoutId !== null) {
      clearTimeout(this.probeTimeoutId);
      this.probeTimeoutId = null;
    }
  }

  private checkStateTransition(): void {
    if (this.state === 'open' && this.openedAt !== null) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed > this.resetTimeout) {
        this.state = 'half-open';
        this.probeInFlight = false;
      }
    }
  }
}

/** Convenience factory for a standalone circuit breaker. */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(options);
}

/**
 * Maintains a named set of circuit breakers so each target endpoint
 * gets its own independent failure tracking.
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /** Retrieve or lazily create a circuit breaker for the given target. */
  getBreaker(target: string, options?: CircuitBreakerOptions): CircuitBreaker {
    const normalizedTarget = target.replace(/[\/\?]+$/, '');

    if (this.breakers.has(normalizedTarget)) {
      return this.breakers.get(normalizedTarget)!;
    }

    const breaker = new CircuitBreaker(options ?? { failureThreshold: 5, resetTimeout: 5000 });
    this.breakers.set(normalizedTarget, breaker);
    return breaker;
  }

  /** Snapshot of all tracked breakers keyed by normalized target name. */
  getAllBreakers(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }
}

/** Convenience factory for the circuit breaker registry. */
export function createCircuitBreakerRegistry(): CircuitBreakerRegistry {
  return new CircuitBreakerRegistry();
}
