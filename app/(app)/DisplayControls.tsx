"use client";

import { useEffect, useState, useTransition } from "react";
import { setQuickHideValues } from "./actions";

type Theme = "system" | "light" | "dark";

export function DisplayControls({
  profileId,
  initialTheme,
  initialHidden,
}: {
  profileId: string;
  initialTheme: Theme;
  initialHidden: boolean;
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    document.documentElement.dataset.theme = initialTheme;
    document.documentElement.dataset.moneyHidden = String(initialHidden);

  }, [initialHidden, initialTheme, profileId]);

  function toggle() {
    const previous = hidden;
    const next = !previous;
    setHidden(next);
    document.documentElement.dataset.moneyHidden = String(next);
    startTransition(async () => {
      try {
        await setQuickHideValues(profileId, next);
      } catch {
        setHidden(previous);
        document.documentElement.dataset.moneyHidden = String(previous);
      }
    });
  }

  const label = hidden ? "Mostrar valores" : "Ocultar valores";
  return (
    <button
      type="button"
      className="icon-control"
      onClick={toggle}
      disabled={isPending}
      aria-pressed={hidden}
      aria-label={label}
      title={label}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="2.8" />
        {hidden && <path d="m4 4 16 16" />}
      </svg>
    </button>
  );
}