export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { acquireServerLock } = await import("./lib/ai/server-lock.ts");
    await acquireServerLock();
  }
}
