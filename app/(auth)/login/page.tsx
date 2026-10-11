import { safeNext } from "@/lib/auth/redirect";
import { Notice } from "../ui";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in - Practice Platform" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; reset?: string }> }) {
  const { next, error, reset } = await searchParams;
  const safe = safeNext(next, "");
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Sign in</h1>
      {reset === "1" && <Notice>Your password was changed. Sign in with your new password.</Notice>}
      {error === "link" && <Notice>That link is invalid or has expired. Request a new one from &quot;Forgotten your password?&quot;.</Notice>}
      <LoginForm next={safe || undefined} />
    </>
  );
}
