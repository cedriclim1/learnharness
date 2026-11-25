import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAntigravityBinary } from "../agent/antigravity/binary.ts";
import { parseAntigravityModelsOutput, setDiscoveredAntigravityModels } from "../agent/antigravity/provider.ts";
import { antigravityChildEnv } from "../agent/antigravity/stream.ts";
import type { AntigravityStatus } from "../core/contracts/antigravity.ts";
import { settingsStore } from "../store/settings.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const execFileAsync = promisify(execFile);
const MODEL_DISCOVERY_TTL_MS = 60_000;

let lastDiscoveryAt = 0;
let lastDiscoveryBinary: string | null = null;
let inflightDiscovery: Promise<void> | undefined;

export function antigravityEnabled(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled === true;
}

export function antigravityAvailable(): boolean {
	return antigravityEnabled() && getAntigravityBinary() !== null;
}

/** Refresh available models from `agy models` when opted in and installed.
 *  Falls back silently to the curated model list on failure or timeout. */
export async function refreshAntigravityModels(options: { force?: boolean } = {}): Promise<void> {
	if (!antigravityEnabled()) {
		setDiscoveredAntigravityModels(null);
		lastDiscoveryAt = 0;
		lastDiscoveryBinary = null;
		return;
	}
	const binary = getAntigravityBinary();
	if (!binary) {
		setDiscoveredAntigravityModels(null);
		lastDiscoveryAt = 0;
		lastDiscoveryBinary = null;
		return;
	}
	const now = Date.now();
	if (!options.force && lastDiscoveryBinary === binary && now - lastDiscoveryAt < MODEL_DISCOVERY_TTL_MS) {
		return;
	}
	if (inflightDiscovery && !options.force) return inflightDiscovery;
	initAuthEnv();
	const run = (async () => {
		try {
			const { stdout } = await execFileAsync(binary, ["models"], {
				timeout: 5000,
				maxBuffer: 128 * 1024,
				env: antigravityChildEnv(),
			});
			const parsed = parseAntigravityModelsOutput(stdout);
			setDiscoveredAntigravityModels(parsed.length > 0 ? parsed : null);
		} catch {
			// Keep existing discovered models if any, or fall back to built-in defaults.
		} finally {
			lastDiscoveryAt = Date.now();
			lastDiscoveryBinary = binary;
		}
	})();
	inflightDiscovery = run;
	try {
		await run;
	} finally {
		if (inflightDiscovery === run) inflightDiscovery = undefined;
	}
}

export async function inspectAntigravityInstallation(): Promise<AntigravityStatus> {
	initAuthEnv();
	const binary = getAntigravityBinary();
	if (!binary) return { state: "not-found", version: null };
	try {
		const env = antigravityChildEnv();
		const { stdout: help, stderr } = await execFileAsync(binary, ["--help"], { timeout: 5000, maxBuffer: 64 * 1024, env });
		const supported = (help + stderr).includes("--settings") && (help + stderr).includes("--json-schema");
		const { stdout: version } = await execFileAsync(binary, ["--version"], { timeout: 5000, maxBuffer: 4096, env });
		const trimmed = version.trim();
		const match = /\b(\d+\.\d+\.\d+)\b/.exec(trimmed);
		const status: AntigravityStatus = {
			state: supported ? "ready" : "unsupported",
			version: match ? match[1]! : null,
		};
		if (supported) {
			await refreshAntigravityModels({ force: true });
		}
		return status;
	} catch {
		return { state: "unsupported", version: null };
	}
}

/** Same-origin browser intent, not user authentication. No CORS grants. */
export async function antigravityInstallationResponse(
	request: Request,
	inspect = inspectAntigravityInstallation,
	enabled = antigravityEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (
		request.method !== "GET"
		|| !origin
		|| request.headers.get("x-learnharness-antigravity") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)
	) {
		return Response.json({ error: "Antigravity checks require a same-origin LearnHarness request." }, { status: 403, headers });
	}
	if (!enabled()) {
		return Response.json({ error: "Antigravity CLI is disabled." }, { status: 403, headers });
	}
	return Response.json(await inspect(), { headers });
}
