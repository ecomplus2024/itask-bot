import crypto from "crypto";
import { cookies } from "next/headers";
import db from "./db";

const SESSION_COOKIE = "itask_session";
const SESSION_DAYS = 30;

export function hashPassword(password: string, salt: string): string {
  // Normalize so the same password typed on different keyboards/OSes
  // (NFC vs NFD composed Vietnamese diacritics) hashes identically.
  return crypto.scryptSync(password.normalize("NFC"), salt, 64).toString("hex");
}

export function createUser(email: string, name: string, password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const stmt = db.prepare(
    "INSERT INTO users (email, name, password_hash, salt) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(email.toLowerCase().trim(), name.trim(), hash, salt);
  return { id: Number(result.lastInsertRowid), email, name };
}

export function verifyUser(email: string, password: string) {
  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) as
    | { id: number; email: string; name: string; password_hash: string; salt: string }
    | undefined;
  if (!user) return null;
  const expected = Buffer.from(user.password_hash, "hex");
  // Try normalized first, then the raw form for passwords stored before
  // normalization was applied.
  for (const candidate of [password.normalize("NFC"), password]) {
    const hash = crypto.scryptSync(candidate, user.salt, 64);
    if (crypto.timingSafeEqual(hash, expected)) {
      return { id: user.id, email: user.email, name: user.name };
    }
  }
  return null;
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(token, userId, expiresAt);
  return token;
}

export function destroySession(token: string) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export async function getSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

export async function getCurrentUser() {
  const token = await getSessionToken();
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token) as { id: number; email: string; name: string } | undefined;
  return row ?? null;
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
