const occasions = new Map([
  ["nameday", "namnsdag"],
  ["birthday", "födelsedag"],
  ["anniversary", "årsdag"],
  ["milestone", "personlig milstolpe"],
]);
const tones = new Map([
  ["warm", "varm och omtänksam"],
  ["funny", "lättsam och rolig, utan skämt på mottagarens bekostnad"],
  ["short", "kort och rak, högst en mening"],
]);

const appOrigin = "https://rikardsundin-hash.github.io";
const cors = {
  "Access-Control-Allow-Origin": appOrigin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  Vary: "Origin",
};

type User = { id: string; email_confirmed_at?: string };
type Dependencies = {
  modelKey: string | undefined;
  authenticate: (token: string) => Promise<User | null>;
  reserve: (userId: string) => Promise<boolean>;
  modelFetch?: typeof fetch;
};

function json(status: number, body: object, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers: { ...cors, ...headers } });
}

async function requestBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(256);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.byteLength) {
        await reader.cancel();
        return null;
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function greetingText(
  result: {
    output?: { type: string; content?: { type: string; text?: string }[] }[];
  },
) {
  return (result.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((item) =>
      item.type === "output_text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join(" ")
    .trim();
}

export function greetingHandler(
  { modelKey, authenticate, reserve, modelFetch = fetch }: Dependencies,
) {
  return async (request: Request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json(405, { error: "method" }, { Allow: "POST, OPTIONS" });
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== appOrigin) return json(403, { error: "origin" });
    if (!modelKey) return json(503, { error: "unavailable" });
    const token = request.headers.get("Authorization") ?? "";
    if (!/^Bearer [^\s]+$/.test(token)) return json(401, { error: "sign_in" });
    const body = await requestBody(request);
    if (
      !body || Object.keys(body).length !== 2 ||
      !occasions.has(body.occasion) || !tones.has(body.tone)
    ) {
      return json(400, { error: "invalid_choices" });
    }

    try {
      const user = await authenticate(token);
      if (!user) return json(401, { error: "sign_in" });
      if (!user.email_confirmed_at) {
        return json(403, { error: "confirm_email" });
      }
      if (!await reserve(user.id)) return json(429, { error: "daily_limit" });

      const answer = await modelFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + modelKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          store: false,
          max_output_tokens: 180,
          instructions:
            "Skriv en färdig svensk gratulationshälsning som kan skickas i ett sms. Svara med högst tre meningar och högst 400 tecken. Skriv bara själva hälsningen, utan inledande tilltal, namn, platshållare, signatur, citattecken eller Markdown. Hitta inte på personliga detaljer eller datum.",
          input: "Tillfälle: " + occasions.get(body.occasion) + ". Ton: " +
            tones.get(body.tone) + ".",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!answer.ok) {
        console.warn("Greeting provider returned", answer.status);
        await answer.body?.cancel().catch(() => {});
        return json(503, { error: "unavailable" });
      }
      const text = greetingText(await answer.json());
      if (!text || text.length > 450) {
        return json(502, { error: "empty_greeting" });
      }
      return json(200, { text });
    } catch {
      console.warn("Greeting request failed");
      return json(503, { error: "unavailable" });
    }
  };
}
