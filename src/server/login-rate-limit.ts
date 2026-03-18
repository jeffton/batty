export interface LoginRateLimiter {
  isLimited(key: string, now?: number): boolean;
  recordFailure(key: string, now?: number): void;
  reset(key: string): void;
}

export function createLoginRateLimiter(maxAttempts = 5, windowMs = 60_000): LoginRateLimiter {
  const attemptsByKey = new Map<string, number[]>();

  function recentAttempts(key: string, now: number): number[] {
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
