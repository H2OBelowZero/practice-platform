/** Public origin used in emailed links. Production must set APP_URL: never silently email localhost links. */
export function appUrl(): string {
  const url = process.env.APP_URL;
  if (url) return url.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") throw new Error("APP_URL must be set in production");
  return "http://localhost:3000";
}
