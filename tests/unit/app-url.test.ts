import { it, expect, afterEach, vi } from "vitest";
import { appUrl } from "@/lib/app-url";

afterEach(() => vi.unstubAllEnvs());

it("uses APP_URL without a trailing slash", () => {
  vi.stubEnv("APP_URL", "https://practice.example.co.za/");
  expect(appUrl()).toBe("https://practice.example.co.za");
});
it("falls back to localhost outside production", () => {
  vi.stubEnv("APP_URL", ""); vi.stubEnv("NODE_ENV", "development");
  expect(appUrl()).toBe("http://localhost:3000");
});
it("throws in production when APP_URL is unset", () => {
  vi.stubEnv("APP_URL", ""); vi.stubEnv("NODE_ENV", "production");
  expect(() => appUrl()).toThrow(/APP_URL/);
});
