import webpush from "npm:web-push@3.6.7";
import {
  type Device,
  dispatchHandler,
  type Outcome,
} from "../functions/ld-push-dispatch/dispatch.ts";

const tick = 1795558058;
const clock = () => tick * 1000;
const token = "synthetic-dispatch-key";
const keys = webpush.generateVAPIDKeys();
const config = {
  cron_token: token,
  vapid_public: keys.publicKey,
  vapid_private: keys.privateKey,
};

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function request(at = tick, secret = token) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode("ld-push-dispatch:v1:" + at),
  );
  const hex = Array.from(
    new Uint8Array(sig),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Request("https://example.invalid", {
    method: "POST",
    headers: { "x-ld-timestamp": String(at), "x-ld-signature": hex },
  });
}

Deno.test("only valid, recent POST signatures reach the claim, and replay is rejected", async () => {
  let claims = 0;
  const handler = dispatchHandler(
    {
      config: async () => config,
      claim: async () =>
        ++claims === 1 ? { accepted: true, devices: [] } : { accepted: false },
      finish: async () => {
        throw new Error("unexpected finish");
      },
    },
    fetch,
    clock,
  );

  equal((await handler(new Request("https://example.invalid"))).status, 405);
  equal(
    (await handler(new Request("https://example.invalid", { method: "POST" })))
      .status,
    401,
  );
  equal((await handler(await request(tick - 121))).status, 401);
  equal((await handler(await request(tick + 121))).status, 401);
  equal((await handler(await request(tick, "wrong key"))).status, 401);
  equal(claims, 0);
  equal(await (await handler(await request())).json(), {
    claimed: 0,
    sent: 0,
    failed: 0,
    unrecorded: 0,
  });
  equal((await handler(await request())).status, 409);
});

Deno.test("only allowed endpoints are contacted and each provider outcome is stored", async () => {
  const endpoints = [
    "https://web.push.apple.com/ok",
    "https://fcm.googleapis.com/expired",
    "https://updates.push.services.mozilla.com/rejected",
    "https://web.push.apple.com/network-failure",
    "https://web.push.apple.com.evil.example/forged",
    "https://web.push.apple.com:443/explicit-port",
    "https://user@web.push.apple.com/credentials",
    "http://web.push.apple.com/insecure",
    "https://web.push.apple.com/invalid-keys",
  ];
  const devices: Device[] = endpoints.map((endpoint, i) => ({
    endpoint,
    device_id: String(i),
    day: "2026-11-24",
    p256dh: i === 8 ? "malformed" : keys.publicKey,
    auth_secret: "AAAAAAAAAAAAAAAAAAAAAA",
  }));
  const results = new Map<string, Outcome>();
  const attempted: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    attempted.push(url.href);
    equal(init?.method, "POST");
    equal(init?.redirect, "error");
    equal(new Headers(init?.headers).get("content-encoding"), "aes128gcm");
    if (url.pathname === "/network-failure") {
      throw new TypeError("simulated network error");
    }
    return new Response(null, {
      status: url.pathname === "/ok"
        ? 201
        : url.pathname === "/expired"
        ? 410
        : 429,
    });
  };
  const handler = dispatchHandler(
    {
      config: async () => config,
      claim: async () => ({ accepted: true, devices }),
      finish: async (device, outcome) => {
        results.set(device.device_id, outcome);
      },
    },
    fakeFetch,
    clock,
  );
  const result = await handler(await request());
  equal(result.status, 200);
  equal(await result.json(), { claimed: 9, sent: 1, failed: 8, unrecorded: 0 });
  equal(attempted, endpoints.slice(0, 4));
  equal(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => results.get(String(i))?.failure),
    [
      null,
      "expired_subscription",
      "provider_rejected",
      "transport",
      "invalid_endpoint",
      "invalid_endpoint",
      "invalid_endpoint",
      "invalid_endpoint",
      "invalid_subscription",
    ],
  );
});

Deno.test("database failure produces a generic error response", async () => {
  const handler = dispatchHandler(
    {
      config: async () => config,
      claim: async () => {
        throw new Error("sensitive database details");
      },
      finish: async () => {},
    },
    fetch,
    clock,
  );
  const result = await handler(await request());
  equal(result.status, 500);
  equal(await result.json(), { error: "Dispatch unavailable" });
});
