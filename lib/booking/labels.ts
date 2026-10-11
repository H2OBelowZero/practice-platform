export const FORMAT_LABEL: Record<string, string> = { in_person: "In person", video: "Video session" };
export const formatLabel = (f: string) => FORMAT_LABEL[f] ?? f;
export const durationLabel = (min: number) => `${min} minutes`;
