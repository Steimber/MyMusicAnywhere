export async function register() {
  if (typeof process !== 'undefined' && (!process.env.NEXT_RUNTIME || process.env.NEXT_RUNTIME === 'nodejs')) {
    const { ensureUploadCleanupScheduler } = await import('./lib/upload.js');
    ensureUploadCleanupScheduler();
  }
}
