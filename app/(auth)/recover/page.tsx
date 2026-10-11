import { RecoverForm } from "./recover-form";

export const metadata = { title: "Reset password" };

export default function RecoverPage() {
  return (
    <>
      <h1 className="mb-5">Reset your password</h1>
      <RecoverForm />
    </>
  );
}
