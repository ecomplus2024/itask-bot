import db from "./db";

/**
 * Builds the skills addendum for the system prompt from a user's
 * enabled skills.
 */
export function getSkillsPrompt(userId: number): string {
  const rows = db
    .prepare(
      `SELECT name, content FROM skills
       WHERE user_id = ? AND enabled = 1 ORDER BY id`
    )
    .all(userId) as { name: string; content: string }[];
  if (!rows.length) return "";
  return (
    "\n\n## Active skills\n" +
    rows.map((s) => `### ${s.name}\n${s.content}`).join("\n\n")
  );
}
