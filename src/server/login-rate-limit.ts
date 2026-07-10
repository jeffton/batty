export interface LoginRateLimiter {
  isLimited(key: string, now?: number): boolean;
  recordFailure(key: string, now?: number): void;
  reset(key: string): void;
}

export function createLoginRateLimiter(maxAttempts = 5, windowMs = 60_000): LoginRateLimiter {
  const attemptsByKey = new Map<string, number[]>();
  let nextGlobalPruneAt = 0;

  function pruneExpired(now: number): void {
    if (now < nextGlobalPruneAt) {
      return;
    }
    for (const [key, attempts] of attemptsByKey) {
      const recent = attempts.filter((timestamp) => now - timestamp < windowMs);
      if (recent.length > 0) {
        attemptsByKey.set(key, recent);
      } else {
        attemptsByKey.delete(key);
      }
    }
    nextGlobalPruneAt = now + windowMs;
  }

  function recentAttempts(key: string, now: number): number[] {
    pruneExpired(now);
    const recent = (attemptsByKey.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length > 0) {
      attemptsByKey.set(key, recent);
    } else {
      attemptsByKey.delete(key);
    }
    return recent;
  }

  return {
    isLimited(key, now = Date.now()) {
      return recentAttempts(key, now).length >= maxAttempts;
    },
    recordFailure(key, now = Date.now()) {
      attemptsByKey.set(key, [...recentAttempts(key, now), now]);
    },
    reset(key) {
      attemptsByKey.delete(key);
    },
  };
}
