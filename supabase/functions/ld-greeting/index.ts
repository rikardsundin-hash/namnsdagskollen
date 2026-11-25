import { greetingHandler } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL");
const publishable =
  JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default ||
  Deno.env.get("SUPABASE_ANON_KEY");
const secret =
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(greetingHandler({
  modelKey: Deno.env.get("OPENAI_API_KEY")?.trim(),
  async authenticate(token) {
    if (!url || !publishable) throw new Error("Auth configuration missing");
    const result = await fetch(url + "/auth/v1/user", {
      headers: { apikey: publishable, Authorization: token },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if ([400, 401, 403].includes(result.status)) return null;
    if (!result.ok) throw new Error("Auth request failed");
    const user = await result.json();
    return typeof user.id === "string" && user.is_anonymous !== true
      ? user
      : null;
  },
  async reserve(userId) {
    if (!url || !secret) throw new Error("Quota configuration missing");
    const headers = new Headers({
      apikey: secret,
      "Content-Type": "application/json",
    });
    if (!secret.startsWith("sb_secret_")) {
      headers.set("Authorization", "Bearer " + secret);
    }
    const result = await fetch(url + "/rest/v1/rpc/ld_take_greeting_slot", {
      method: "POST",
      headers,
      body: JSON.stringify({ account_id: userId }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new Error("Quota request failed");
    return (await result.json()) === true;
  },
}));
