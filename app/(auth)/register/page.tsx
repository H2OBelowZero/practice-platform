import { safeNext } from "@/lib/auth/redirect";
import { Panel } from "@/components/ui/card";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Create an account" };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next, "");
  return (
    <>
      <h1 className="mb-3">Create an account</h1>
      <p className="mb-5 text-ink-muted">An account lets you book appointments and use the patient portal.</p>
      <Panel className="mb-6 text-sm">
        <p><strong>Your privacy.</strong> Creating an account does not give consent to anything else. The practice will ask separately, through forms, for any consents it needs, such as treatment or sharing information. We use your name and email only to run your account.</p>
      </Panel>
      <RegisterForm next={next || undefined} />
    </>
  );
}
