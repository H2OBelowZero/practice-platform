import { ImageResponse } from "next/og";
import { BRAND, SERVICE_AREAS } from "@/lib/site";

export const alt = "Trauma-informed psychotherapy in Johannesburg, Sandton and Gauteng";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Share card for WhatsApp, Facebook, LinkedIn and Google. Colours are the globals.css tokens: sage-900 #173a2f, ivory #f7f3ea, gold.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#173a2f", color: "#f7f3ea", padding: 80 }}>
        <div style={{ display: "flex", fontSize: 30, letterSpacing: 4, textTransform: "uppercase", color: "#d9b96a" }}>{BRAND}</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 76, lineHeight: 1.1, fontWeight: 700 }}>Psychologist in Johannesburg &amp; Sandton</div>
          <div style={{ display: "flex", marginTop: 24, fontSize: 34, color: "#cfd9d3" }}>Trauma-informed therapy. Book online.</div>
        </div>
        <div style={{ display: "flex", fontSize: 26, color: "#d9b96a" }}>{SERVICE_AREAS.slice(0, 5).join("  ·  ")}</div>
      </div>
    ),
    size,
  );
}
