import { RecoverForm } from "./recover-form";

export const metadata = { title: "Reset password - Practice Platform" };

export default function RecoverPage() {
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Reset your password</h1>
      <RecoverForm />
    </>
  );
}
