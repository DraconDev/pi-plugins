import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi has no automatic history retention. This extension deliberately works on
// the filesystem instead of SessionManager.listAll(): listAll builds the full
// transcript text for every session, which is unnecessarily expensive for a
// large history and can exhaust memory.

export const SESSION_ROOT_NAME = "sessions";
export const QUARANTINE_ROOT_NAME = "session-retention-quarantine";
export const LOCK_DIRECTORY_NAME = ".session-retention-lock";
export const ACTIVE_DIRECTORY_NAME = ".session-retention-active";

const HEADER_READ_BYTES = 16 * 1024;
const TAIL_READ_BYTES = 64 * 1024;
const SCAN_CONCURRENCY = 24;
const MOVE_CONCURRENCY = 12;
const LOCK_STALE_MS = 30 * 60 * 1000;

export interface RetentionPolicy {
	/** Remove sessions that have not changed for at least this many days. */
	maxAgeDays: number;
	/** Keep this many newest sessions per project before high-churn pruning applies. */
	keepPerProject: number;
	/** Only apply the per-project cap to sessions at least this old. */
	capAfterDays: number;
	/** Never touch anything modified within this grace period. */
	protectRecentDays: number;
	/** Old sessions at or below this size are treated as abandoned/spammy. */
	tinyBytes: number;
	/** Tiny-session cleanup is enabled at or after this age. */
	tinyAfterDays: number;
	/** Quarantine runs older than this are permanently purged. */
	quarantineDays: number;
	dryRun: boolean;
}

export const DEFAULT_POLICY: RetentionPolicy = {
	maxAgeDays: 30,
	keepPerProject: 10,
	capAfterDays: 7,
	protectRecentDays: 2,
	tinyBytes: 16 * 1024,
	tinyAfterDays: 7,
	quarantineDays: 14,
	dryRun: false,
};

export type CleanupReason = "max-age" | "project-cap" | "tiny";

export interface SessionRecord {
	file: string;
	projectDir: string;
	cwd: string | undefined;
	parentSessionPath: string | undefined;
	name: string | undefined;
	modifiedMs: number;
	size: number;
	ageDays: number;
	projectRank: number;
}

export interface CleanupCandidate extends SessionRecord {
	reason: CleanupReason;
}

export interface CleanupSummary {
	scanned: number;
	planned: number;
	moved: number;
	bytes: number;
	quarantinedBytes: number;
	failed: number;
	protectedByName: number;
	protectedByParent: number;
	purgedRuns: number;
	dryRun: boolean;
	locked: boolean;
	quarantineRoot: string;
	candidates: CleanupCandidate[];
	errors: string[];
}

interface SessionHeaderRecord {
	type?: unknown;
	id?: unknown;
	cwd?: unknown;
	parentSession?: unknown;
	timestamp?: unknown;
}

interface DiscoveredSession extends SessionRecord {
	prefix: string;
}

export interface CleanupOptions {
	agentDir?: string;
	sessionRoot?: string;
	currentSessionFile?: string;
	protectedSessionFiles?: string[];
	policy?: Partial<RetentionPolicy>;
	protectedFragments?: string[];
}

interface ManifestRecord {
	originalPath: string;
	quarantinedPath: string;
	size: number;
	ageDays: number;
	reason: CleanupReason;
	cwd?: string;
	name?: string;
}

function resolveAgentDir(): string {
	return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

function parseNumberEnv(name: string, fallback: number, minimum = 0): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < minimum) return fallback;
	return value;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return fallback;
}

export function readPolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
	const nonNegative = (value: number, fallback: number): number =>
		Number.isFinite(value) && value >= 0 ? value : fallback;
	const maxAgeDays = nonNegative(
		overrides.maxAgeDays ?? parseNumberEnv("PI_SESSION_RETENTION_MAX_AGE_DAYS", DEFAULT_POLICY.maxAgeDays),
		DEFAULT_POLICY.maxAgeDays,
	);
	const keepPerProject = Math.floor(
		nonNegative(
			overrides.keepPerProject ??
				parseNumberEnv("PI_SESSION_RETENTION_KEEP_PER_PROJECT", DEFAULT_POLICY.keepPerProject),
			DEFAULT_POLICY.keepPerProject,
		),
	);
	const capAfterDays = nonNegative(
		overrides.capAfterDays ?? parseNumberEnv("PI_SESSION_RETENTION_CAP_AFTER_DAYS", DEFAULT_POLICY.capAfterDays),
		DEFAULT_POLICY.capAfterDays,
	);
	const protectRecentDays = nonNegative(
		overrides.protectRecentDays ??
			parseNumberEnv("PI_SESSION_RETENTION_PROTECT_RECENT_DAYS", DEFAULT_POLICY.protectRecentDays),
		DEFAULT_POLICY.protectRecentDays,
	);
	const tinyBytes = Math.floor(
		nonNegative(
			overrides.tinyBytes ?? parseNumberEnv("PI_SESSION_RETENTION_TINY_BYTES", DEFAULT_POLICY.tinyBytes),
			DEFAULT_POLICY.tinyBytes,
		),
	);
	const tinyAfterDays = nonNegative(
		overrides.tinyAfterDays ??
			parseNumberEnv("PI_SESSION_RETENTION_TINY_AFTER_DAYS", DEFAULT_POLICY.tinyAfterDays),
		DEFAULT_POLICY.tinyAfterDays,
	);
	const quarantineDays = nonNegative(
		overrides.quarantineDays ??
			parseNumberEnv("PI_SESSION_RETENTION_QUARANTINE_DAYS", DEFAULT_POLICY.quarantineDays),
		DEFAULT_POLICY.quarantineDays,
	);
	return {
		maxAgeDays,
		keepPerProject,
		capAfterDays,
		protectRecentDays,
		tinyBytes,
		tinyAfterDays,
		quarantineDays,
		dryRun: overrides.dryRun ?? parseBooleanEnv("PI_SESSION_RETENTION_DRY_RUN", DEFAULT_POLICY.dryRun),
	};
}

function envProtectedFragments(): string[] {
	return (process.env.PI_SESSION_RETENTION_PROTECT || "")
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
}

function isPathInside(child: string, parent: string): boolean {
	const childPath = resolve(child);
	const parentPath = resolve(parent);
	return childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`);
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (!trimmed || !trimmed.startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function extractNameFromText(text: string): string | undefined {
	let latest: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		if (entry.type !== "session_info" && entry.type !== "title") continue;
		const value = entry.name ?? entry.title;
		latest = typeof value === "string" && value.trim() ? value.trim() : undefined;
	}
	return latest;
}

async function readSlice(file: string, position: number, length: number): Promise<string> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const result = await handle.read(buffer, 0, length, position);
		return buffer.subarray(0, result.bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

async function readPrefix(file: string): Promise<{ header: SessionHeaderRecord; prefix: string } | undefined> {
	try {
		const prefix = await readSlice(file, 0, HEADER_READ_BYTES);
		const newline = prefix.indexOf("\n");
		const firstLine = (newline === -1 ? prefix : prefix.slice(0, newline)).replace(/^\uFEFF/, "");
		const header = parseJsonLine(firstLine);
		if (header?.type !== "session" || typeof header.id !== "string") return undefined;
		return { header, prefix };
	} catch {
		return undefined;
	}
}

async function readTail(file: string, size: number): Promise<string> {
	try {
		return await readSlice(file, Math.max(0, size - TAIL_READ_BYTES), Math.min(size, TAIL_READ_BYTES));
	} catch {
		return "";
	}
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function run(): Promise<void> {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run()));
	return results;
}

async function sessionFiles(sessionRoot: string): Promise<Array<{ file: string; projectDir: string }>> {
	const files: Array<{ file: string; projectDir: string }> = [];
	let projectEntries: Dirent[];
	try {
		projectEntries = await readdir(sessionRoot, { withFileTypes: true });
	} catch {
		return files;
	}

	const projects = projectEntries.filter((entry) => entry.isDirectory());
	const perProject = await mapWithConcurrency(projects, SCAN_CONCURRENCY, async (project) => {
		const projectPath = join(sessionRoot, project.name);
		try {
			const entries = await readdir(projectPath, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => ({ file: join(projectPath, entry.name), projectDir: project.name }));
		} catch {
			return [];
		}
	});
	return perProject.flat();
}

export async function discoverSessions(sessionRoot: string, nowMs = Date.now()): Promise<SessionRecord[]> {
	const files = await sessionFiles(sessionRoot);
	const discovered = await mapWithConcurrency(files, SCAN_CONCURRENCY, async ({ file, projectDir }) => {
		try {
			const fileStat = await stat(file);
			const parsed = await readPrefix(file);
			if (!parsed) return undefined;
			const header = parsed.header;
			const cwd = typeof header.cwd === "string" ? header.cwd : undefined;
			const parentSessionPath =
				typeof header.parentSession === "string" ? header.parentSession : undefined;
			return {
				file,
				projectDir,
				cwd,
				parentSessionPath,
				name: extractNameFromText(parsed.prefix),
				modifiedMs: fileStat.mtimeMs,
				size: fileStat.size,
				ageDays: Math.max(0, (nowMs - fileStat.mtimeMs) / 86_400_000),
				projectRank: 0,
				prefix: parsed.prefix,
			} satisfies DiscoveredSession;
		} catch {
			return undefined;
		}
	});

	const valid = discovered.filter((value): value is DiscoveredSession => value !== undefined);
	const grouped = new Map<string, DiscoveredSession[]>();
	for (const session of valid) {
		const group = grouped.get(session.projectDir) ?? [];
		group.push(session);
		grouped.set(session.projectDir, group);
	}
	for (const group of grouped.values()) {
		group.sort((a, b) => b.modifiedMs - a.modifiedMs || a.file.localeCompare(b.file));
		group.forEach((session, index) => {
			session.projectRank = index;
		});
	}
	return valid;
}

function matchesProtectedFragment(session: SessionRecord, fragments: string[]): boolean {
	if (fragments.length === 0) return false;
	const haystack = [session.file, session.projectDir, session.cwd || ""].join("\n").toLowerCase();
	return fragments.some((fragment) => haystack.includes(fragment));
}

function parentPathCandidates(parent: string, sessionRoot: string): string[] {
	if (isAbsolute(parent)) return [resolve(parent)];
	return [resolve(parent), resolve(sessionRoot, parent)];
}

interface ActiveSessionMarker {
	pid: number;
	sessionFile: string;
	startedAt: string;
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function writeActiveSessionMarker(agentDir: string, sessionFile: string | undefined): Promise<void> {
	if (!sessionFile) return;
	try {
		const activeDir = join(agentDir, ACTIVE_DIRECTORY_NAME);
		await mkdir(activeDir, { recursive: true });
		const marker: ActiveSessionMarker = {
			pid: process.pid,
			sessionFile: resolve(sessionFile),
			startedAt: new Date().toISOString(),
		};
		await writeFile(join(activeDir, `${process.pid}.json`), `${JSON.stringify(marker)}\n`);
	} catch {
		// A marker is only an additional safety net; failure must not stop Pi.
	}
}

async function removeActiveSessionMarker(agentDir: string): Promise<void> {
	await rm(join(agentDir, ACTIVE_DIRECTORY_NAME, `${process.pid}.json`), { force: true }).catch(() => undefined);
}

async function readActiveSessionFiles(agentDir: string): Promise<Set<string>> {
	const activeFiles = new Set<string>();
	const activeDir = join(agentDir, ACTIVE_DIRECTORY_NAME);
	let entries: Dirent[];
	try {
		entries = await readdir(activeDir, { withFileTypes: true });
	} catch {
		return activeFiles;
	}
	await mapWithConcurrency(
		entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")),
		SCAN_CONCURRENCY,
		async (entry) => {
			const markerPath = join(activeDir, entry.name);
			try {
				const marker = JSON.parse(await readFile(markerPath, "utf8")) as Partial<ActiveSessionMarker>;
				if (
					typeof marker.pid === "number" &&
					typeof marker.sessionFile === "string" &&
					processIsAlive(marker.pid)
				) {
					activeFiles.add(resolve(marker.sessionFile));
					return;
				}
				await rm(markerPath, { force: true });
			} catch {
				// Ignore malformed/stale markers; the next run can remove them.
			}
		},
	);
	return activeFiles;
}

export function planCandidates(
	sessions: SessionRecord[],
	policy: RetentionPolicy,
	currentSessionFile?: string,
	protectedFragments: string[] = [],
	protectedParentPaths: ReadonlySet<string> = new Set(),
	protectedSessionFiles: ReadonlySet<string> = new Set(),
): CleanupCandidate[] {
	const current = currentSessionFile ? resolve(currentSessionFile) : undefined;
	const candidates: CleanupCandidate[] = [];
	for (const session of sessions) {
		if (current && resolve(session.file) === current) continue;
		if (protectedSessionFiles.has(resolve(session.file))) continue;
		if (policy.protectRecentDays > 0 && session.ageDays < policy.protectRecentDays) continue;
		if (session.name) continue;
		if (matchesProtectedFragment(session, protectedFragments)) continue;
		if (protectedParentPaths.has(resolve(session.file))) continue;

		let reason: CleanupReason | undefined;
		if (session.ageDays >= policy.maxAgeDays) reason = "max-age";
		else if (session.projectRank >= policy.keepPerProject && session.ageDays >= policy.capAfterDays) {
			reason = "project-cap";
		} else if (session.size <= policy.tinyBytes && session.ageDays >= policy.tinyAfterDays) {
			reason = "tiny";
		}
		if (reason) candidates.push({ ...session, reason });
	}
	return candidates;
}

async function enrichCandidateNames(candidates: CleanupCandidate[]): Promise<void> {
	await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (candidate) => {
		if (candidate.name) return;
		const tail = await readTail(candidate.file, candidate.size);
		const tailName = extractNameFromText(tail);
		if (tailName) candidate.name = tailName;
	});
}

function parentPathsOfRetainedSessions(
	sessions: SessionRecord[],
	preliminaryCandidates: ReadonlySet<string>,
	sessionRoot: string,
): Set<string> {
	const byPath = new Map<string, SessionRecord>();
	for (const session of sessions) byPath.set(resolve(session.file), session);
	const protectedParents = new Set<string>();
	for (const retained of sessions) {
		if (preliminaryCandidates.has(retained.file)) continue;
		let parent = retained.parentSessionPath;
		const seen = new Set<string>();
		while (parent) {
			const resolvedParent = parentPathCandidates(parent, sessionRoot).find((value) => byPath.has(value));
			if (!resolvedParent || seen.has(resolvedParent)) break;
			seen.add(resolvedParent);
			protectedParents.add(resolvedParent);
			parent = byPath.get(resolvedParent)?.parentSessionPath;
		}
	}
	return protectedParents;
}

async function acquireLock(agentDir: string): Promise<(() => Promise<void>) | undefined> {
	const lockDir = join(agentDir, LOCK_DIRECTORY_NAME);
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(lockDir);
		await writeFile(join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
		return async () => {
			await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
		};
	} catch {
		try {
			const lockStat = await stat(lockDir);
			if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) return undefined;
			await rm(lockDir, { recursive: true, force: true });
			await mkdir(lockDir);
			await writeFile(join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
			return async () => {
				await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
			};
		} catch {
			return undefined;
		}
	}
}

function runId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

async function purgeQuarantine(quarantineRoot: string, quarantineDays: number): Promise<number> {
	if (quarantineDays < 0) return 0;
	let entries: Dirent[];
	try {
		entries = await readdir(quarantineRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	let purged = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T/.test(entry.name)) continue;
		const path = join(quarantineRoot, entry.name);
		try {
			const entryStat = await stat(path);
			if ((Date.now() - entryStat.mtimeMs) / 86_400_000 >= quarantineDays) {
				await rm(path, { recursive: true, force: true });
				purged++;
			}
		} catch {
			// A concurrent cleanup or a partially written run is harmless.
		}
	}
	return purged;
}

function emptySummary(quarantineRoot: string, dryRun: boolean): CleanupSummary {
	return {
		scanned: 0,
		planned: 0,
		moved: 0,
		bytes: 0,
		quarantinedBytes: 0,
		failed: 0,
		protectedByName: 0,
		protectedByParent: 0,
		purgedRuns: 0,
		dryRun,
		locked: false,
		quarantineRoot,
		candidates: [],
		errors: [],
	};
}

export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupSummary> {
	const agentDir = resolve(options.agentDir || resolveAgentDir());
	const sessionRoot = resolve(options.sessionRoot || join(agentDir, SESSION_ROOT_NAME));
	const quarantineRoot = join(agentDir, QUARANTINE_ROOT_NAME);
	const policy = readPolicy(options.policy);
	const summary = emptySummary(quarantineRoot, policy.dryRun);
	const release = await acquireLock(agentDir);
	if (!release) {
		summary.locked = true;
		return summary;
	}

	try {
		if (!policy.dryRun) summary.purgedRuns = await purgeQuarantine(quarantineRoot, policy.quarantineDays);
		const sessions = await discoverSessions(sessionRoot);
		summary.scanned = sessions.length;
		const protectedFragments = options.protectedFragments ?? envProtectedFragments();
		const protectedSessionFiles = await readActiveSessionFiles(agentDir);
		if (options.currentSessionFile) protectedSessionFiles.add(resolve(options.currentSessionFile));
		for (const sessionFile of options.protectedSessionFiles ?? []) {
			protectedSessionFiles.add(resolve(sessionFile));
		}
		const preliminary = planCandidates(
			sessions,
			policy,
			options.currentSessionFile,
			protectedFragments,
			new Set(),
			protectedSessionFiles,
		);
		await enrichCandidateNames(preliminary);
		const preliminaryPaths = new Set(preliminary.filter((candidate) => !candidate.name).map((candidate) => candidate.file));
		const protectedParentPaths = parentPathsOfRetainedSessions(sessions, preliminaryPaths, sessionRoot);
		const candidatesBeforeParentProtection = preliminary.filter((candidate) => !candidate.name);
		const candidates = planCandidates(
			sessions,
			policy,
			options.currentSessionFile,
			protectedFragments,
			protectedParentPaths,
			protectedSessionFiles,
		);
		// Keep the names discovered during the bounded prefix/tail scan so a
		// named candidate is never moved merely because its name was near a slice.
		const names = new Map(preliminary.map((candidate) => [resolve(candidate.file), candidate.name]));
		for (const candidate of candidates) candidate.name ||= names.get(resolve(candidate.file));
		const finalCandidates = candidates.filter((candidate) => !candidate.name);
		summary.protectedByName = preliminary.filter((candidate) => candidate.name).length;
		summary.protectedByParent = candidatesBeforeParentProtection.filter((candidate) =>
			protectedParentPaths.has(resolve(candidate.file)),
		).length;
		summary.planned = finalCandidates.length;
		summary.bytes = finalCandidates.reduce((total, candidate) => total + candidate.size, 0);
		summary.candidates = finalCandidates;
		if (policy.dryRun || finalCandidates.length === 0) return summary;

		const quarantineRun = join(quarantineRoot, runId());
		await mkdir(quarantineRun, { recursive: true });
		const manifest = join(quarantineRun, "manifest.jsonl");
		await writeFile(
			join(quarantineRun, "policy.json"),
			`${JSON.stringify({ policy, sessionRoot, createdAt: new Date().toISOString() }, null, 2)}\n`,
		);
		let manifestWrite = Promise.resolve();
		await mapWithConcurrency(finalCandidates, MOVE_CONCURRENCY, async (candidate) => {
			const destination = join(quarantineRun, candidate.projectDir, basename(candidate.file));
			try {
				await mkdir(dirname(destination), { recursive: true });
				await rename(candidate.file, destination);
				const record: ManifestRecord = {
					originalPath: candidate.file,
					quarantinedPath: relative(quarantineRun, destination),
					size: candidate.size,
					ageDays: candidate.ageDays,
					reason: candidate.reason,
					...(candidate.cwd ? { cwd: candidate.cwd } : {}),
					...(candidate.name ? { name: candidate.name } : {}),
				};
				// Serialize manifest appends so concurrent moves cannot interleave
				// records. The rename happens first, so a failed append is reported
				// as a failed recovery record rather than a false success.
				const append = manifestWrite.then(() => appendFile(manifest, `${JSON.stringify(record)}\n`));
				manifestWrite = append.catch(() => undefined);
				await append;
				summary.moved++;
				summary.quarantinedBytes += candidate.size;
			} catch (error) {
				summary.failed++;
				summary.errors.push(`${candidate.file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		return summary;
	} finally {
		await release();
	}
}

export async function restoreRun(agentDir: string, requestedRunId: string): Promise<{ restored: number; skipped: number; failed: number }> {
	const release = await acquireLock(agentDir);
	if (!release) throw new Error("Another session retention operation is already running");
	try {
		const quarantineRoot = resolve(agentDir, QUARANTINE_ROOT_NAME);
		const runName = basename(requestedRunId);
		if (runName !== requestedRunId || !/^\d{4}-\d{2}-\d{2}T/.test(runName)) {
			throw new Error("Invalid quarantine run id");
		}
		const runPath = resolve(quarantineRoot, runName);
		if (!isPathInside(runPath, quarantineRoot)) throw new Error("Invalid quarantine path");
		const sessionRoot = resolve(agentDir, SESSION_ROOT_NAME);
		const manifestPath = join(runPath, "manifest.jsonl");
		const content = await readFile(manifestPath, "utf8");
		let restored = 0;
		let skipped = 0;
		let failed = 0;
		for (const line of content.split(/\r?\n/)) {
			const record = parseJsonLine(line) as Partial<ManifestRecord> | undefined;
			if (!record?.originalPath || !record.quarantinedPath) continue;
			const source = resolve(runPath, record.quarantinedPath);
			const destination = resolve(record.originalPath);
			if (!isPathInside(source, runPath) || !isPathInside(destination, sessionRoot)) {
				failed++;
				continue;
			}
			try {
				try {
					await stat(destination);
					skipped++;
					continue;
				} catch {
					// Destination is absent; restore it below.
				}
				await mkdir(dirname(destination), { recursive: true });
				await rename(source, destination);
				restored++;
			} catch {
				failed++;
			}
		}
		if (failed === 0) await rm(runPath, { recursive: true, force: true });
		return { restored, skipped, failed };
	} finally {
		await release();
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatSummary(summary: CleanupSummary, policy: RetentionPolicy): string {
	if (summary.locked) return "Session retention skipped: another cleanup is already running.";
	const action = summary.dryRun ? "would quarantine" : "quarantined";
	const suffix = summary.failed > 0 ? `; ${summary.failed} failed` : "";
	return `${summary.scanned} sessions scanned; ${action} ${summary.planned} (${formatBytes(summary.bytes)})${suffix}. ` +
		`Keeps newest ${policy.keepPerProject}/project, protects ${policy.protectRecentDays}d, max age ${policy.maxAgeDays}d.`;
}

async function statusText(options: CleanupOptions): Promise<string> {
	const policy = readPolicy(options.policy);
	const agentDir = resolve(options.agentDir || resolveAgentDir());
	const sessionRoot = resolve(options.sessionRoot || join(agentDir, SESSION_ROOT_NAME));
	const sessions = await discoverSessions(sessionRoot);
	const protectedSessionFiles = await readActiveSessionFiles(agentDir);
	if (options.currentSessionFile) protectedSessionFiles.add(resolve(options.currentSessionFile));
	for (const sessionFile of options.protectedSessionFiles ?? []) {
		protectedSessionFiles.add(resolve(sessionFile));
	}
	const candidates = planCandidates(
		sessions,
		policy,
		options.currentSessionFile,
		options.protectedFragments ?? envProtectedFragments(),
		new Set(),
		protectedSessionFiles,
	);
	await enrichCandidateNames(candidates);
	const pending = candidates.filter((candidate) => !candidate.name);
	const totalBytes = sessions.reduce((total, session) => total + session.size, 0);
	return `${sessions.length} loadable sessions (${formatBytes(totalBytes)}); ${pending.length} currently match cleanup (${formatBytes(
		pending.reduce((total, candidate) => total + candidate.size, 0),
	)}).\nQuarantine: ${resolve(options.agentDir || resolveAgentDir(), QUARANTINE_ROOT_NAME)}`;
}

function commandTokens(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

export default function sessionRetention(pi: ExtensionAPI): void {
	pi.registerCommand("session-retention", {
		description: "Show or clean old Pi sessions: status, cleanup [--dry-run], restore <run-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = commandTokens(args);
			const action = tokens[0] || "status";
			const agentDir = resolveAgentDir();
			const sessionRoot = join(agentDir, SESSION_ROOT_NAME);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			if (action === "status") {
				ctx.ui.notify(await statusText({ agentDir, sessionRoot, currentSessionFile }), "info");
				return;
			}
			if (action === "cleanup") {
				const summary = await runCleanup({
					agentDir,
					sessionRoot,
					currentSessionFile,
					policy: tokens.includes("--dry-run") ? { dryRun: true } : undefined,
				});
				ctx.ui.notify(formatSummary(summary, readPolicy({ dryRun: summary.dryRun })), summary.failed ? "warning" : "info");
				return;
			}
			if (action === "restore" && tokens[1]) {
				const result = await restoreRun(agentDir, tokens[1]);
				ctx.ui.notify(`Restored ${result.restored} session(s); skipped ${result.skipped}; failed ${result.failed}.`, result.failed ? "warning" : "info");
				return;
			}
			ctx.ui.notify("Usage: /session-retention status | cleanup [--dry-run] | restore <run-id>", "warning");
		},
	});

	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		const agentDir = resolveAgentDir();
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		await writeActiveSessionMarker(agentDir, currentSessionFile);
		if (event.reason !== "startup" || parseBooleanEnv("PI_SESSION_RETENTION_AUTO", true) === false) return;
		try {
			const summary = await runCleanup({
				agentDir,
				sessionRoot: join(agentDir, SESSION_ROOT_NAME),
				currentSessionFile,
			});
			if (summary.moved > 0 && ctx.hasUI) {
				ctx.ui.notify(`Session retention: quarantined ${summary.moved} stale/spammy session(s) (${formatBytes(summary.quarantinedBytes)}).`, "info");
			} else if (summary.failed > 0 && ctx.hasUI) {
				ctx.ui.notify(`Session retention: ${summary.failed} session cleanup action(s) failed.`, "warning");
			}
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Session retention failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await removeActiveSessionMarker(resolveAgentDir());
	});
}
