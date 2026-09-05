import { afterEach, expect, it, vi } from "vitest";
import { defaults, loadSettings, saveSettings } from "./Settings";
afterEach(() => vi.unstubAllGlobals());
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
