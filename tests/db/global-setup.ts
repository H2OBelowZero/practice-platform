// vitest globalSetup for the db project: throwaway Postgres (embedded-postgres, real binaries, no Docker).
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "supabase");

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  s.on("error", rej);
});

export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pp-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, onLog: () => {}, onError: () => {} });
  const cleanup = async () => { await pg.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true }); };
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("test");

    const c = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "test" });
    await c.connect();
    try {
      const files = [
        join(root, "test_bootstrap.sql"),
        ...readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => join(root, "migrations", f)),
      ];
      for (const f of files) {
        try { await c.query(readFileSync(f, "utf8")); }
        catch (e) { throw new Error(`applying ${f}: ${(e as Error).message}`); }
      }
    } finally { await c.end(); }
  } catch (e) { await cleanup(); throw e; }

  process.env.DATABASE_URL_TEST = `postgres://postgres:postgres@localhost:${port}/test`;
  return cleanup;
}
