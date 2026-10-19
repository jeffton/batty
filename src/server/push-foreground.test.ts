import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PushForeground } from "./push-foreground";

type Challenge = { clientId: string; challengeId: string };
function client(service: PushForeground) {
  const challenges: Challenge[] = [];
  const disconnect = service.connect((event, data) => {
    if (event === "push-foreground") challenges.push(data as Challenge);
  });
  return { challenges, disconnect };
}
function ack(service: PushForeground, challenge: Challenge) {
  return service.acknowledge(challenge.clientId, challenge.challengeId);
}

afterEach(() => vi.useRealTimers());

describe("on-demand push foreground checks", () => {
  it("accepts any one of several live clients, and consumes only that delivery", async () => {
    vi.useFakeTimers();
    const service = new PushForeground();
    const hidden = client(service);
    const visible = client(service);
    const first = service.isVisible();
    const second = service.isVisible();
    expect(ack(service, visible.challenges[0]!)).toBe(true);
    expect(ack(service, hidden.challenges[0]!)).toBe(false);
    await expect(first).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBe(false);
    expect(ack(service, visible.challenges[1]!)).toBe(false);
  });

  it("sends normally with no streams or when all clients stay silent", async () => {
    vi.useFakeTimers();
    const service = new PushForeground();
    await expect(service.isVisible()).resolves.toBe(false);
    client(service);
    client(service);
    const result = service.isVisible();
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops disconnected clients and does not let a replacement acknowledge old work", async () => {
    const service = new PushForeground();
    const first = client(service);
    const result = service.isVisible();
    first.disconnect();
    await expect(result).resolves.toBe(false);
    const next = client(service);
    const current = service.isVisible();
    expect(ack(service, first.challenges[0]!)).toBe(false);
    expect(
      service.acknowledge(next.challenges[0]!.clientId, first.challenges[0]!.challengeId),
    ).toBe(false);
    expect(ack(service, next.challenges[0]!)).toBe(true);
    await expect(current).resolves.toBe(true);
  });

  it("keeps waiting for other streams after one disconnects", async () => {
    const service = new PushForeground();
    const first = client(service);
    const second = client(service);
    const result = service.isVisible();
    first.disconnect();
    expect(ack(service, first.challenges[0]!)).toBe(false);
    expect(ack(service, second.challenges[0]!)).toBe(true);
    await expect(result).resolves.toBe(true);
  });

  it("rejects unknown, late, and another installation owner's acknowledgements", async () => {
    vi.useFakeTimers();
    const service = new PushForeground();
    const otherOwner = new PushForeground();
    const own = client(service);
    const other = client(otherOwner);
    const result = service.isVisible();
    const otherResult = otherOwner.isVisible();
    expect(ack(service, other.challenges[0]!)).toBe(false);
    expect(service.acknowledge(other.challenges[0]!.clientId, own.challenges[0]!.challengeId)).toBe(
      false,
    );
    expect(ack(otherOwner, own.challenges[0]!)).toBe(false);
    // Wall time rejects late requests even if the timer callback has not run yet.
    vi.setSystemTime(Date.now() + 1001);
    expect(ack(service, own.challenges[0]!)).toBe(false);
    await expect(result).resolves.toBe(false);
    other.disconnect();
    await expect(otherResult).resolves.toBe(false);
  });
});
