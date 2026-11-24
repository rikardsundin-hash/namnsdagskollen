import webpush from "npm:web-push@3.6.7";

export type Config = {
  cron_token: string;
  vapid_public: string;
  vapid_private: string;
};
export type Device = {
  device_id: string;
  day: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
};
export type Outcome = {
  status: "sent" | "failed";
  provider_status: number | null;
  failure: string | null;
};
export type DispatchStore = {
  config: () => Promise<Config>;
  claim: (
    tick: number,
  ) => Promise<{ accepted: true; devices: Device[] } | { accepted: false }>;
  finish: (device: Device, outcome: Outcome) => Promise<void>;
};

const encoder = new TextEncoder();
const signatureMessage = "ld-push-dispatch:v1:";
const payload = JSON.stringify({ kind: "reminder" });
const subject = "https://rikardsundin-hash.github.io/namnsdagskollen/";

function response(status: number, data: object) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function validSignature(
  timestamp: string,
  signature: string,
  secret: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(
    signature.match(/../g)!,
    (pair) => Number.parseInt(pair, 16),
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    encoder.encode(signatureMessage + timestamp),
  );
}

function pushEndpoint(endpoint: string): string | null {
  if (
    endpoint.length > 2048 || !/^https:\/\/[\x21-\x7e]+$/.test(endpoint) ||
    /[\\#]/.test(endpoint)
  ) {
    return null;
  }
  try {
    const url = new URL(endpoint);
    const authority = endpoint.slice(8).split(/[/?]/, 1)[0];
    const host = url.hostname;
    const allowed = host === "web.push.apple.com" ||
      host.endsWith(".push.apple.com") ||
      host === "fcm.googleapis.com" ||
      host === "updates.push.services.mozilla.com";
    return allowed && authority === host && url.pathname.length > 1
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function failed(
  failure: string,
  provider_status: number | null = null,
): Outcome {
  return { status: "failed", provider_status, failure };
}

async function deliver(
  device: Device,
  config: Config,
  fetchPush: typeof fetch,
): Promise<Outcome> {
  const endpoint = pushEndpoint(device.endpoint);
  if (!endpoint) return failed("invalid_endpoint");

  let details;
  try {
    details = webpush.generateRequestDetails(
      { endpoint, keys: { p256dh: device.p256dh, auth: device.auth_secret } },
      payload,
      {
        TTL: 3600,
        urgency: "normal",
        vapidDetails: {
          subject,
          publicKey: config.vapid_public,
          privateKey: config.vapid_private,
        },
      },
    );
  } catch {
    return failed("invalid_subscription");
  }

  try {
    const reply = await fetchPush(endpoint, {
      method: "POST",
      headers: details.headers,
      body: details.body ? Uint8Array.from(details.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    await reply.body?.cancel().catch(() => {});
    if (reply.ok) {
      return { status: "sent", provider_status: reply.status, failure: null };
    }
    const expired = reply.status === 404 || reply.status === 410;
    return failed(
      expired ? "expired_subscription" : "provider_rejected",
      reply.status,
    );
  } catch {
    return failed("transport");
  }
}

export function dispatchHandler(
  store: DispatchStore,
  fetchPush = fetch,
  clock = Date.now,
) {
  return async (request: Request) => {
    if (request.method !== "POST") {
      return response(405, { error: "POST required" });
    }
    const timestamp = request.headers.get("x-ld-timestamp") ?? "";
    const signature = request.headers.get("x-ld-signature") ?? "";
    if (
      !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) ||
      Math.abs(Math.floor(clock() / 1000) - Number(timestamp)) > 120
    ) {
      return response(401, { error: "Unauthorized" });
    }

    try {
      const config = await store.config();
      if (!await validSignature(timestamp, signature, config.cron_token)) {
        return response(401, { error: "Unauthorized" });
      }
      if (!config.vapid_public || !config.vapid_private) {
        throw new Error("VAPID missing");
      }
      const claim = await store.claim(Number(timestamp));
      if (!claim.accepted) {
        return response(409, { error: "Dispatch already used or expired" });
      }
      const devices = claim.devices;
      const outcomes = await Promise.allSettled(devices.map(async (device) => {
        const outcome = await deliver(device, config, fetchPush);
        await store.finish(device, outcome);
        return outcome.status;
      }));
      const sent = outcomes.filter((result) =>
        result.status === "fulfilled" && result.value === "sent"
      ).length;
      const unrecorded = outcomes.filter((result) =>
        result.status === "rejected"
      ).length;
      const summary = {
        claimed: devices.length,
        sent,
        failed: devices.length - sent - unrecorded,
        unrecorded,
      };
      if (unrecorded) {
        console.error("Scheduled push outcome could not be stored", {
          unrecorded,
        });
      }
      return response(unrecorded ? 500 : 200, summary);
    } catch {
      console.error("Scheduled push dispatch failed");
      return response(500, { error: "Dispatch unavailable" });
    }
  };
}
