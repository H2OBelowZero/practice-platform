// A fake "RLS-filtered" Supabase client for page and action tests. Every chained call is recorded; awaiting the chain (or .single()/.maybeSingle())
// asks `resolve` what the query returns, given the table (or "rpc:<name>") and the recorded calls. No database, no filtering: the test decides.
export type Call = { m: string; a: unknown[] };
export type Result = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number | null };
export type Query = { table: string; calls: Call[] };

export const called = (q: Query, method: string, ...args: unknown[]): boolean =>
  q.calls.some((c) => c.m === method && args.every((x, i) => JSON.stringify(c.a[i]) === JSON.stringify(x)));

export function fakeSupabase(resolve: (q: Query) => Result, log: Query[] = []) {
  const make = (table: string) => {
    const q: Query = { table, calls: [] };
    log.push(q);
    const result = () => { const r = resolve(q); return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }; };
    const proxy: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => { try { return Promise.resolve(result()).then(ok, bad); } catch (e) { return bad(e); } };
        if (prop === "maybeSingle" || prop === "single") return async () => { const r = result(); return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }; };
        return (...a: unknown[]) => { q.calls.push({ m: prop, a }); return proxy; };
      },
    });
    return proxy;
  };
  return { from: (t: string) => make(t), rpc: (name: string, args?: unknown) => { const p = make(`rpc:${name}`); log[log.length - 1].calls.push({ m: "rpc", a: [args] }); return p; }, queries: log };
}
