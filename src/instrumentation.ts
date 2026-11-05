export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.DATABASE_URL) return;
  const { startClock } = await import('@/server/clock');
  startClock();
}
