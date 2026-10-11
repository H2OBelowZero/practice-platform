"use client";

import { useEffect, useRef } from "react";
import { Notice } from "./notice";

/** Error summary that takes focus whenever `state` changes to a new error (pass the action state object so each submit re-focuses). */
export function FormError({ message, state }: { message?: string | null; state?: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) ref.current?.focus(); }, [message, state]);
  if (!message) return null;
  return <Notice ref={ref} tone="error" focusable>{message}</Notice>;
}
