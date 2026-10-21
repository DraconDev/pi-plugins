import { purgeExpiredQuarantine, runCleanup } from "./index.ts";

const purge = await purgeExpiredQuarantine();

if (purge.locked) {
	console.log("Pi session-retention purge skipped: another retention operation is running.");
} else if (purge.purgedRuns > 0) {
	console.log(`Pi session-retention purged ${purge.purgedRuns} expired quarantine run(s).`);
}

// The timer is the only enforcement point while no Pi process is running, so
// it applies the full policy (age cutoff, name protection, delete mode) too.
const cleanup = await runCleanup();

if (cleanup.locked) {
	console.log("Pi session-retention cleanup skipped: another retention operation is running.");
} else if (cleanup.failed > 0) {
	console.log(`Pi session-retention cleanup failed for ${cleanup.failed} file(s).`);
} else if (cleanup.moved > 0) {
	const gb = cleanup.quarantinedBytes / 1_000_000_000;
	console.log(
		`Pi session-retention removed ${cleanup.moved} stale session file(s) (${gb.toFixed(2)} GB).`,
	);
}
