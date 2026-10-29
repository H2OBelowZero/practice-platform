import type { MetadataRoute } from "next";

// Colours are the globals.css tokens: canvas #f7f3ea (background) and sage-900 #173a2f (theme). No service worker: not an offline app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dr. Nkala Psychology and Consulting Practice",
    short_name: "Dr. Nkala",
    description: "Trauma-informed psychotherapy in Randburg, Johannesburg, Sandton and Gauteng. Book online and manage your forms and payments.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f3ea",
    theme_color: "#173a2f",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
