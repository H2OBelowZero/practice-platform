import type { MetadataRoute } from "next";

// Colours are the globals.css tokens: canvas #f7f3ea (background) and sage-900 #173a2f (theme). No service worker: not an offline app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Practice Platform",
    short_name: "Practice",
    description: "Online booking and client portal for a private psychology practice.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f3ea",
    theme_color: "#173a2f",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
