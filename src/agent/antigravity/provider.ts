import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

export const ANTIGRAVITY_API = "antigravity-cli" as const;

export function makeAntigravityModel(id: string, name: string): Model<Api> {
	return {
		id,
		name,
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		// Internal compaction budgets only; effective CLI limits and prices are unknown.
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export const ANTIGRAVITY_DEFAULT_MODEL: Model<Api> = makeAntigravityModel("default", "Antigravity · CLI default");

// Fallback catalog when dynamic `agy models` discovery has not run or fails.
// Default follows the user's CLI model. Explicit slugs fail if the account lacks access.
const FALLBACK_ENTRIES = [
	["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
	["gemini-4-neon-high", "Gemini 4 Neon (High)"],
	["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
	["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
	["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
	["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"],
	["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
	["gemini-4-argon-high", "Gemini 4 Argon (High)"],
	["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
	["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
	["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
	["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
	["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
	["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"],
	["gemini-pro-orchestrator", "Orchestrator (Carbon)"],
	["gemini-pro-orchestrator-argon", "Orchestrator (Argon)"],
	["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
	["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
	["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
	["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
	["gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"],
	["gemini-3.6-flash-high", "Gemini 3.6 Flash (High)"],
	["gemini-3.6-flash-medium", "Gemini 3.6 Flash (Medium)"],
	["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
	["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
	["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
	["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
	["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
	["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
] as const;

export const ANTIGRAVITY_MODELS: Model<Api>[] = [
	ANTIGRAVITY_DEFAULT_MODEL,
	...FALLBACK_ENTRIES.map(([id, name]) => makeAntigravityModel(id, name)),
];

const DISCOVERED_KEY = Symbol.for("lh.antigravity-discovered-models");
const discoveredGlobal = globalThis as typeof globalThis & { [DISCOVERED_KEY]?: readonly Model<Api>[] | null };

const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const HEADER_WORDS = new Set(["slug", "id", "model", "models", "name", "available", "alias"]);

/** Parse `agy models` stdout lines (`<slug>  <display name>`). */
export function parseAntigravityModelsOutput(stdout: string): Model<Api>[] {
	const seen = new Set<string>(["default"]);
	const parsed: Model<Api>[] = [];
	for (const rawLine of stdout.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("-") || line.startsWith("#")) continue;
		// Strip optional bullet or active-model marker (e.g. `* gemini-...`).
		const cleaned = line.replace(/^[*•▸>]\s+/, "");
		const match = /^([a-z][a-z0-9._-]{1,127})\s+(.+)$/i.exec(cleaned);
		if (!match) continue;
		const slug = match[1]!;
		const name = match[2]!.trim();
		if (!name || HEADER_WORDS.has(slug.toLowerCase())) continue;
		// Real CLI model slugs contain at least one hyphen, dot, or digit.
		if (!/[-.\d]/.test(slug)) continue;
		if (seen.has(slug)) continue;
		seen.add(slug);
		parsed.push(makeAntigravityModel(slug, name));
	}
	return parsed;
}

export function setDiscoveredAntigravityModels(models: readonly Model<Api>[] | null): void {
	discoveredGlobal[DISCOVERED_KEY] = models && models.length > 0 ? [...models] : null;
}

export function getAntigravityModels(): Model<Api>[] {
	const discovered = discoveredGlobal[DISCOVERED_KEY];
	if (discovered && discovered.length > 0) {
		return [ANTIGRAVITY_DEFAULT_MODEL, ...discovered.filter((m) => m.id !== "default")];
	}
	return [...ANTIGRAVITY_MODELS];
}

export function createAntigravityProvider(stream: StreamFunction<Api, SimpleStreamOptions>): Provider {
	const base = createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Google Antigravity CLI",
		auth: { apiKey: { name: "Google account sign-in", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: ANTIGRAVITY_MODELS,
		api: { stream, streamSimple: stream },
	});
	return {
		...base,
		getModels: () => getAntigravityModels(),
		getAllModels: () => getAntigravityModels(),
	};
}
