import { purgeExpiredQuarantine } from "./index.ts";

const result = await purgeExpiredQuarantine();

if (result.locked) {
	console.log("Pi session-retention purge skipped: another retention operation is running.");
} else if (result.purgedRuns > 0) {
	console.log(`Pi session-retention purged ${result.purgedRuns} expired quarantine run(s).`);
}
