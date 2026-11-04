// Only retry a first build when GitHub history proves the immutable-output
// boundary was never crossed. Missing or ambiguous evidence fails closed.
export function neverProduced(jobs, platform) {
  const publication = platform === 'publication';
  const candidates = jobs.filter(j => publication ? j.name === 'publish' : j.name === 'build' || j.name.startsWith(`build (${platform},`));
  if (candidates.length !== 1) return false;
  const job = candidates[0];
  if (job.status !== 'completed') return false;
  if (job.conclusion === 'skipped' && (job.steps ?? []).length === 0) return true;
  const steps = job.steps ?? [];
  const name = publication ? 'Run node scripts/ci/restore.mjs publication' : `Run node scripts/ci/restore.mjs ${platform}`;
  const gate = steps.findIndex(s => s.name === name);
  if (gate < 0 || !['failure', 'cancelled', 'skipped'].includes(steps[gate].conclusion)) return false;
  return steps.slice(gate + 1).every(s => s.conclusion === 'skipped' || s.name.startsWith('Post ') || s.name.startsWith('通知') || s.name === 'Complete job');
}

export async function canStartFirstBuild({ batch, runID, attempt, artifacts, platform, loadJobs }) {
  if (!['macos', 'windows', 'publication'].includes(platform) || batch.run_id !== runID || batch.status !== 'reserved' || batch.payload_digest || artifacts.length || !Number.isSafeInteger(attempt) || attempt < 1) return false;
  for (let previous = 1; previous < attempt; previous++) {
    if (!neverProduced(await loadJobs(previous), platform)) return false;
  }
  return true;
}
