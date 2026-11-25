import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { resolveAntigravityBinary } from "../src/agent/antigravity/binary.ts";
import {
	ANTIGRAVITY_MODELS,
	getAntigravityModels,
	parseAntigravityModelsOutput,
	setDiscoveredAntigravityModels,
} from "../src/agent/antigravity/provider.ts";
import {
	AGY_STRIPPED_AUTH_ENV_VARS,
	antigravityChildEnv,
	createAntigravityStream,
	parseActions,
	type RunAntigravity,
} from "../src/agent/antigravity/stream.ts";
import { piModels } from "../src/agent/models.ts";
import { isProviderKeyRefusal, providerKeyMissing, sanitizeUserSettings } from "../src/core/settings.ts";
import { antigravityInstallationResponse } from "../src/server/antigravity.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import { callCost } from "../src/server/pricing.ts";
import { SETTINGS_SECTIONS } from "../src/server/settings-body.ts";

const model = ANTIGRAVITY_MODELS[0]!;
const tool: Tool = {
	name: "quiz",
	description: "Ask a quiz",
	parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
};
const context = normalizeContext({
	systemPrompt: "Teach carefully",
	tools: [tool],
	messages: [{ role: "user", content: "Teach addition", timestamp: 0 }],
});

function fakeRun(output: object, code = 0, stderrText = "") {
	const calls: { args: string[]; cwd: string; prompt: string; settings: Record<string, unknown>; env: NodeJS.ProcessEnv }[] = [];
	const run: RunAntigravity = (_binary, args, options) => {
		assert.equal(statSync(options.cwd).mode & 0o777, 0o700);
		assert.equal(statSync(options.cwd + "/request.txt").mode & 0o777, 0o600);
		calls.push({
			args,
			cwd: options.cwd,
			prompt: readFileSync(options.cwd + "/request.txt", "utf8"),
			settings: JSON.parse(args[args.indexOf("--settings") + 1]!),
			env: options.env,
		});
		const script = [
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			stderrText ? `process.stderr.write(${JSON.stringify(stderrText)});` : "",
			`process.stdout.write(${JSON.stringify(JSON.stringify({ event: "result", result: output }) + "\n")});`,
			`process.exitCode = ${code};`,
			"});",
		].join(" ");
		return spawn(process.execPath, ["-e", script], { stdio: "pipe" });
	};
	return { run, calls };
}

function success(structured_output: unknown) {
	return { status: "SUCCESS", structured_output, usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 } };
}

test("Antigravity emits admitted harness tools and keeps subscription auth/overages explicit", async () => {
	const { run, calls } = fakeRun(success({ text: "Try this", toolCalls: [{ name: "quiz", arguments: { question: "1+1?" } }] }));
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context, { reasoning: "medium" });
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(result.content.map((b) => b.type), ["text", "toolCall"]);
	assert.equal(result.usage.input, 70);
	assert.equal(result.usage.cacheRead, 30);
	assert.equal(result.usage.totalTokens, 120);
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(calls[0]!.settings.useG1Credits, false);
	assert.ok(calls[0]!.prompt.includes("Teach carefully"));
	assert.ok(calls[0]!.prompt.includes("Teach addition"));
	assert.ok(!calls[0]!.args.includes("--model"));
	assert.ok(!calls[0]!.args.includes("--dangerously-skip-permissions"));
	assert.equal(existsSync(calls[0]!.cwd), false);
});

test("Antigravity requests explicit model slugs and passes xhigh/max effort levels", async () => {
	const { run, calls } = fakeRun(success({ text: "Done", toolCalls: [] }));
	const stream = createAntigravityStream(run, () => "/fake/agy")(ANTIGRAVITY_MODELS[1]!, context, { reasoning: "xhigh" });
	await stream.result();
	assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--model") + 1], ANTIGRAVITY_MODELS[1]!.id);
	assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--effort") + 1], "xhigh");

	const { run: runMax, calls: maxCalls } = fakeRun(success({ text: "Done", toolCalls: [] }));
	await createAntigravityStream(runMax, () => "/fake/agy")(ANTIGRAVITY_MODELS[1]!, context, { reasoning: "max" }).result();
	assert.equal(maxCalls[0]!.args[maxCalls[0]!.args.indexOf("--effort") + 1], "max");
});

test("Antigravity strips Google API-key and ADC environment variables from child env", () => {
	const saved = Object.fromEntries(AGY_STRIPPED_AUTH_ENV_VARS.map((k) => [k, process.env[k]]));
	try {
		for (const key of AGY_STRIPPED_AUTH_ENV_VARS) process.env[key] = "secret-value";
		const env = antigravityChildEnv();
		for (const key of AGY_STRIPPED_AUTH_ENV_VARS) assert.equal(env[key], undefined);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("a real Pi agent executes harness tools and replays tool results to the next CLI request", async () => {
	let index = 0;
	const responses = [
		fakeRun(success({ text: "", toolCalls: [{ name: "check", arguments: { answer: 2 } }] })),
		fakeRun(success({ text: "Correct: two", toolCalls: [] })),
	];
	const run: RunAntigravity = (...args) => responses[index++]!.run(...args);
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: "Teach addition",
			tools: [{
				name: "check",
				label: "Check",
				description: "Check the answer",
				parameters: Type.Object({ answer: Type.Number() }),
				execute: async (_id, args) => ({ content: [{ type: "text", text: `Answer ${(args as { answer: number }).answer} is correct` }], details: {} }),
			}],
		},
		streamFn: createAntigravityStream(run, () => "/fake/agy"),
	});
	await agent.prompt("What is one plus one?");
	assert.equal(index, 2);
	assert.ok(responses[1]!.calls[0]!.prompt.includes("Answer 2 is correct"));
	assert.equal(agent.state.messages.at(-1)?.role, "assistant");
	assert.ok(JSON.stringify(agent.state.messages.at(-1)).includes("Correct: two"));
});

test("invalid tool names and missing structured output fail without executing tools", async () => {
	assert.throws(() => parseActions({ text: "", toolCalls: [{ name: "bash", arguments: {} }] }, [tool]), /undeclared/);
	for (const payload of [undefined, { text: "", toolCalls: [{ name: "bash", arguments: {} }] }]) {
		const { run, calls } = fakeRun(success(payload));
		const stream = createAntigravityStream(run, () => "/fake/agy")(model, context);
		assert.equal((await stream.result()).stopReason, "error");
		// Consume through cleanup, which follows the terminal event.
		for await (const _event of stream) { /* drain */ }
		assert.equal(existsSync(calls[0]!.cwd), false);
	}
});

test("CLI authentication errors stay structured while raw stderr is logged server-side and redacted", async () => {
	const { run } = fakeRun({ status: "ERROR", error: "authentication required" }, 1);
	const result = await createAntigravityStream(run, () => "/fake/agy")(model, context).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /authentication required/);

	const logged: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
	try {
		const rawStderrRun: RunAntigravity = () => spawn(process.execPath, [
			"-e",
			"process.stderr.write('SENSITIVE_INTERNAL_TRACE_12345'); process.exit(1);",
		], { stdio: "pipe" });
		const rawFailure = await createAntigravityStream(rawStderrRun, () => "/fake/agy")(model, context).result();
		assert.equal(rawFailure.stopReason, "error");
		assert.doesNotMatch(rawFailure.errorMessage!, /SENSITIVE_INTERNAL_TRACE_12345/);
		assert.match(rawFailure.errorMessage!, /Check server logs/);
		assert.ok(logged.some((line) => line.includes("SENSITIVE_INTERNAL_TRACE_12345")));
	} finally {
		console.error = origError;
	}

	const missing = await createAntigravityStream(run, () => null)(model, context).result();
	assert.match(missing.errorMessage!, /not found/);
});

test("cancellation terminates a waiting child and removes private files", async () => {
	const controller = new AbortController();
	let cwd = "";
	const run: RunAntigravity = (_binary, _args, options) => {
		cwd = options.cwd;
		const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "pipe" });
		setTimeout(() => controller.abort(), 30);
		return child;
	};
	const stream = createAntigravityStream(run, () => "/fake/agy")(model, context, { signal: controller.signal } as SimpleStreamOptions);
	for await (const _event of stream) { /* drain through cleanup */ }
	assert.equal((await stream.result()).stopReason, "aborted");
	assert.equal(existsSync(cwd), false);
});

test("binary discovery honors LH_AGY_BINARY and finds both agy and antigravity", () => {
	assert.equal(
		resolveAntigravityBinary({
			env: { LH_AGY_BINARY: "/custom/bin/agy", PATH: "/usr/bin" },
			platform: "darwin",
			homeDir: "/Users/test",
			isExecutable: (p) => p === "/custom/bin/agy",
		}),
		"/custom/bin/agy",
	);
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "/usr/bin" },
			platform: "linux",
			homeDir: "/home/test",
			isExecutable: (p) => p === "/home/test/.local/share/mise/shims/antigravity",
		}),
		"/home/test/.local/share/mise/shims/antigravity",
	);
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "/opt/homebrew/bin" },
			platform: "darwin",
			homeDir: "/Users/test",
			isExecutable: (p) => p === "/opt/homebrew/bin/agy",
		}),
		"/opt/homebrew/bin/agy",
	);
});

test("dynamic `agy models` parsing updates the live Pi provider catalog and keeps CLI default first", () => {
	try {
		const parsed = parseAntigravityModelsOutput([
			"Available models:",
			"-----------------",
			"  gemini-4-neon-xhigh       Gemini 4 Neon (XHigh)",
			"* gemini-4-carbon-high      Gemini 4 Carbon (High)",
			"  gemini-4-neon-xhigh       Duplicate Should Be Ignored",
			"  \x1b[32mgemini-3.8-flash-medium\x1b[0m   Gemini 3.8 Flash (Medium)",
		].join("\n"));
		assert.deepEqual(parsed.map((m) => [m.id, m.name]), [
			["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
			["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
			["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
		]);
		setDiscoveredAntigravityModels(parsed);
		const live = getAntigravityModels();
		assert.equal(live[0]!.id, "default");
		assert.equal(live.length, 4);
		assert.equal(piModels().getModel("antigravity", "gemini-4-neon-xhigh")?.name, "Gemini 4 Neon (XHigh)");
	} finally {
		setDiscoveredAntigravityModels(null);
	}
	assert.ok(getAntigravityModels().length >= 10);
});

test("/api/antigravity enforces same-origin intent header and opt-in guard before spawning CLI", async () => {
	let inspected = 0;
	const inspect = async () => {
		inspected++;
		return { state: "ready" as const, version: "1.5.8" };
	};
	const missingHeader = await antigravityInstallationResponse(
		new Request("http://localhost:3000/api/antigravity"),
		inspect,
		() => true,
	);
	assert.equal(missingHeader.status, 403);
	assert.equal(inspected, 0);

	const disabled = await antigravityInstallationResponse(
		new Request("http://localhost:3000/api/antigravity", {
			headers: { "x-learnharness-antigravity": "1", origin: "http://localhost:3000" },
		}),
		inspect,
		() => false,
	);
	assert.equal(disabled.status, 403);
	assert.equal(inspected, 0);

	const enabled = await antigravityInstallationResponse(
		new Request("http://localhost:3000/api/antigravity", {
			headers: { "x-learnharness-antigravity": "1", origin: "http://localhost:3000" },
		}),
		inspect,
		() => true,
	);
	assert.equal(enabled.status, 200);
	assert.equal(enabled.headers.get("x-content-type-options"), "nosniff");
	assert.deepEqual(await enabled.json(), { state: "ready", version: "1.5.8" });
	assert.equal(inspected, 1);
});

test("Antigravity settings sanitize, validate, and report unknown prices and limits", () => {
	assert.deepEqual(SETTINGS_SECTIONS.antigravity({ enabled: true }), { ok: true, settings: { enabled: true } });
	assert.equal(SETTINGS_SECTIONS.antigravity({ enabled: "true" }).ok, false);
	assert.deepEqual(sanitizeUserSettings({ antigravity: { enabled: true } })?.antigravity, { enabled: true });
	const refusal = providerKeyMissing("antigravity", ["strong"]);
	assert.equal(isProviderKeyRefusal(refusal.error), true);
	const dto = toModelDto(model);
	assert.equal(dto.cost, null);
	assert.equal(dto.contextWindow, null);
	assert.equal(dto.maxTokens, null);
	assert.equal(callCost({ inputTokens: 100, outputTokens: 10 }, "antigravity:default"), null);
});
