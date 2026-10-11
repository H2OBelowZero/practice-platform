import { requireRecoverySession } from "@/lib/auth/session";
import { ResetForm } from "./reset-form";

export const metadata = { title: "Choose a new password" };

export default async function ResetPage() {
  // Only reachable through the emailed link (fresh recovery session); staff are sent to /mfa first.
  await requireRecoverySession();
  return (
    <>
      <h1 className="mb-5">Choose a new password</h1>
      <ResetForm />
    </>
  );
}
