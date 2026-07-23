import {
	existsSync,
	mkdirSync,
	readdirSync,
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
const KEEP_CURRENT_OPTION = "Keep current selection";

interface ModlistProfile {
	description?: string;
	tools?: string[];
	/** Pi package sources. Named `extensions` because profiles control extension packages. */
	extensions?: PackageSource[];
}

interface ModlistConfig {
	default?: string;
	profiles: Record<string, ModlistProfile>;
}

interface ModlistState {
	name: string;
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
			if (!name || !isRecord(value)) {
				errors.push(`${path}: profile "${name}" must be an object`);
				continue;
			}

			const profile: ModlistProfile = {};
			if (value.description !== undefined) {
				if (typeof value.description === "string") profile.description = value.description;
				else errors.push(`${path}: profile "${name}" has an invalid description`);
			}
			if (value.tools !== undefined) {
				if (Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string")) {
					profile.tools = [...new Set(value.tools)];
				} else {
					errors.push(`${path}: profile "${name}" has an invalid tools list`);
				}
			}
			if (value.extensions !== undefined) {
				if (Array.isArray(value.extensions) && value.extensions.every(isPackageSource)) {
					profile.extensions = value.extensions;
				} else {
					errors.push(`${path}: profile "${name}" has an invalid extensions list`);
				}
			}
			config.profiles[name] = profile;
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

function deduplicatePackages(packages: PackageSource[]): PackageSource[] {
	const seen = new Set<string>();
	const result: PackageSource[] = [];
	for (const source of packages) {
		const key = packageSourceName(source);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(source);
		}
	}
	return result;
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

function toolSetsMatch(left: string[], right: string[]): boolean {
	const leftNames = new Set(left);
	const rightNames = new Set(right);
	if (leftNames.size !== rightNames.size) return false;
	return [...leftNames].every((name) => rightNames.has(name));
}

function targetPackagesForProfile(
	profile: ModlistProfile,
	profiles: Record<string, ModlistProfile>,
	currentPackages: PackageSource[],
): PackageSource[] {
	if (profile.extensions === undefined) return currentPackages;

	const managedNames = new Set(
		Object.values(profiles).flatMap((candidate) => (candidate.extensions ?? []).map(packageSourceName)),
	);
	const unmanaged = currentPackages.filter(
		(source) => !managedNames.has(packageSourceName(source)) && !isSelfPackage(source),
	);
	const currentSelf = currentPackages.find(isSelfPackage) ?? SELF_PACKAGE;
	return deduplicatePackages([...unmanaged, ...profile.extensions.filter((source) => !isSelfPackage(source)), currentSelf]);
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

function isEmptyProject(cwd: string): boolean {
	try {
		return readdirSync(cwd).every((entry) => entry === ".git" || entry === CONFIG_DIR_NAME);
	} catch {
		return false;
	}
}

function restoreProfileName(ctx: ExtensionContext): string | undefined {
	let restored: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
			const data = entry.data as ModlistState | undefined;
			if (typeof data?.name === "string") restored = data.name;
		}
	}
	return restored;
}

function describeProfile(profile: ModlistProfile): string {
	const parts: string[] = [];
	if (profile.description) parts.push(profile.description);
	if (profile.tools !== undefined) parts.push(`${profile.tools.length} tools`);
	if (profile.extensions !== undefined) parts.push(`${profile.extensions.length} extension packages`);
	return parts.join(" · ") || "No runtime changes";
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
	let startupPromptShown = false;

	function ensureInitialConfig(): void {
		const path = globalConfigPath();
		if (existsSync(path)) return;
		writeJsonAtomic(path, {
			default: "default",
			profiles: {
				default: {
					description: "Tools and extension packages active when modlist was installed",
					tools: pi.getActiveTools(),
					extensions: readGlobalPackages(),
				},
			},
		});
	}

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
		if (profile.tools !== undefined) {
			const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
			const expectedTools = profile.tools.filter((tool) => availableTools.has(tool));
			if (!toolSetsMatch(expectedTools, pi.getActiveTools())) return true;
		}
		if (profile.extensions !== undefined) {
			const current = configuredPackages();
			const target = targetPackagesForProfile(profile, loaded.config.profiles, current);
			if (!packageSetsMatch(current, target)) return true;
		}
		return false;
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

	function applyTools(name: string, ctx: ExtensionContext, notifyUnknown = true): void {
		const profile = loaded.config.profiles[name];
		if (!profile?.tools) return;
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const validTools = profile.tools.filter((tool) => availableTools.has(tool));
		const unknownTools = profile.tools.filter((tool) => !availableTools.has(tool));
		pi.setActiveTools(validTools);
		if (notifyUnknown && unknownTools.length > 0) {
			ctx.ui.notify(`Modlist "${name}" references unavailable tools: ${unknownTools.join(", ")}`, "warning");
		}
	}

	function setActiveProfile(name: string, ctx: ExtensionContext, persist: boolean): void {
		activeName = name;
		applyTools(name, ctx);
		if (persist) pi.appendEntry<ModlistState>(STATE_ENTRY_TYPE, { name });
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
		const targetPackages = targetPackagesForProfile(profile, loaded.config.profiles, currentPackages);
		const packagesChanged = profile.extensions !== undefined && !packageSetsMatch(currentPackages, targetPackages);

		if (packagesChanged) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Switching to "${name}" changes extension packages and requires interactive confirmation`, "error");
				return;
			}
			const currentNames = new Set(currentPackages.map(packageSourceName));
			const targetNames = new Set(targetPackages.map(packageSourceName));
			const added = [...targetNames].filter((item) => !currentNames.has(item));
			const removed = [...currentNames].filter((item) => !targetNames.has(item));
			const details = [
				`Switch to modlist "${name}" and reload Pi resources?`,
				added.length > 0 ? `\nEnable: ${added.join(", ")}` : "",
				removed.length > 0 ? `\nDisable: ${removed.join(", ")}` : "",
				added.length === 0 && removed.length === 0 ? "\nPackage resource filters will change." : "",
			].join("");
			if (!(await ctx.ui.confirm("Change extension packages", details))) return;
		}

		setActiveProfile(name, ctx, true);
		if (!packagesChanged) {
			ctx.ui.notify(`Modlist "${name}" activated`, "info");
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
		if (!activeName) {
			return `No active modlist. Config: ${loaded.globalPath}`;
		}
		const profile = loaded.config.profiles[activeName];
		if (!profile) return `Active selection "${activeName}" is not defined in the current config.`;
		const desiredTools = profile.tools?.join(", ") ?? "unchanged";
		const desiredPackages = profile.extensions?.map(packageSourceName).join(", ") ?? "unchanged";
		const currentPackages = configuredPackages().map(packageSourceName).join(", ") || "(none)";
		return [
			`Active modlist: ${activeName}${profileHasDrift(activeName) ? " (drift detected; status shows !)" : ""}`,
			`Description: ${profile.description ?? "(none)"}`,
			`Active tools: ${pi.getActiveTools().join(", ") || "(none)"}`,
			`Profile tools: ${desiredTools || "(none)"}`,
			`Profile extension packages: ${desiredPackages || "(none)"}`,
			`Configured global packages: ${currentPackages}`,
			`Global config: ${loaded.globalPath}`,
			`Project config: ${loaded.projectExists ? loaded.projectPath : "(none)"}`,
		].join("\n");
	}

	async function saveProfile(name: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!name) {
			ctx.ui.notify("Usage: /modlist save <name>", "error");
			return;
		}
		const globalResult = parseConfig(globalConfigPath());
		if (globalResult.errors.length > 0) {
			for (const error of globalResult.errors) ctx.ui.notify(error, "error");
			return;
		}
		if (globalResult.config.profiles[name] && ctx.hasUI) {
			const overwrite = await ctx.ui.confirm("Overwrite modlist", `Replace global profile "${name}"?`);
			if (!overwrite) return;
		} else if (globalResult.config.profiles[name]) {
			ctx.ui.notify(`Global profile "${name}" already exists`, "error");
			return;
		}

		let packages: PackageSource[];
		try {
			packages = readGlobalPackages();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		globalResult.config.profiles[name] = {
			description: "Captured from the current Pi session",
			tools: pi.getActiveTools(),
			extensions: packages,
		};
		globalResult.config.default ??= name;
		writeJsonAtomic(globalConfigPath(), globalResult.config);
		refreshConfig(ctx);
		activeName = name;
		pi.appendEntry<ModlistState>(STATE_ENTRY_TYPE, { name });
		updateStatus(ctx);
		ctx.ui.notify(`Saved and activated global modlist "${name}"`, "info");
	}

	async function promptForEmptyProject(ctx: ExtensionContext): Promise<void> {
		if (startupPromptShown || ctx.mode !== "tui" || loaded.projectExists || !isEmptyProject(ctx.cwd)) return;
		startupPromptShown = true;
		const names = Object.keys(loaded.config.profiles).sort();
		if (names.length === 0) return;

		const labels = new Map<string, string>();
		for (const name of names) {
			labels.set(`${name} — ${describeProfile(loaded.config.profiles[name])}`, name);
		}
		const selected = await ctx.ui.select("Choose a modlist for this empty project", [
			...labels.keys(),
			KEEP_CURRENT_OPTION,
		]);
		if (!selected || selected === KEEP_CURRENT_OPTION) return;
		const name = labels.get(selected);
		if (!name) return;

		if (ctx.isProjectTrusted()) {
			writeJsonAtomic(loaded.projectPath, { default: name });
		} else {
			ctx.ui.notify(
				`Modlist "${name}" active for this session only (project not trusted; selection not saved)`,
				"info",
			);
		}
		refreshConfig(ctx);
		setActiveProfile(name, ctx, true);

		const profile = loaded.config.profiles[name];
		const currentPackages = configuredPackages();
		if (
			profile.extensions !== undefined &&
			!packageSetsMatch(currentPackages, targetPackagesForProfile(profile, loaded.config.profiles, currentPackages))
		) {
			ctx.ui.notify(
				`Selected modlist "${name}" and switched tools. Run /modlist ${name} to confirm extension changes and reload.`,
				"warning",
			);
		} else {
			ctx.ui.notify(`Selected modlist "${name}" for this project`, "info");
		}
	}

	pi.registerCommand("modlist", {
		description: "Show, save, or switch named tool and extension profiles",
		getArgumentCompletions: (prefix) => {
			const values = [
				"list",
				"status",
				"save ",
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
			if (input.startsWith("save ")) {
				await saveProfile(input.slice("save ".length).trim(), ctx);
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

			const restored = restoreProfileName(ctx);
			const requestedName = restored ?? loaded.config.default;
			if (requestedName && loaded.config.profiles[requestedName]) {
				activeName = requestedName;
				applyTools(requestedName, ctx, event.reason !== "reload");
			} else {
				activeName = undefined;
				if (requestedName) ctx.ui.notify(`Configured modlist "${requestedName}" does not exist`, "warning");
			}
			updateStatus(ctx);

			if (event.reason === "startup" || event.reason === "new") {
				await promptForEmptyProject(ctx);
			}
		} catch (error) {
			activeName = undefined;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "modlist:error"));
			ctx.ui.notify(`Modlist initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}
