import { createBrowserClient } from "@supabase/ssr";

/** Browser client (anon key only). Never import the service client from client components. */
export const supabaseBrowser = () =>
  createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
