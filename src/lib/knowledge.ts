import db from "./db";

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // prefer cutting at paragraph/sentence boundary
      const para = clean.lastIndexOf("\n\n", end);
      const sent = clean.lastIndexOf(". ", end);
      if (para > start + CHUNK_SIZE / 2) end = para;
      else if (sent > start + CHUNK_SIZE / 2) end = sent + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    start = end - (end < clean.length ? CHUNK_OVERLAP : 0);
    if (start <= 0) start = end;
  }
  return chunks.filter((c) => c.length > 20);
}

export function addDocument(botId: number, name: string, content: string) {
  const r = db
    .prepare("INSERT INTO bot_documents (bot_id, name) VALUES (?, ?)")
    .run(botId, name);
  const docId = Number(r.lastInsertRowid);
  const chunks = chunkText(content);
  const insChunk = db.prepare(
    "INSERT INTO bot_doc_chunks (document_id, bot_id, chunk_index, content) VALUES (?, ?, ?, ?)"
  );
  const insFts = db.prepare(
    "INSERT INTO bot_chunks_fts (rowid, content) VALUES (?, ?)"
  );
  chunks.forEach((c, i) => {
    const rc = insChunk.run(docId, botId, i, c);
    try {
      insFts.run(rc.lastInsertRowid, c);
    } catch {
      // FTS unavailable
    }
  });
  return { id: docId, chunks: chunks.length };
}

export function deleteDocument(docId: number, botId: number) {
  const ids = db
    .prepare("SELECT id FROM bot_doc_chunks WHERE document_id = ?")
    .all(docId) as { id: number }[];
  const del = db.prepare("DELETE FROM bot_chunks_fts WHERE rowid = ?");
  for (const { id } of ids) {
    try {
      del.run(id);
    } catch {
      // ignore
    }
  }
  db.prepare("DELETE FROM bot_documents WHERE id = ? AND bot_id = ?").run(
    docId,
    botId
  );
}

export function listDocuments(botId: number) {
  return db
    .prepare(
      `SELECT d.id, d.name, d.created_at,
              (SELECT COUNT(*) FROM bot_doc_chunks c WHERE c.document_id = d.id) AS chunks
       FROM bot_documents d WHERE d.bot_id = ? ORDER BY d.id DESC`
    )
    .all(botId);
}

/**
 * Keyword retrieval over a bot's knowledge chunks.
 * Returns top-N chunks relevant to the query.
 */
export function searchChunks(
  botId: number,
  query: string,
  limit = 5
): string[] {
  // Build an FTS5 OR-query from alphanumeric words
  const words = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 12);
  if (!words.length) return [];

  try {
    const ftsQuery = words.map((w) => `"${w}"`).join(" OR ");
    const rows = db
      .prepare(
        `SELECT c.content FROM bot_chunks_fts f
         JOIN bot_doc_chunks c ON c.id = f.rowid
         WHERE bot_chunks_fts MATCH ? AND c.bot_id = ?
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, botId, limit) as { content: string }[];
    return rows.map((r) => r.content);
  } catch {
    // Fallback: naive LIKE scoring
    const rows = db
      .prepare("SELECT id, content FROM bot_doc_chunks WHERE bot_id = ?")
      .all(botId) as { id: number; content: string }[];
    const scored = rows
      .map((r) => ({
        content: r.content,
        score: words.filter((w) =>
          r.content.toLowerCase().includes(w.toLowerCase())
        ).length,
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((s) => s.content);
  }
}
