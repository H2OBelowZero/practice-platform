import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Practice Platform", template: "%s | Practice Platform" },
  description: "Online booking and client portal for a private psychology practice.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#faf8f4" };

// System font stack (see globals.css): no external font requests.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-ZA">
      <body>{children}</body>
    </html>
  );
}
