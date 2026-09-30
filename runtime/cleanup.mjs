import { initialize } from './initialize.mjs';
const { env } = await initialize({ database: false });
const r = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 3000)}/api/cleanup`, {
  method: 'POST',
  headers: { 'x-cleanup-key': env.CLEANUP_SECRET },
  signal: AbortSignal.timeout(55000),
});
if (!r.ok) {
  console.error(JSON.stringify({ event: 'cleanup-failed', status: r.status }));
  process.exitCode = 1;
} else {
  const result = await r.json();
  console.log(
    JSON.stringify({
      event: 'cleanup-complete',
      deletedFiles: result.deletedFiles,
      finalized: result.finalized,
    }),
  );
}
