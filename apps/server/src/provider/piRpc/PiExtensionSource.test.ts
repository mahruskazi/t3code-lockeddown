import { assert, describe, it } from "@effect/vitest";

import { T3_PI_EXTENSION_SOURCE } from "./PiExtensionSource.ts";

type ExtensionHandler = (event: unknown, context: unknown) => unknown;

function loadExtensionHandlers(approvalMode = "gated") {
  const handlers = new Map<string, ExtensionHandler>();
  const source = T3_PI_EXTENSION_SOURCE.replace(
    "export default function t3Approvals(pi)",
    "function t3Approvals(pi)",
  );
  const factory = new Function("globalThis", `${source}\nreturn t3Approvals;`)({
    process: { env: { T3_PI_APPROVAL_MODE: approvalMode } },
  }) as (pi: { on: (event: string, handler: ExtensionHandler) => void }) => void;

  factory({
    on: (event, handler) => handlers.set(event, handler),
  });
  return handlers;
}

const fableContext = {
  model: { provider: "anthropic", id: "claude-fable-5-1" },
};

describe("T3 Pi extension", () => {
  it("adds Anthropic server-side refusal fallbacks to Fable 5.1 requests", () => {
    const handlers = loadExtensionHandlers();
    const headers = { "Anthropic-Beta": "existing-beta" };

    handlers.get("before_provider_headers")?.({ headers }, fableContext);
    handlers.get("before_provider_headers")?.({ headers }, fableContext);

    assert.equal(headers["Anthropic-Beta"], "existing-beta,server-side-fallback-2026-07-01");

    const payload = { model: "claude-fable-5-1", messages: [] };
    const result = handlers.get("before_provider_request")?.({ payload }, fableContext);
    assert.deepStrictEqual(result, {
      ...payload,
      fallbacks: [{ model: "claude-opus-5" }, { model: "claude-opus-4-8" }],
    });
    assert.notProperty(payload, "fallbacks");
  });

  it("prices the model that answered a server-side fallback", () => {
    const handlers = loadExtensionHandlers();
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus-5",
      usage: {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 2_000_000,
        cacheWrite1h: 1_000_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };

    const result = handlers.get("message_end")?.({ message }, fableContext) as {
      message: { model: string; usage: { cost: unknown } };
    };
    assert.equal(result.message.model, "claude-opus-5");
    assert.deepStrictEqual(result.message.usage.cost, {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 16.25,
      total: 46.75,
    });
    assert.equal(message.usage.cost.total, 0);
  });

  it("does not override Pi fallbacks or touch unrelated models", () => {
    const handlers = loadExtensionHandlers();
    const existingPayload = {
      model: "claude-fable-5-1",
      fallbacks: [{ model: "configured-model" }],
    };
    const existingResult = handlers.get("before_provider_request")?.(
      { payload: existingPayload },
      fableContext,
    );
    assert.isUndefined(existingResult);

    const unrelatedContext = {
      model: { provider: "anthropic", id: "claude-sonnet-5" },
    };
    const unrelatedHeaders: Record<string, string> = {};
    handlers.get("before_provider_headers")?.({ headers: unrelatedHeaders }, unrelatedContext);
    assert.deepStrictEqual(unrelatedHeaders, {});
    assert.isUndefined(
      handlers.get("before_provider_request")?.(
        { payload: { model: "claude-sonnet-5" } },
        unrelatedContext,
      ),
    );

    const nativeContext = {
      model: {
        provider: "anthropic",
        id: "claude-fable-5-1",
        compat: {
          allowedFallbackModels: [{ provider: "anthropic", model: "native-fallback" }],
        },
      },
    };
    const nativeHeaders: Record<string, string> = {};
    handlers.get("before_provider_headers")?.({ headers: nativeHeaders }, nativeContext);
    assert.deepStrictEqual(nativeHeaders, {});
    assert.isUndefined(
      handlers.get("before_provider_request")?.(
        { payload: { model: "claude-fable-5-1" } },
        nativeContext,
      ),
    );
  });

  it("keeps refusal fallback enabled for full-access threads", () => {
    const handlers = loadExtensionHandlers("off");

    assert.isTrue(handlers.has("before_provider_headers"));
    assert.isTrue(handlers.has("before_provider_request"));
    assert.isTrue(handlers.has("message_end"));
    assert.isFalse(handlers.has("tool_call"));
  });
});
