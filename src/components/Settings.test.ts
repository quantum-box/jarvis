import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { defaults, loadSettings, saveSettings, Settings } from "./Settings";
afterEach(() => vi.unstubAllGlobals());
it("always uses the fixed Tachyon API URL and GPT Live model", () => {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ baseUrl: "https://example.test", model: "gpt-realtime-2", tenantId: "tn_test" }) });
  expect(loadSettings()).toMatchObject({ baseUrl: defaults.baseUrl, model: "gpt-live-1", tenantId: "tn_test" });
});
it("does not persist fixed connection values and rejects unsupported backend models", () => {
  let stored = "{}";
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  });
  saveSettings({ ...defaults, baseUrl: "https://example.test", model: "gpt-realtime-2", backendModel: "unknown" });
  expect(JSON.parse(stored)).not.toHaveProperty("baseUrl");
  expect(JSON.parse(stored)).not.toHaveProperty("model");
  expect(loadSettings()).toMatchObject({ baseUrl: defaults.baseUrl, model: "gpt-live-1", backendModel: "gpt-5.6-terra" });
});
it("never persists the bearer token", () => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { setItem });
  const contaminated = { ...defaults, token: "private-token", refreshToken: "private-refresh", tenantId: "tn_test" };
  saveSettings(contaminated);
  const stored = JSON.parse(setItem.mock.calls[0][1]);
  expect(stored.token).toBeUndefined();
  expect(stored.refreshToken).toBeUndefined();
  expect(stored.tenantId).toBe("tn_test");
});
it("ignores stored tokens and invalid setting types", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({ token: "old-token", baseUrl: 42, tenantId: "tn_test" }),
  });
  expect(loadSettings()).toEqual({ ...defaults, tenantId: "tn_test" });
});
it("recovers from malformed local settings", () => {
  vi.stubGlobal("localStorage", { getItem: () => "{bad-json" });
  expect(loadSettings()).toEqual(defaults);
});
it("shows only the Responses backend model selector", () => {
  const html = renderToStaticMarkup(createElement(Settings, { value: defaults, onChange: () => {}, onClose: () => {} }));
  expect(html).not.toContain("Tachyon API URL");
  expect(html).not.toContain(">Model<");
  expect(html).toContain("Responses backend model");
  expect(html).toContain('<select><option value="gpt-5.6-terra" selected="">gpt-5.6-terra</option>');
});
