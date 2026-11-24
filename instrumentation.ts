export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startRemediationWorker } = await import("@/lib/server/remediation-jobs");
    startRemediationWorker();
    const { startAutomaticScanWorker } = await import("@/lib/server/automatic-scans");
    startAutomaticScanWorker();
  }
}
