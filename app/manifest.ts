import type { MetadataRoute } from "next";

// Colours are the globals.css tokens: canvas #faf8f4 (background) and sage-700 #3f5f4d (theme). No service worker: not an offline app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Practice Platform",
    short_name: "Practice",
    description: "Online booking and client portal for a private psychology practice.",
    start_url: "/",
    display: "standalone",
    background_color: "#faf8f4",
    theme_color: "#3f5f4d",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
