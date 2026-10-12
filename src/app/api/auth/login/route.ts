import { NextRequest, NextResponse } from "next/server";
import { verifyUser, createSession, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { username, email, password } = await req.json();
  const login = (username || email || "").trim();
  if (!login || !password) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }
  const user = verifyUser(login, password);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid username or password" },
      { status: 401 }
    );
  }
  const token = createSession(user.id);
  await setSessionCookie(token);
  return NextResponse.json({ user });
}
