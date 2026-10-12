"use client";

import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog (the workspace chrome is hidden by the print styles in globals.css). */
export function PrintButton() {
  return <Button onClick={() => window.print()}>Print receipt</Button>;
}
