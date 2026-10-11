import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Per-request Supabase client acting as the signed-in user (anon key + session cookies; RLS applies). */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        // Server Components cannot set cookies; middleware refreshes the session, so ignoring is safe there.
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {}
      },
    },
  });
}

/** Belt and braces for fail-closed paths: drop every Supabase auth cookie even if signOut() failed. */
export async function clearAuthCookies() {
  const store = await cookies();
  for (const { name } of store.getAll()) if (name.startsWith("sb-")) { try { store.delete(name); } catch {} }
}
