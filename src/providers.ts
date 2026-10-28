import type { Provider } from "./cache";
import { Entitlements, entitlementsFromKinde, UnknownCustomerError } from "./core";

/**
 * Reads entitlements from Kinde's Management API with a machine-to-machine token.
 * The token is kept until shortly before it expires, so a lookup is one call.
 */
export class KindeProvider implements Provider {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private domain: string, // for example "https://yourbusiness.kinde.com"
    private clientId: string,
    private clientSecret: string,
    private customers: Record<string, string> = {}, // organization code or user ID to Kinde billing customer ID
  ) {}

  private customerFor(key: string): string {
    const id = this.customers[key.slice(key.indexOf(":") + 1)];
    if (!id) throw new UnknownCustomerError(`no billing customer is mapped for ${key}`);
    return id;
  }

  /** Gets the machine-to-machine token before the first request needs it. */
  async warm(): Promise<void> {
    await this.accessToken();
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 30_000) return this.token.value;
    const res = await fetch(`${this.domain}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: `${this.domain}/api`,
      }),
    });
    if (!res.ok) throw new Error(`token request failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  async fetchEntitlements(key: string): Promise<Entitlements> {
    const url = new URL(`${this.domain}/api/v1/billing/entitlements`);
    url.searchParams.set("customer_id", this.customerFor(key));
    url.searchParams.set("page_size", "100");
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new Error(`entitlements request failed: ${res.status}`);
    return entitlementsFromKinde(await res.json());
  }
}

/**
 * A stand-in for Kinde that runs in this process. It has a plan table, a fixed delay per call,
 * and a switch that makes every call fail. It is NOT Kinde, and any latency it shows is the delay it was given.
 */
export class StandInProvider implements Provider {
  calls = 0;
  down = false;
  private plans = new Map<string, Entitlements>();

  constructor(private delayMs = 0, private defaultPlan: Entitlements = { reports: 100 }) {}

  setPlan(key: string, plan: Entitlements): void {
    this.plans.set(key, plan);
  }

  async fetchEntitlements(key: string): Promise<Entitlements> {
    this.calls++;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.down) throw new Error("provider is down");
    return this.plans.get(key) ?? this.defaultPlan;
  }
}
