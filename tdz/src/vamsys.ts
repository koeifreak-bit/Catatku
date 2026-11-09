/** Minimal vAMSYS Operations API v3 client (OAuth2 client credentials). */

export const API_BASE = "https://vamsys.io/api/v3/operations";
export const TOKEN_URL = "https://vamsys.io/oauth/token";

export interface PirepSummary {
  id: number;
  status: string;
  type: string | null;
  callsign: string | null;
  bonus_sum: number | null;
  aircraft_id?: number | null;
  fleet_id?: number | null;
  /** Airborne time in seconds. */
  flight_length?: number | null;
  /** Feet per minute, negative = descending. */
  landing_rate?: number | null;
  landing_g?: number | null;
}

export interface Aircraft {
  id: number;
  fleet_id: number;
  registration: string;
  hide_in_phoenix: boolean;
  internal_remarks: string | null;
}

export interface AircraftPatch {
  hide_in_phoenix?: boolean;
  internal_remarks?: string | null;
}

export interface Touchdown {
  index: number;
  rate: number;
  runway: string | null;
  /** Runway REMAINING after the touchdown point, in feet (not the runway's full LDA). */
  lda: number | null;
  distance_from_start_ft: number | null;
  time: string | null;
}

export interface PointEntry {
  name: string;
  points: number;
  type?: string;
  id?: number;
}

export interface PirepDetail extends PirepSummary {
  pirep_data: Record<string, unknown> | null;
}

export interface VamsysPort {
  listPireps(size: number, cursor?: string): Promise<{ data: PirepSummary[]; nextCursor: string | null }>;
  getPirep(id: number): Promise<PirepDetail>;
  getTouchdowns(id: number): Promise<Touchdown[]>;
  putBonusPoints(id: number, entries: PointEntry[]): Promise<number>;
  addComment(id: number, comment: string): Promise<void>;
  reject(id: number): Promise<void>;
  getAircraft(fleetId: number, aircraftId: number): Promise<Aircraft>;
  updateAircraft(fleetId: number, aircraftId: number, patch: AircraftPatch): Promise<void>;
}

export class VamsysError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class VamsysApi implements VamsysPort {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private fetchFn: Fetch = (input, init) => fetch(input, init),
  ) {}

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "*",
    });
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new VamsysError(res.status, `token request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh 5 minutes early.
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 };
    return json.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.getToken(retried);
    const res = await this.fetchFn(API_BASE + path, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) return this.request<T>(method, path, body, true);
    if (!res.ok) throw new VamsysError(res.status, `${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listPireps(size: number, cursor?: string) {
    const q = new URLSearchParams({ "page[size]": String(size), sort: "-id" });
    if (cursor) q.set("page[cursor]", cursor);
    const r = await this.request<{ data: PirepSummary[]; meta?: { next_cursor?: string | null } }>("GET", `/pireps?${q}`);
    return { data: r.data, nextCursor: r.meta?.next_cursor ?? null };
  }

  async getPirep(id: number) {
    return (await this.request<{ data: PirepDetail }>("GET", `/pireps/${id}`)).data;
  }

  async getTouchdowns(id: number) {
    return (await this.request<{ data: { touchdowns: Touchdown[] } }>("GET", `/pireps/${id}/touchdowns`)).data.touchdowns;
  }

  async putBonusPoints(id: number, entries: PointEntry[]) {
    const r = await this.request<{ data: { bonus_sum: number } }>("PUT", `/pireps/${id}/bonus-points`, { points: entries });
    return r.data.bonus_sum;
  }

  async addComment(id: number, comment: string) {
    await this.request("POST", `/pireps/${id}/comments`, { comment });
  }

  async reject(id: number) {
    await this.request("POST", `/pireps/${id}/reject`);
  }

  async getAircraft(fleetId: number, aircraftId: number) {
    return (await this.request<{ data: Aircraft }>("GET", `/fleet/${fleetId}/aircraft/${aircraftId}`)).data;
  }

  /** Partial update: only the given fields change. */
  async updateAircraft(fleetId: number, aircraftId: number, patch: AircraftPatch) {
    await this.request("PUT", `/fleet/${fleetId}/aircraft/${aircraftId}`, patch);
  }
}
