import type { RuntimeDataTransaction, RuntimeDataTransactionStore } from "./runtime-data-transaction.js";

interface RuntimeUpgradeCommitSteps {
  commitProfile: (dshHome: string, releaseId: string) => Promise<void>;
  commitRelease: (releaseId: string) => Promise<void>;
}

/** Once this decision is durable, every retry must finish the same commit. */
export async function commitRuntimeUpgrade(
  transaction: RuntimeDataTransaction,
  steps: RuntimeUpgradeCommitSteps
): Promise<void> {
  await transaction.markCommitDecided();
  await steps.commitProfile(transaction.record.source.dshHome, transaction.record.target.releaseId);
  await steps.commitRelease(transaction.record.target.releaseId);
  await transaction.complete();
}

/** Run before prepareForLaunch, which otherwise treats interrupted candidates as failed. */
export async function recoverRuntimeUpgrade(
  store: RuntimeDataTransactionStore,
  steps: RuntimeUpgradeCommitSteps
): Promise<void> {
  for (const recovery of await store.recover()) {
    if (recovery.kind !== "roll-forward-required") continue;
    await commitRuntimeUpgrade(await store.resume(recovery.transactionId), steps);
  }
}

/** Never move a data directory while its writer may still be alive. */
export async function restoreFailedRuntimeTrial(
  transaction: RuntimeDataTransaction | undefined,
  steps: {stopHarness: () => Promise<void>; rollbackProfile: () => Promise<void>}
): Promise<boolean> {
  await steps.stopHarness();
  if (transaction !== undefined && transaction.record.phase !== "prepared") return false;
  await steps.rollbackProfile();
  await transaction?.restorePrecommitFailure();
  return true;
}
