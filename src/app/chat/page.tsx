import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import ChatApp from "@/components/ChatApp";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <ChatApp user={user} />;
}
