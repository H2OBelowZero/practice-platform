import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser } from "./helpers";

const signup = async (c: Client, email: string | null, meta: object | null) =>
  (await c.query(
    "insert into auth.users(id,email,instance_id,aud,role,raw_user_meta_data) values (gen_random_uuid(), $1, '00000000-0000-0000-0000-000000000000','authenticated','authenticated', $2::jsonb) returning id",
    [email, meta === null ? null : JSON.stringify(meta)])).rows[0].id as string;
const profile = async (c: Client, id: string) =>
  (await c.query("select role, display_name from profiles where user_id=$1", [id])).rows;

it("signup always creates a patient profile and ignores any role in user metadata", () => withClient(async (c) => {
  for (const role of ["psychologist", "admin", "bookkeeper", "associate", "guardian", "patient", "nonsense"]) {
    const id = await signup(c, `${role}@t.test`, { role, name: "Eve", user_role: role });
    expect(await profile(c, id), role).toEqual([{ role: "patient", display_name: "Eve" }]);
  }
}));

it("signup display_name falls back to the email local part, then a default", () => withClient(async (c) => {
  expect(await profile(c, await signup(c, "sam@t.test", null))).toEqual([{ role: "patient", display_name: "sam" }]);
  expect(await profile(c, await signup(c, "kim@t.test", { name: "   " }))).toEqual([{ role: "patient", display_name: "kim" }]);
  expect(await profile(c, await signup(c, null, null))).toEqual([{ role: "patient", display_name: "Patient" }]);
}));

it("the trigger function cannot be called directly by signed-in users", () => withClient(async (c) => {
  const id = await signup(c, "x@t.test", null);
  await asUser(c, id, async () => {
    await expect(c.query("select handle_new_user()")).rejects.toThrow(/permission denied for function handle_new_user/);
  });
}));
