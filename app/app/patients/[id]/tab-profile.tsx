import { Card } from "@/components/ui/card";
import { ProfileForm } from "../edit-forms";
import { profileValues } from "../fields";
import type { TabContext } from "./tabs";

export function ProfileTab({ patient }: TabContext) {
  return (
    <Card className="max-w-3xl">
      <ProfileForm patientId={patient.id} initial={profileValues(patient)} />
    </Card>
  );
}
