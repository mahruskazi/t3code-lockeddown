/**
 * [fork:pi] Pi snapshot capability tests: which thinking-level picker each
 * model publishes, and what it defaults to.
 */
import { assert, describe, expect, it } from "@effect/vitest";

import { buildPiModelCapabilities, piServerProviderModel } from "./PiProvider.ts";
import { parsePiAvailableModels, type PiCatalogModel } from "../piRpc/PiRpcModel.ts";

describe("buildPiModelCapabilities", () => {
  it("offers every level the model supports, defaulting to Pi's own", () => {
    const capabilities = buildPiModelCapabilities(
      ["off", "minimal", "low", "medium", "high"],
      "high",
    );

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "thinkingLevel",
        label: "Thinking",
        type: "select",
        currentValue: "high",
        options: [
          { id: "off", label: "Off", description: "No reasoning" },
          { id: "minimal", label: "Minimal", description: "Very brief reasoning (~1k tokens)" },
          { id: "low", label: "Low", description: "Light reasoning (~2k tokens)" },
          { id: "medium", label: "Medium", description: "Moderate reasoning (~8k tokens)" },
          {
            id: "high",
            label: "High",
            description: "Deep reasoning (~16k tokens)",
            isDefault: true,
          },
        ],
      },
    ]);
  });

  it("publishes no picker for a model that cannot reason", () => {
    // Pi answers `["off"]` for a non-reasoning model: one level is no choice.
    expect(buildPiModelCapabilities(["off"]).optionDescriptors).toEqual([]);
    expect(buildPiModelCapabilities([]).optionDescriptors).toEqual([]);
  });

  it("clamps Pi's default into the levels this model actually supports", () => {
    // `xhigh` needs an explicit mapping, so a model without one gets the
    // nearest level Pi would fall back to rather than an unselectable value.
    const capabilities = buildPiModelCapabilities(["off", "low", "medium", "high"], "xhigh");
    const descriptor = capabilities.optionDescriptors?.[0];

    expect(descriptor?.type === "select" ? descriptor.currentValue : undefined).toBe("high");
    expect(
      descriptor?.type === "select"
        ? descriptor.options.filter((option) => option.isDefault).map((option) => option.id)
        : undefined,
    ).toEqual(["high"]);
  });

  it("omits a default when Pi did not report one", () => {
    const descriptor = buildPiModelCapabilities(["off", "low", "high"]).optionDescriptors?.[0];

    expect(descriptor?.type === "select" ? descriptor.currentValue : "unset").toBeUndefined();
    expect(
      descriptor?.type === "select" ? descriptor.options.some((option) => option.isDefault) : true,
    ).toBe(false);
  });
});

describe("piServerProviderModel", () => {
  it("carries per-model levels through from a discovered catalog", () => {
    const [reasoning, extended, plain] = parsePiAvailableModels({
      models: [
        { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
        {
          provider: "openai",
          id: "gpt-5.6",
          name: "GPT-5.6",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        },
        { provider: "local", id: "plain", name: "Plain" },
      ],
    });

    assert(reasoning && extended && plain);

    const levelsFor = (model: PiCatalogModel) => {
      const descriptor =
        piServerProviderModel(model, "high").capabilities?.optionDescriptors?.[0];
      return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
    };

    expect(levelsFor(reasoning)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(levelsFor(extended)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(levelsFor(plain)).toEqual([]);
  });
});
