import { ageOf, Entitlements, Entry, BREAKER_FAILS, BREAKER_OPEN_MS, FRESH_MS, STALE_OK_MS, UnknownCustomerError } from "./core";

export type Source = "fresh" | "stale" | "fetched" | "unknown";

export interface Provider {
  fetchEntitlements(customerKey: string): Promise<Entitlements>;
}

export interface CacheOptions {
  freshMs?: number;
  staleOkMs?: number;
  /** When true, simultaneous lookups for one customer share a single call to the provider. */
  merge?: boolean;
  /** A provider call that takes longer than this counts as a failure. */
  timeoutMs?: number;
  /** Called with the reason each time a provider call fails. */
  onError?: (key: string, error: unknown) => void;
  now?: () => number;
}

export interface Stats {
  fresh: number;
  stale: number;
  fetched: number;
  unknown: number;
  providerCalls: number;
  providerErrors: number;
  merged: number;
}

export class EntitlementCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entitlements | null>>();
  private failures = 0;
  private openUntil = 0;
  readonly stats: Stats = { fresh: 0, stale: 0, fetched: 0, unknown: 0, providerCalls: 0, providerErrors: 0, merged: 0 };
  private freshMs: number;
  private staleOkMs: number;
  private merge: boolean;
  private timeoutMs: number;
  private onError?: (key: string, error: unknown) => void;
  private now: () => number;

  constructor(private provider: Provider, options: CacheOptions = {}) {
    this.freshMs = options.freshMs ?? FRESH_MS;
    this.staleOkMs = options.staleOkMs ?? STALE_OK_MS;
    this.merge = options.merge ?? true;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<{ entitlements: Entitlements | null; source: Source }> {
    const entry = this.entries.get(key);
    if (entry) {
      const age = ageOf(entry, this.now(), this.freshMs, this.staleOkMs);
      if (age === "fresh") {
        this.stats.fresh++;
        return { entitlements: entry.value, source: "fresh" };
      }
      if (age === "stale") {
        this.stats.stale++;
        void this.load(key); // refresh behind the answer
        return { entitlements: entry.value, source: "stale" };
      }
    }
    const value = await this.load(key);
    if (value === null) {
      this.stats.unknown++;
      return { entitlements: null, source: "unknown" };
    }
    this.stats.fetched++;
    return { entitlements: value, source: "fetched" };
  }

  /** Forget a customer, so the next request asks the provider. */
  purge(key: string): void {
    this.entries.delete(key);
  }

  purgeAll(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private load(key: string): Promise<Entitlements | null> {
    if (this.now() < this.openUntil) return Promise.resolve(null);
    if (this.merge) {
      const running = this.inflight.get(key);
      if (running) {
        this.stats.merged++;
        return running;
      }
    }
    const p = this.call(key).finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    if (this.merge) this.inflight.set(key, p);
    return p;
  }

  private async call(key: string): Promise<Entitlements | null> {
    this.stats.providerCalls++;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("provider timed out")), this.timeoutMs);
      });
      const value = await Promise.race([this.provider.fetchEntitlements(key), timeout]).finally(() => clearTimeout(timer));
      this.entries.set(key, { value, fetchedAt: this.now() });
      this.failures = 0;
      return value;
    } catch (error) {
      if (error instanceof UnknownCustomerError) return null; // a missing mapping says nothing about the provider
      this.stats.providerErrors++;
      this.onError?.(key, error);
      if (++this.failures >= BREAKER_FAILS) this.openUntil = this.now() + BREAKER_OPEN_MS;
      return null;
    }
  }
}
