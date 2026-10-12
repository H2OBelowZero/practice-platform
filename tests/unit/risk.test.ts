import { it, expect } from "vitest";
import { riskSource, riskTask } from "@/lib/notes/risk";

it("creates a professional-assessment task for moderate and high risk only", () => {
  expect(riskTask({ level: "none" })).toBeNull();
  expect(riskTask({ level: "low" })).toBeNull();
  expect(riskTask({})).toBeNull();
  expect(riskTask({ level: "high" })?.title).toMatch(/professional assessment/i);
  expect(riskTask({ level: "moderate" })?.priority).toBe("high");
});

it("the task never carries the risk notes or any diagnosis wording", () => {
  const t = riskTask({ level: "high", notes: "private clinical detail xyz" });
  expect(JSON.stringify(t)).not.toMatch(/xyz|private/);
  expect(t?.title).not.toMatch(/diagnos|suicid|depress/i);
});

it("the source marker is one per note and level, ids only", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(riskSource(id, "high")).toBe(`risk_flag:${id}:high`);
  expect(riskSource(id, "moderate")).not.toBe(riskSource(id, "high"));
});
