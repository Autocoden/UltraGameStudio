import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_GATEWAY_SELECTION_STORAGE,
  GATEWAY_CONFIG_STORAGE,
  getActiveGatewaySelection,
  getDefaultGatewaySelection,
  getExplicitActiveGatewaySelection,
  resetGatewayConfigStoreForTests,
  setActiveGatewaySelection,
} from "./gatewayConfig";

const ZCODE_PROVIDER = {
  id: "provider-glm",
  kind: "zcode",
  name: "GLM",
  adapter: "zcode" as const,
  channels: [
    {
      id: "default",
      name: "GLM",
      apiKey: undefined,
      baseUrl: "https://glm.example/v4",
      model: "glm-5.3-flash",
      models: undefined,
      route: {
        transport: "openai-compatible" as const,
        baseUrl: "https://glm.example/v4",
        model: "glm-5.3-flash",
        models: undefined,
      },
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  resetGatewayConfigStoreForTests();
});

describe("gateway active selection recovery", () => {
  it.each(["codex", "zcode"] as const)(
    "preserves the explicit system %s selection with configured providers",
    (adapter) => {
      window.localStorage.setItem(
        GATEWAY_CONFIG_STORAGE,
        JSON.stringify({ version: 1, providers: [ZCODE_PROVIDER] }),
      );
      const selection = {
        adapter,
        modelClass: "default",
        systemDefault: true,
        thinkingLevel: "high",
      };
      setActiveGatewaySelection(selection);

      expect(getExplicitActiveGatewaySelection()).toEqual(selection);
      expect(getActiveGatewaySelection()).toEqual(selection);
    },
  );

  it("rejects a stale raw Claude selection and falls back to configured GLM", () => {
    window.localStorage.setItem(
      GATEWAY_CONFIG_STORAGE,
      JSON.stringify({ version: 1, providers: [ZCODE_PROVIDER] }),
    );
    window.localStorage.setItem(
      ACTIVE_GATEWAY_SELECTION_STORAGE,
      JSON.stringify({ adapter: "claude-code", modelClass: "sonnet" }),
    );

    expect(getExplicitActiveGatewaySelection()).toBeNull();
    expect(getDefaultGatewaySelection()).toMatchObject({
      adapter: "zcode",
      providerId: "provider-glm",
      channelId: "default",
    });
    expect(getActiveGatewaySelection()).toMatchObject({
      adapter: "zcode",
      providerId: "provider-glm",
      channelId: "default",
    });
  });

  it("keeps the raw CLI selection when no provider is configured", () => {
    window.localStorage.setItem(
      ACTIVE_GATEWAY_SELECTION_STORAGE,
      JSON.stringify({ adapter: "claude-code", modelClass: "sonnet" }),
    );

    expect(getExplicitActiveGatewaySelection()).toEqual({
      adapter: "claude-code",
      modelClass: "sonnet",
    });
  });
});
