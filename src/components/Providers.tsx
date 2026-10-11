"use client";

import { ReactNode } from "react";
import { LangProvider } from "@/lib/i18n";

export default function Providers({ children }: { children: ReactNode }) {
  return <LangProvider>{children}</LangProvider>;
}
