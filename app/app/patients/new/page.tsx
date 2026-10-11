import { requireRole } from "@/lib/auth/session";
import { LinkButton } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { NewPatientForm } from "./new-patient-form";

export const metadata = { title: "New patient" };

export default async function NewPatientPage() {
  await requireRole(["psychologist", "admin"]);
  return (
    <>
      <PageHeader title="New patient" description="Only a first and last name are needed. The rest can be added later. We check for people already on file before saving." />
      <div className="max-w-3xl">
        <NewPatientForm />
        <p className="mt-8"><LinkButton href="/app/patients" variant="quiet">Back to patients</LinkButton></p>
      </div>
    </>
  );
}
