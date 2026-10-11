import { NextRequest, NextResponse } from "next/server";
import { verifyUser, createSession, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();
  if (!email || !password) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }
  const user = verifyUser(email, password);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid email or password" },
      { status: 401 }
    );
  }
  const token = createSession(user.id);
  await setSessionCookie(token);
  return NextResponse.json({ user });
}
