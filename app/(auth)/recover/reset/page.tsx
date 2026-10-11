import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { ResetForm } from "./reset-form";

export const metadata = { title: "Choose a new password - Practice Platform" };

export default async function ResetPage() {
  // Reached through the emailed link -> /auth/callback, which signs the user in with a recovery session.
  if (!(await currentUser())) redirect("/login?error=link");
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Choose a new password</h1>
      <ResetForm />
    </>
  );
}
