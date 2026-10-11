"use client";

import {
  Bot,
  Brain,
  Briefcase,
  Calendar,
  Code,
  Cpu,
  Database,
  Globe,
  Headphones,
  Lightbulb,
  LineChart,
  Mail,
  Megaphone,
  MessageSquare,
  Package,
  PenTool,
  Rocket,
  Search,
  Shield,
  ShoppingCart,
  Sparkles,
  Star,
  Target,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** Curated icon set offered in the bot avatar picker. */
export const BOT_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  sparkles: Sparkles,
  brain: Brain,
  rocket: Rocket,
  zap: Zap,
  cpu: Cpu,
  "message-square": MessageSquare,
  "line-chart": LineChart,
  "shopping-cart": ShoppingCart,
  package: Package,
  megaphone: Megaphone,
  target: Target,
  briefcase: Briefcase,
  code: Code,
  globe: Globe,
  wrench: Wrench,
  lightbulb: Lightbulb,
  star: Star,
  search: Search,
  calendar: Calendar,
  mail: Mail,
  database: Database,
  shield: Shield,
  users: Users,
  headphones: Headphones,
  "pen-tool": PenTool,
};

const BOT_COLORS = [
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-sky-500",
  "bg-rose-500",
  "bg-indigo-500",
];

export function botColor(id: number) {
  return BOT_COLORS[id % BOT_COLORS.length];
}

/**
 * Renders a bot avatar: a Lucide icon when `avatar` is "icon:<name>",
 * otherwise the emoji/letter inside a colored circle.
 */
export default function BotAvatar({
  avatar,
  botId,
  size = 28,
  className = "",
  title,
}: {
  avatar?: string;
  botId: number;
  size?: number;
  className?: string;
  title?: string;
}) {
  const iconName = avatar?.startsWith("icon:") ? avatar.slice(5) : null;
  const Icon = iconName ? BOT_ICONS[iconName] : undefined;
  return (
    <span
      title={title}
      className={`rounded-full text-white flex items-center justify-center shrink-0 ${botColor(
        botId
      )} ${className}`}
      style={{ width: size, height: size }}
    >
      {Icon ? (
        <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.42) }}>
          {avatar || "🤖"}
        </span>
      )}
    </span>
  );
}
