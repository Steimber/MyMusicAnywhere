export async function register() {
  if (
    typeof process !== 'undefined' &&
    (!process.env.NEXT_RUNTIME || process.env.NEXT_RUNTIME === 'nodejs') &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    const { runStartupMigrations } = await import('./lib/store.js');
    const { ensureUploadCleanupScheduler } = await import('./lib/upload.js');
    runStartupMigrations();
    ensureUploadCleanupScheduler();
  }
}
