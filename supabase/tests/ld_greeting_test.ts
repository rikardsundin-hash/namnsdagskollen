import { greetingHandler } from "../functions/ld-greeting/handler.ts";

const valid = { occasion: "nameday", tone: "short" };
const user = { id: "synthetic-account", email_confirmed_at: "2026-01-01" };
const origin = "https://rikardsundin-hash.github.io";

function request(
  payload: unknown = valid,
  token = "Bearer test-session",
  from = origin,
) {
  return new Request("https://example.invalid/greeting", {
    method: "POST",
    headers: {
      Authorization: token,
      Origin: from,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("requires an approved origin, signed-in account, allowed choices and quota", async () => {
  let confirmed = false;
  let available = false;
  let reserved = 0;
  const handler = greetingHandler({
    modelKey: "synthetic-key",
    authenticate: async (token) =>
      token === "Bearer test-session"
        ? {
          id: user.id,
          email_confirmed_at: confirmed ? user.email_confirmed_at : undefined,
        }
        : null,
    reserve: async () => {
      reserved++;
      return available;
    },
    modelFetch: async () => {
      throw new Error("unexpected provider call");
    },
  });
  equal(
    (await handler(request(valid, "", "https://other.invalid"))).status,
    403,
  );
  equal((await handler(request(valid, ""))).status, 401);
  equal((await handler(request(valid, "Bearer invalid"))).status, 401);
  equal((await handler(request({ ...valid, name: "private" }))).status, 400);
  equal(
    (await handler(request({ ...valid, occasion: "w".repeat(1000) }))).status,
    400,
  );
  equal((await handler(request())).status, 403);
  equal(reserved, 0);
  confirmed = true;
  equal((await handler(request())).status, 429);
  equal(reserved, 1);
  available = true;
  equal((await handler(request())).status, 503);
});

Deno.test("sends fixed Swedish choices to the provider and extracts the editable draft", async () => {
  const handler = greetingHandler({
    modelKey: "synthetic-key",
    authenticate: async () => user,
    reserve: async (id) => {
      equal(id, user.id);
      return true;
    },
    modelFetch: async (url, init) => {
      equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      equal(
        body.input,
        "Tillfälle: namnsdag. Ton: kort och rak, högst en mening.",
      );
      equal(body.store, false);
      equal(Object.keys(body).sort(), [
        "input",
        "instructions",
        "max_output_tokens",
        "model",
        "store",
      ]);
      return Response.json({
        output: [{
          type: "message",
          content: [
            { type: "output_text", text: " Grattis på namnsdagen! " },
          ],
        }],
      });
    },
  });
  const response = await handler(request());
  equal(response.status, 200);
  equal(await response.json(), { text: "Grattis på namnsdagen!" });
  equal(response.headers.get("Cache-Control"), "no-store");
});

Deno.test("keeps configuration errors and incomplete provider replies recoverable", async () => {
  const deps = {
    authenticate: async () => user,
    reserve: async () => true,
    modelFetch: async () =>
      Response.json({
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "provider details" }],
          },
        ],
      }),
  };
  equal(
    (await greetingHandler({ ...deps, modelKey: undefined })(request())).status,
    503,
  );
  const response = await greetingHandler({
    ...deps,
    modelKey: "synthetic-key",
  })(request());
  equal(response.status, 502);
  equal(await response.json(), { error: "empty_greeting" });
});
