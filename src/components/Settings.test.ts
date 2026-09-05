import { afterEach, expect, it, vi } from "vitest";
import { defaults, loadSettings, saveSettings } from "./Settings";
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, "", "gpt-realtime", "gpt-realtime-2"])("upgrades the saved default %s to 2.1", (model) => {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ model, voice: "cedar", tenantId: "tn_test" }) });
  expect(loadSettings()).toMatchObject({ model: "gpt-realtime-2.1", voice: "cedar", tenantId: "tn_test" });
});
it("preserves other saved models", () => {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ model: "gpt-realtime-translate" }) });
  expect(loadSettings().model).toBe("gpt-realtime-translate");
});
it("preserves a legacy model explicitly saved after the upgrade", () => {
  let stored = "{}";
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  });
  saveSettings({ ...defaults, model: "gpt-realtime-2" });
  expect(loadSettings().model).toBe("gpt-realtime-2");
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
