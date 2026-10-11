// In-memory "bot is thinking" registry — lets the UI show activity
// indicators even when the client isn't connected to the stream.
const running = new Set<number>();

export function markBotRunning(id: number) {
  running.add(id);
}
export function unmarkBotRunning(id: number) {
  running.delete(id);
}
export function isBotRunning(id: number) {
  return running.has(id);
}
