import { ActionForm } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { ProfileFields, profileValues } from "../fields";
import { updateProfile } from "../actions";
import type { TabContext } from "./tabs";

export function ProfileTab({ patient }: TabContext) {
  return (
    <Card className="max-w-3xl">
      <ActionForm action={updateProfile} args={[patient.id]} submitLabel="Save changes" pendingLabel="Saving…">
        <ProfileFields v={profileValues(patient)} />
      </ActionForm>
    </Card>
  );
}
