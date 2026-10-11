export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./src/lib/scheduler");
    startScheduler();
    const { startWsServer } = await import("./src/lib/ws-server");
    startWsServer();
  }
}
