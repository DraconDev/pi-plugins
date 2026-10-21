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
import { readFileSync } from "node:fs";
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
	/** Delete matching sessions outright instead of moving them into quarantine. */
	deleteMode: boolean;
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
	deleteMode: false,
	dryRun: false,
};

/** File that holds the policy, next to the session store. */
export const CONFIG_FILE_NAME = "session-retention.json";

export interface RetentionConfig {
	maxAgeDays?: number;
	keepPerProject?: number;
	capAfterDays?: number;
	protectRecentDays?: number;
	tinyBytes?: number;
	tinyAfterDays?: number;
	quarantineDays?: number;
	/** Delete matching sessions outright instead of quarantining them. */
	delete?: boolean;
	/** Alias for `delete`. */
	deleteMode?: boolean;
	dryRun?: boolean;
	/** Extra path/project fragments that are always protected. */
	protect?: string[];
}

export type CleanupReason = "max-age" | "project-cap" | "tiny";

export interface SessionRecord {
	file: string;
	projectDir: string;
	cwd: string | undefined;
	parentSessionPath: string | undefined;
	name: string | undefined;
	/** True when the name was explicitly chosen by the user, so it is kept forever. */
	explicitName: boolean;
	/** True for sessions living in a nested artifact directory (forks/, run-N/, ...). */
	nested: boolean;
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

export function readPolicy(overrides: Partial<RetentionPolicy> = {}, agentDir?: string): RetentionPolicy {
	const config = readConfigFile(agentDir ?? resolveAgentDir());
	const pickNumber = (key: string, envName: string, fallback: number): number => {
		const override = (overrides as Record<string, unknown>)[key];
		if (typeof override === "number" && Number.isFinite(override) && override >= 0) return override;
		const fromConfig = (config as Record<string, unknown>)[key];
		if (typeof fromConfig === "number" && Number.isFinite(fromConfig) && fromConfig >= 0) return fromConfig;
		return parseNumberEnv(envName, fallback);
	};
	const pickBoolean = (key: string, envName: string, fallback: boolean): boolean => {
		const override = (overrides as Record<string, unknown>)[key];
		if (typeof override === "boolean") return override;
		const fromConfig = (config as Record<string, unknown>)[key];
		if (typeof fromConfig === "boolean") return fromConfig;
		return parseBooleanEnv(envName, fallback);
	};
	const maxAgeDays = pickNumber("maxAgeDays", "PI_SESSION_RETENTION_MAX_AGE_DAYS", DEFAULT_POLICY.maxAgeDays);
	const keepPerProject = Math.floor(
		pickNumber("keepPerProject", "PI_SESSION_RETENTION_KEEP_PER_PROJECT", DEFAULT_POLICY.keepPerProject),
	);
	const capAfterDays = pickNumber("capAfterDays", "PI_SESSION_RETENTION_CAP_AFTER_DAYS", DEFAULT_POLICY.capAfterDays);
	const protectRecentDays = pickNumber(
		"protectRecentDays",
		"PI_SESSION_RETENTION_PROTECT_RECENT_DAYS",
		DEFAULT_POLICY.protectRecentDays,
	);
	const tinyBytes = Math.floor(pickNumber("tinyBytes", "PI_SESSION_RETENTION_TINY_BYTES", DEFAULT_POLICY.tinyBytes));
	const tinyAfterDays = pickNumber("tinyAfterDays", "PI_SESSION_RETENTION_TINY_AFTER_DAYS", DEFAULT_POLICY.tinyAfterDays);
	const quarantineDays = pickNumber("quarantineDays", "PI_SESSION_RETENTION_QUARANTINE_DAYS", DEFAULT_POLICY.quarantineDays);
	const deleteMode = pickBoolean("deleteMode", "PI_SESSION_RETENTION_DELETE", DEFAULT_POLICY.deleteMode);
	return {
		maxAgeDays,
		keepPerProject,
		capAfterDays,
		protectRecentDays,
		tinyBytes,
		tinyAfterDays,
		quarantineDays,
		deleteMode,
		dryRun: pickBoolean("dryRun", "PI_SESSION_RETENTION_DRY_RUN", DEFAULT_POLICY.dryRun),
	};
}

function envProtectedFragments(): string[] {
	return (process.env.PI_SESSION_RETENTION_PROTECT || "")
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Read the policy file that sits next to the session store. It is the only
 * configuration channel that survives every launch path (terminal, systemd
 * timer, IDE), so it takes precedence over the environment variables.
 */
export function readConfigFile(agentDir: string): RetentionConfig {
	let raw: string;
	try {
		raw = readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const config = parsed as RetentionConfig;
	// Accept both spellings of the hard-delete switch.
	if (config.delete !== undefined && config.deleteMode === undefined) {
		config.deleteMode = config.delete;
	}
	return config;
}

function configProtectedFragments(config: RetentionConfig): string[] {
	if (!Array.isArray(config.protect)) return [];
	return config.protect
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
}

/** Protected fragments from both the environment and the policy file. */
export function protectedFragments(agentDir: string): string[] {
	const config = readConfigFile(agentDir);
	return [...new Set([...envProtectedFragments(), ...configProtectedFragments(config)])];
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

/**
 * Marker that pi-subagents injects into the system prompt of every child
 * session. It is the only reliable marker that separates a machine-generated
 * subagent run from a session the user started themselves.
 */
const SUBAGENT_SYSTEM_MARKER = "<active_agent name=";

/**
 * Auto-generated session names that pi-subagents has used over time. They look
 * like user-chosen names but are machine-made, so they must not exempt a
 * session from cleanup forever.
 */
const AUTO_NAME_PATTERNS: RegExp[] = [
	// legacy child sessions: "Explore#288df251", "general-purpose#36442bff"
	/^[A-Za-z][A-Za-z0-9._-]*#[0-9a-f]{6,10}$/,
	// legacy child runs: "subagent-scout-88e98f95-cf4f-4b93-9789-259e5479f13b-1"
	/^subagent-[a-z0-9][a-z0-9-]*-[0-9a-f-]{8,36}-\d+$/i,
];

export interface SessionNameInfo {
	/** Display name, when the session carries one. */
	name?: string;
	/** True when the name was explicitly chosen by the user; such sessions are kept. */
	explicit: boolean;
	/** True when the session is a machine-generated subagent run. */
	auto: boolean;
}

interface NameSignals {
	legacy?: string;
	explicit?: string;
	auto?: string;
	subagent: boolean;
}

/**
 * Detect the subagent marker without parsing the (potentially very large)
 * system message entry. Only the first message entry is inspected, and only
 * the first few kilobytes of it, so user text can never trigger a match.
 */
function detectSubagentMarker(text: string): boolean {
	const entryStart = text.indexOf('{"type":"message"');
	if (entryStart === -1) return false;
	const roleIdx = text.indexOf('"role":"system"', entryStart);
	if (roleIdx === -1) return false;
	return text.slice(roleIdx, roleIdx + 4096).includes(SUBAGENT_SYSTEM_MARKER);
}

function collectNameSignals(text: string, signals: NameSignals): void {
	for (const line of text.split(/\r?\n/)) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		if (entry.type === "session_info") {
			const value = entry.name;
			if (typeof value === "string" && value.trim()) signals.legacy = value.trim();
			continue;
		}
		if (entry.type === "title" || entry.type === "title_change") {
			const value = entry.title;
			if (typeof value !== "string" || !value.trim()) continue;
			const source = entry.source;
			if (source === "user") signals.explicit = value.trim();
			else if (source === "auto") signals.auto = value.trim();
			else signals.legacy = value.trim();
		}
	}
}

/**
 * Decide whether a session name was chosen by the user or generated by the
 * tooling. Only an explicit user choice protects a session from cleanup.
 */
export function analyzeSessionName(prefix: string, tail: string): SessionNameInfo {
	const head: NameSignals = { subagent: false };
	const tailSignals: NameSignals = { subagent: false };
	collectNameSignals(prefix, head);
	collectNameSignals(tail, tailSignals);

	const explicit = tailSignals.explicit ?? head.explicit;
	const auto = tailSignals.auto ?? head.auto;
	const legacy = tailSignals.legacy ?? head.legacy;
	const name = explicit ?? auto ?? legacy;
	const subagent = detectSubagentMarker(prefix) || detectSubagentMarker(tail);

	// A subagent marker outranks everything else: the name was set by the
	// launcher, not by the user.
	if (subagent) return { name, explicit: false, auto: true };
	if (explicit) return { name: explicit, explicit: true, auto: false };
	if (auto) return { name: auto, explicit: false, auto: true };
	if (legacy && !AUTO_NAME_PATTERNS.some((pattern) => pattern.test(legacy))) {
		return { name: legacy, explicit: true, auto: false };
	}
	return { name: legacy, explicit: false, auto: Boolean(legacy) };
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

const MAX_NESTED_DEPTH = 5;
const MAX_FILES_PER_PROJECT = 20000;

interface SessionFileEntry {
	file: string;
	projectDir: string;
	/** True for files inside a nested artifact directory (forks/, run-N/, ...). */
	nested: boolean;
}

async function collectNestedSessionFiles(
	dir: string,
	projectDir: string,
	depth: number,
	out: SessionFileEntry[],
): Promise<void> {
	if (depth > MAX_NESTED_DEPTH || out.length >= MAX_FILES_PER_PROJECT) return;
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_FILES_PER_PROJECT) return;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectNestedSessionFiles(path, projectDir, depth + 1, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		out.push({ file: path, projectDir, nested: true });
	}
}

/**
 * Collect every session transcript under the store: the top-level project
 * files that `/resume` lists, plus the nested artifacts (fork branches,
 * subagent runs, transcripts) that live inside a session directory.
 */
async function sessionFiles(sessionRoot: string): Promise<SessionFileEntry[]> {
	const files: SessionFileEntry[] = [];
	let projectEntries: Dirent[];
	try {
		projectEntries = await readdir(sessionRoot, { withFileTypes: true });
	} catch {
		return files;
	}

	const projects = projectEntries.filter((entry) => entry.isDirectory());
	const perProject = await mapWithConcurrency(projects, SCAN_CONCURRENCY, async (project) => {
		const projectPath = join(sessionRoot, project.name);
		const result: SessionFileEntry[] = [];
		let entries: Dirent[];
		try {
			entries = await readdir(projectPath, { withFileTypes: true });
		} catch {
			return result;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				result.push({ file: join(projectPath, entry.name), projectDir: project.name, nested: false });
			}
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			await collectNestedSessionFiles(join(projectPath, entry.name), project.name, 1, result);
		}
		return result;
	});
	return perProject.flat();
}

export async function discoverSessions(sessionRoot: string, nowMs = Date.now()): Promise<SessionRecord[]> {
	const files = await sessionFiles(sessionRoot);
	const discovered = await mapWithConcurrency(files, SCAN_CONCURRENCY, async ({ file, projectDir, nested }) => {
		try {
			const fileStat = await stat(file);
			const parsed = await readPrefix(file);
			if (!parsed) return undefined;
			const header = parsed.header;
			const cwd = typeof header.cwd === "string" ? header.cwd : undefined;
			const parentSessionPath =
				typeof header.parentSession === "string" ? header.parentSession : undefined;
			const nameInfo = analyzeSessionName(parsed.prefix, "");
			return {
				file,
				projectDir,
				cwd,
				parentSessionPath,
				name: nameInfo.name,
				explicitName: nameInfo.explicit,
				nested,
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
		// Only the top-level project files compete for the per-project keep
		// slots, exactly like Pi's own session browser lists them. Nested
		// artifacts are governed by age alone.
		let rank = 0;
		for (const session of group) {
			session.projectRank = session.nested ? Number.MAX_SAFE_INTEGER : rank++;
		}
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

export async function readActiveSessionFiles(agentDir: string): Promise<Set<string>> {
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
		// Only a name the user picked explicitly protects a session forever.
		// Machine-generated subagent labels must not exempt anything.
		if (session.explicitName) continue;
		if (matchesProtectedFragment(session, protectedFragments)) continue;
		if (protectedParentPaths.has(resolve(session.file))) continue;

		let reason: CleanupReason | undefined;
		if (session.ageDays >= policy.maxAgeDays) reason = "max-age";
		else if (
			!session.nested &&
			session.projectRank >= policy.keepPerProject &&
			session.ageDays >= policy.capAfterDays
		) {
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
		const tail = await readTail(candidate.file, candidate.size);
		const info = analyzeSessionName("", tail);
		if (info.name) candidate.name = info.name;
		// A name found in the tail slice can still be an explicit user name, in
		// which case the session must be kept.
		if (info.explicit) candidate.explicitName = true;
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

export interface PurgeSummary {
	purgedRuns: number;
	locked: boolean;
	quarantineRoot: string;
	quarantineDays: number;
}

/**
 * Purge expired quarantine runs without scanning the session store.
 *
 * This is intentionally exported for the optional systemd timer, which can
 * enforce the recovery window even when no Pi process is running.
 */
export async function purgeExpiredQuarantine(
	options: { agentDir?: string; quarantineDays?: number } = {},
): Promise<PurgeSummary> {
	const agentDir = resolve(options.agentDir || resolveAgentDir());
	const quarantineDays = readPolicy({ quarantineDays: options.quarantineDays }, agentDir).quarantineDays;
	const quarantineRoot = join(agentDir, QUARANTINE_ROOT_NAME);
	const release = await acquireLock(agentDir);
	if (!release) return { purgedRuns: 0, locked: true, quarantineRoot, quarantineDays };
	try {
		return {
			purgedRuns: await purgeQuarantine(quarantineRoot, quarantineDays),
			locked: false,
			quarantineRoot,
			quarantineDays,
		};
	} finally {
		await release();
	}
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

/**
 * Remove directories that became empty after a deletion pass. Only directories
 * inside the session store are considered, and the store root is never removed.
 */
async function pruneEmptyDirs(dirs: ReadonlySet<string>, sessionRoot: string): Promise<void> {
	const root = resolve(sessionRoot);
	for (const dir of dirs) {
		let current = resolve(dir);
		while (current !== root && isPathInside(current, root)) {
			let entries: Dirent[];
			try {
				entries = await readdir(current, { withFileTypes: true });
			} catch {
				break;
			}
			if (entries.length > 0) break;
			try {
				await rm(current, { recursive: false, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}
}

export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupSummary> {
	const agentDir = resolve(options.agentDir || resolveAgentDir());
	const sessionRoot = resolve(options.sessionRoot || join(agentDir, SESSION_ROOT_NAME));
	const quarantineRoot = join(agentDir, QUARANTINE_ROOT_NAME);
	const policy = readPolicy(options.policy, agentDir);
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
		const protectedPathFragments = options.protectedFragments ?? protectedFragments(agentDir);
		const protectedSessionFiles = await readActiveSessionFiles(agentDir);
		if (options.currentSessionFile) protectedSessionFiles.add(resolve(options.currentSessionFile));
		for (const sessionFile of options.protectedSessionFiles ?? []) {
			protectedSessionFiles.add(resolve(sessionFile));
		}
		const preliminary = planCandidates(
			sessions,
			policy,
			options.currentSessionFile,
			protectedPathFragments,
			new Set(),
			protectedSessionFiles,
		);
		await enrichCandidateNames(preliminary);
		const preliminaryPaths = new Set(
			preliminary.filter((candidate) => !candidate.explicitName).map((candidate) => candidate.file),
		);
		const protectedParentPaths = parentPathsOfRetainedSessions(sessions, preliminaryPaths, sessionRoot);
		const candidatesBeforeParentProtection = preliminary.filter((candidate) => !candidate.explicitName);
		const candidates = planCandidates(
			sessions,
			policy,
			options.currentSessionFile,
			protectedPathFragments,
			protectedParentPaths,
			protectedSessionFiles,
		);
		// Keep the names discovered during the bounded prefix/tail scan so a
		// named candidate is never moved merely because its name was near a slice.
		const names = new Map(preliminary.map((candidate) => [resolve(candidate.file), candidate.name]));
		const explicit = new Map(
			preliminary.map((candidate) => [resolve(candidate.file), candidate.explicitName]),
		);
		for (const candidate of candidates) {
			candidate.name ||= names.get(resolve(candidate.file));
			candidate.explicitName ||= explicit.get(resolve(candidate.file)) ?? false;
		}
		const finalCandidates = candidates.filter((candidate) => !candidate.explicitName);
		summary.protectedByName = preliminary.filter((candidate) => candidate.explicitName).length;
		summary.protectedByParent = candidatesBeforeParentProtection.filter((candidate) =>
			protectedParentPaths.has(resolve(candidate.file)),
		).length;
		summary.planned = finalCandidates.length;
		summary.bytes = finalCandidates.reduce((total, candidate) => total + candidate.size, 0);
		summary.candidates = finalCandidates;
		if (policy.dryRun || finalCandidates.length === 0) return summary;

		if (policy.deleteMode) {
			// Hard delete: no quarantine run, no manifest, no recovery window.
			const touchedDirs = new Set<string>();
			await mapWithConcurrency(finalCandidates, MOVE_CONCURRENCY, async (candidate) => {
				try {
					await rm(candidate.file, { force: true });
					summary.moved++;
					summary.quarantinedBytes += candidate.size;
					touchedDirs.add(dirname(candidate.file));
				} catch (error) {
					summary.failed++;
					summary.errors.push(`${candidate.file}: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
			await pruneEmptyDirs(touchedDirs, sessionRoot);
			return summary;
		}

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
	const verb = policy.deleteMode ? (summary.dryRun ? "would delete" : "deleted") : summary.dryRun ? "would quarantine" : "quarantined";
	const suffix = summary.failed > 0 ? `; ${summary.failed} failed` : "";
	return `${summary.scanned} sessions scanned; ${verb} ${summary.planned} (${formatBytes(summary.bytes)})${suffix}. ` +
		`Keeps newest ${policy.keepPerProject}/project, protects ${policy.protectRecentDays}d, max age ${policy.maxAgeDays}d.`;
}

async function statusText(options: CleanupOptions): Promise<string> {
	const agentDir = resolve(options.agentDir || resolveAgentDir());
	const policy = readPolicy(options.policy, agentDir);
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
		options.protectedFragments ?? protectedFragments(agentDir),
		new Set(),
		protectedSessionFiles,
	);
	await enrichCandidateNames(candidates);
	const pending = candidates.filter((candidate) => !candidate.explicitName);
	const totalBytes = sessions.reduce((total, session) => total + session.size, 0);
	const mode = policy.deleteMode ? "delete" : "quarantine";
	return `${sessions.length} session files (${formatBytes(totalBytes)}); ${pending.length} currently match cleanup (${formatBytes(
		pending.reduce((total, candidate) => total + candidate.size, 0),
	)}); mode=${mode}.\nQuarantine: ${join(agentDir, QUARANTINE_ROOT_NAME)}`;
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
