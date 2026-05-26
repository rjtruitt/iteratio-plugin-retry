# iteratio-plugin-retry

Retry with backoff plugin for iteratio.

## Install

```
npm install iteratio-plugin-retry
```

## What It Does

Automatically retries failed LLM calls or tool executions with exponential backoff. Handles transient errors like rate limits, network timeouts, and server errors without crashing the agent loop.

## Usage

```typescript
import { AgentLoop } from 'iteratio';
import { RetryPlugin } from 'iteratio-plugin-retry';

const loop = AgentLoop.builder()
  .withLLM(llm)
  .withPlugin(new RetryPlugin({
    maxRetries: 3,
    baseDelayMs: 1000,
    backoffMultiplier: 2
  }))
  .build();
```

## License

MIT
