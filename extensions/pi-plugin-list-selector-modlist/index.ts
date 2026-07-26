import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	PackageSource,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "modlist.json";
const STATE_ENTRY_TYPE = "modlist-state";
const STATUS_KEY = "modlist";
const SELF_PACKAGE = "../../Dev/pi-plugins/extensions/pi-plugin-list-selector-modlist";

/** Plain addon-array profile — settings.json packages are the immutable baseline. */
type ModlistProfile = PackageSource[];

interface ModlistConfig {
	default?: string;
	profiles: Record<string, ModlistProfile>;
}

interface ModlistState {
	name: string;
	baseline?: PackageSource[];
}

interface LoadedConfig {
	config: ModlistConfig;
	errors: string[];
	globalPath: string;
	projectPath: string;
	projectExists: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackageSource(value: unknown): value is PackageSource {
	if (typeof value === "string") return value.length > 0;
	if (!isRecord(value) || typeof value.source !== "string" || value.source.length === 0) return false;
	if (value.autoload !== undefined && typeof value.autoload !== "boolean") return false;
	for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
		const patterns = value[key];
		if (patterns !== undefined && (!Array.isArray(patterns) || !patterns.every((item) => typeof item === "string"))) {
			return false;
		}
	}
	return true;
}

function parseConfig(path: string): { config: ModlistConfig; errors: string[] } {
	if (!existsSync(path)) return { config: { profiles: {} }, errors: [] };

	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) throw new Error("top-level value must be an object");

		const errors: string[] = [];
		const config: ModlistConfig = { profiles: {} };
		if (parsed.default !== undefined) {
			if (typeof parsed.default === "string" && parsed.default.length > 0) config.default = parsed.default;
			else errors.push(`${path}: "default" must be a non-empty string`);
		}

		if (parsed.profiles === undefined) return { config, errors };
		if (!isRecord(parsed.profiles)) {
			errors.push(`${path}: "profiles" must be an object`);
			return { config, errors };
		}

		for (const [name, value] of Object.entries(parsed.profiles)) {
			if (!name) {
				errors.push(`${path}: empty profile name`);
				continue;
			}
			if (!Array.isArray(value)) {
				errors.push(`${path}: profile "${name}" must be an array of addon packages`);
				continue;
			}
			if (value.every(isPackageSource)) config.profiles[name] = [...value] as ModlistProfile;
			else errors.push(`${path}: profile "${name}" has an invalid addon list`);
		}

		return { config, errors };
	} catch (error) {
		return {
			config: { profiles: {} },
			errors: [`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.modlist-${process.pid}-${Date.now()}.tmp`;
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
	}
}

function globalConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readGlobalSettings(): JsonRecord {
	const path = settingsPath();
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
	return parsed;
}

function readGlobalPackages(): PackageSource[] {
	const packages = readGlobalSettings().packages;
	if (packages === undefined) return [];
	if (!Array.isArray(packages) || !packages.every(isPackageSource)) {
		throw new Error(`${settingsPath()}: "packages" is not a valid package list`);
	}
	return packages;
}

function writeGlobalPackages(packages: PackageSource[]): void {
	const settings = readGlobalSettings();
	settings.packages = packages;
	writeJsonAtomic(settingsPath(), settings);
}

function packageSourceName(source: PackageSource): string {
	return typeof source === "string" ? source : source.source;
}

function isSelfPackage(source: PackageSource): boolean {
	const name = packageSourceName(source).replaceAll("\\", "/").replace(/\/$/, "");
	return name === SELF_PACKAGE || name.endsWith("/pi-plugin-list-selector-modlist");
}

function packageSourceKey(source: PackageSource): string {
	if (typeof source === "string") return `string:${source}`;
	return JSON.stringify({
		source: source.source,
		autoload: source.autoload,
		extensions: source.extensions,
		skills: source.skills,
		prompts: source.prompts,
		themes: source.themes,
	});
}

function packageSetsMatch(left: PackageSource[], right: PackageSource[]): boolean {
	const leftSources = new Set(left.map(packageSourceKey));
	const rightSources = new Set(right.map(packageSourceKey));
	if (leftSources.size !== rightSources.size) return false;
	return [...leftSources].every((source) => rightSources.has(source));
}

/** Compute the union of a baseline (settings.json packages) and the profile addons. */
function mergeAddons(baseline: PackageSource[], addons: PackageSource[]): PackageSource[] {
	const selfCurrent = baseline.find(isSelfPackage);
	const withoutSelf = baseline.filter((source) => !isSelfPackage(source));
	const merged = [...withoutSelf, ...addons.filter((source) => !isSelfPackage(source))];
	const seen = new Set<string>();
	const result: PackageSource[] = [];
	for (const source of merged) {
		const key = packageSourceKey(source);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(source);
		}
	}
	if (selfCurrent) result.push(selfCurrent);
	return result;
}

function loadConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
	const globalPath = globalConfigPath();
	const projectPath = projectConfigPath(cwd);
	const globalResult = parseConfig(globalPath);
	const projectExists = projectTrusted && existsSync(projectPath);
	const projectResult: { config: ModlistConfig; errors: string[] } = projectExists
		? parseConfig(projectPath)
		: { config: { profiles: {} }, errors: [] };
	return {
		config: {
			profiles: { ...globalResult.config.profiles, ...projectResult.config.profiles },
			default: projectResult.config.default ?? globalResult.config.default,
		},
		errors: [...globalResult.errors, ...projectResult.errors],
		globalPath,
		projectPath,
		projectExists,
	};
}

function ensureInitialConfig(): void {
	const path = globalConfigPath();
	if (existsSync(path)) return;
	writeJsonAtomic(path, {
		default: "none",
		profiles: { none: [] },
	});
}

/** Walk session branch from latest to oldest, return the most recent modlist state. */
function restoreProfileState(ctx: ExtensionContext): ModlistState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
			return entry.data as ModlistState | undefined;
		}
	}
	return undefined;
}

function describeProfile(profile: ModlistProfile): string {
	return profile.length === 0
		? "No addon packages (settings.json only)"
		: `${profile.length} addon package${profile.length === 1 ? "" : "s"}`;
}

export default function modlistExtension(pi: ExtensionAPI): void {
	let loaded: LoadedConfig = {
		config: { profiles: {} },
		errors: [],
		globalPath: globalConfigPath(),
		projectPath: "",
		projectExists: false,
	};
	let activeName: string | undefined;
	/** Snapshot of settings.json packages captured before the current switch; enables revert. */
	let preSwitchBaseline: PackageSource[] | undefined;

	function refreshConfig(ctx: ExtensionContext): void {
		loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
	}

	function configuredPackages(): PackageSource[] {
		try {
			return readGlobalPackages();
		} catch {
			return [];
		}
	}

	function profileHasDrift(name: string): boolean {
		const profile = loaded.config.profiles[name];
		if (!profile) return true;
		const baseline = preSwitchBaseline ?? configuredPackages();
		const expected = mergeAddons(baseline, profile).filter((source) => !isSelfPackage(source));
		const current = configuredPackages().filter((source) => !isSelfPackage(source));
		return !packageSetsMatch(current, expected);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!activeName) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "modlist:none"));
			return;
		}
		const drift = profileHasDrift(activeName);
		const text = `modlist:${activeName}${drift ? "!" : ""}`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(drift ? "warning" : "accent", text));
	}

	function setActiveProfile(name: string, ctx: ExtensionContext, persist: boolean, baseline?: PackageSource[]): void {
		activeName = name;
		if (persist) pi.appendEntry<ModlistState>(STATE_ENTRY_TYPE, { name, baseline });
		updateStatus(ctx);
	}

	function notifyConfigErrors(ctx: ExtensionContext): void {
		for (const error of loaded.errors) ctx.ui.notify(error, "warning");
	}

	async function switchProfile(name: string, ctx: ExtensionCommandContext): Promise<void> {
		refreshConfig(ctx);
		const profile = loaded.config.profiles[name];
		if (!profile) {
			const names = Object.keys(loaded.config.profiles).sort().join(", ") || "(none defined)";
			ctx.ui.notify(`Unknown modlist "${name}". Available: ${names}`, "error");
			return;
		}

		let currentPackages: PackageSource[];
		try {
			currentPackages = readGlobalPackages();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}

		// The baseline is the snapshot taken before the previous switch, or the current
		// settings.json packages if this is the first switch in the session. Switching to
		// `none` with addons=[] then restores that exact baseline.
		const baselineForThisSwitch = preSwitchBaseline ?? currentPackages;

		const targetPackages = mergeAddons(baselineForThisSwitch, profile);
		const baselineNoSelf = baselineForThisSwitch.filter((source) => !isSelfPackage(source));
		const targetNoSelf = targetPackages.filter((source) => !isSelfPackage(source));
		const packagesChanged = !packageSetsMatch(baselineNoSelf, targetNoSelf);

		if (packagesChanged) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Switching to "${name}" changes extension packages and requires interactive confirmation`, "error");
				return;
			}
			const baselineNames = new Set(baselineNoSelf.map(packageSourceName));
			const targetNames = new Set(targetNoSelf.map(packageSourceName));
			const added = [...targetNames].filter((item) => !baselineNames.has(item));
			const removed = [...baselineNames].filter((item) => !targetNames.has(item));
			const details = [
				`Switch to modlist "${name}" and reload Pi resources?`,
				added.length > 0 ? `\nAdd: ${added.join(", ")}` : "",
				removed.length > 0 ? `\nRemove (revert to pre-switch baseline): ${removed.join(", ")}` : "",
			].join("");
			if (!(await ctx.ui.confirm("Change extension packages", details))) return;
		}

		setActiveProfile(name, ctx, true, baselineForThisSwitch);
		if (!packagesChanged) {
			ctx.ui.notify(profile.length === 0 ? `Modlist "${name}" active (no addon changes)` : `Modlist "${name}" active`, "info");
			return;
		}

		try {
			writeGlobalPackages(targetPackages);
			await ctx.reload();
		} catch (error) {
			ctx.ui.notify(`Could not reload modlist "${name}": ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	async function showSelector(ctx: ExtensionCommandContext): Promise<void> {
		refreshConfig(ctx);
		const names = Object.keys(loaded.config.profiles).sort();
		if (names.length === 0) {
			ctx.ui.notify(`No modlists defined. Add profiles to ${loaded.globalPath}`, "warning");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(`Specify a profile: /modlist <name>. Available: ${names.join(", ")}`, "info");
			return;
		}

		const labels = new Map<string, string>();
		for (const name of names) {
			const active = name === activeName ? " (active)" : "";
			labels.set(`${name}${active} — ${describeProfile(loaded.config.profiles[name])}`, name);
		}
		const selected = await ctx.ui.select("Select modlist", [...labels.keys()]);
		if (selected) await switchProfile(labels.get(selected) ?? selected, ctx);
	}

	function statusText(): string {
		const lines: string[] = [];
		if (activeName) {
			const profile = loaded.config.profiles[activeName];
			if (profile) {
				const desired = profile.map(packageSourceName).join(", ") || "(none)";
				const current = configuredPackages()
					.filter((source) => !isSelfPackage(source))
					.map(packageSourceName)
					.join(", ") || "(none)";
				lines.push(
					`Active modlist: ${activeName}${profileHasDrift(activeName) ? " (drift detected; status shows !)" : ""}`,
				);
				lines.push(`Addon packages (profile): ${desired}`);
				lines.push(`Configured global packages (excluding self): ${current}`);
			} else {
				lines.push(`Active selection "${activeName}" is not defined in the current config.`);
			}
		} else {
			lines.push("No active modlist.");
		}
		lines.push(`Global config: ${loaded.globalPath}`);
		lines.push(`Project config: ${loaded.projectExists ? loaded.projectPath : "(none)"}`);
		return lines.join("\n");
	}

	pi.registerCommand("modlist", {
		description: "Switch between named addon-package profiles (settings.json packages are always preserved)",
		getArgumentCompletions: (prefix) => {
			const values = [
				"list",
				"status",
				...Object.keys(loaded.config.profiles),
				...Object.keys(loaded.config.profiles).map((name) => `switch ${name}`),
			];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				await showSelector(ctx);
				return;
			}
			if (input === "list") {
				refreshConfig(ctx);
				const lines = Object.entries(loaded.config.profiles)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([name, profile]) => `${name === activeName ? "*" : " "} ${name} — ${describeProfile(profile)}`);
				ctx.ui.notify(lines.length > 0 ? lines.join("\n") : `No modlists defined in ${loaded.globalPath}`, "info");
				return;
			}
			if (input === "status") {
				refreshConfig(ctx);
				ctx.ui.notify(statusText(), "info");
				return;
			}
			const name = input.startsWith("switch ") ? input.slice("switch ".length).trim() : input;
			await switchProfile(name, ctx);
		},
	});

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		try {
			ensureInitialConfig();
			refreshConfig(ctx);
			notifyConfigErrors(ctx);

			const restored = restoreProfileState(ctx);
			preSwitchBaseline = restored?.baseline;
			const requestedName = restored?.name ?? loaded.config.default ?? "none";
			if (loaded.config.profiles[requestedName]) {
				activeName = requestedName;
			} else {
				activeName = undefined;
				if (requestedName !== "none") {
					ctx.ui.notify(`Configured modlist "${requestedName}" does not exist; using none`, "warning");
				}
			}
			updateStatus(ctx);
		} catch (error) {
			activeName = undefined;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "modlist:error"));
			ctx.ui.notify(`Modlist initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}