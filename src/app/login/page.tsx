"use client";

import { useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n";

export default function LoginPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // Full reload: guarantees the just-set session cookie is sent,
        // even in restrictive in-app browsers/webviews.
        window.location.href = "/chat";
        return;
      }
      setError(t("loginFailed"));
    } catch {
      setError(t("loginFailed"));
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-8"
      >
        <h1 className="text-2xl font-semibold text-center">{t("appName")}</h1>
        <input
          type="email"
          required
          placeholder={t("email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 outline-none focus:ring-2 focus:ring-zinc-500"
        />
        <input
          type="password"
          required
          placeholder={t("password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 outline-none focus:ring-2 focus:ring-zinc-500"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 py-2 font-medium hover:opacity-90 disabled:opacity-50"
        >
          {t("login")}
        </button>
        <p className="text-sm text-center text-zinc-500">
          {t("noAccount")}{" "}
          <Link href="/register" className="underline">
            {t("register")}
          </Link>
        </p>
      </form>
    </div>
  );
}
