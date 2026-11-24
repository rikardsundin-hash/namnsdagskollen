import { type Config, type Device, dispatchHandler } from "./dispatch.ts";

async function database<T>(
  path: string,
  method = "GET",
  body?: object,
): Promise<T> {
  const url = Deno.env.get("SUPABASE_URL");
  const key =
    JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Database configuration missing");
  const headers = new Headers({
    apikey: key,
    "Content-Type": "application/json",
  });
  if (method === "PATCH") headers.set("Prefer", "return=representation");
  if (!key.startsWith("sb_secret_")) {
    headers.set("Authorization", "Bearer " + key);
  }
  const result = await fetch(url + "/rest/v1/" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) throw new Error("Database request failed");
  return (result.status === 204 ? undefined : await result.json()) as T;
}

Deno.serve(dispatchHandler({
  async config() {
    const rows = await database<Config[]>(
      "ld_push_config?id=eq.true&select=cron_token,vapid_public,vapid_private",
    );
    if (rows.length !== 1 || !rows[0].cron_token) {
      throw new Error("Dispatch configuration missing");
    }
    return rows[0];
  },
  claim: (tick) =>
    database<{ accepted: true; devices: Device[] } | { accepted: false }>(
      "rpc/ld_claim_scheduled_pushes",
      "POST",
      { signed_tick: tick },
    ),
  async finish(device, outcome) {
    const query = new URLSearchParams({
      device_id: "eq." + device.device_id,
      day: "eq." + device.day,
      status: "eq.claimed",
      select: "status",
    });
    const rows = await database<{ status: string }[]>(
      "ld_push_deliveries?" + query,
      "PATCH",
      outcome,
    );
    if (rows.length !== 1 || rows[0].status !== outcome.status) {
      throw new Error("Delivery outcome not confirmed");
    }
  },
}));
