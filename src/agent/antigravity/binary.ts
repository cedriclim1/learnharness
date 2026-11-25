import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	cwd?: string;
	isExecutable: (filePath: string) => boolean;
};

type SearchSpec = {
	paths: path.PlatformPath;
	names: string[];
	knownDirs: string[];
};

function getWindowsSearchSpec(env: BinaryLookup["env"], homeDir: string): SearchSpec {
	const paths = path.win32;
	const appData = env.APPDATA ?? paths.join(homeDir, "AppData", "Roaming");
	const localAppData = env.LOCALAPPDATA ?? paths.join(homeDir, "AppData", "Local");

	return {
		paths,
		names: ["agy.exe", "antigravity.exe"],
		knownDirs: [
			paths.join(localAppData, "agy", "bin"),
			paths.join(localAppData, "Programs", "Antigravity"),
			paths.join(homeDir, ".local", "bin"),
			paths.join(homeDir, ".local", "share", "mise", "shims"),
			env.npm_config_prefix ?? paths.join(appData, "npm"),
		],
	};
}

function getPosixSearchSpec(env: BinaryLookup["env"], homeDir: string): SearchSpec {
	const paths = path.posix;
	const npmBin = env.npm_config_prefix
		? paths.join(env.npm_config_prefix, "bin")
		: paths.join(homeDir, ".npm-global", "bin");

	return {
		paths,
		names: ["agy", "antigravity"],
		knownDirs: [
			paths.join(homeDir, ".local", "bin"),
			paths.join(homeDir, ".local", "share", "mise", "shims"),
			paths.join(homeDir, ".local", "share", "mise", "installs", "antigravity-cli", "latest"),
			paths.join(homeDir, ".gemini", "antigravity", "bin"),
			paths.join(homeDir, ".config", "Antigravity", "bin"),
			npmBin,
			"/opt/homebrew/bin",
			"/usr/local/bin",
			...(env.USER ? [paths.join("/etc/profiles/per-user", env.USER, "bin")] : []),
			paths.join(homeDir, ".nix-profile", "bin"),
			"/run/current-system/sw/bin",
			"/usr/bin",
		],
	};
}

export function resolveAntigravityBinary({ env, platform, homeDir, cwd = process.cwd(), isExecutable }: BinaryLookup): string | null {
	const { paths, names, knownDirs } = platform === "win32"
		? getWindowsSearchSpec(env, homeDir)
		: getPosixSearchSpec(env, homeDir);

	if (env.LH_AGY_BINARY) {
		const explicit = paths.resolve(cwd, env.LH_AGY_BINARY);
		return isExecutable(explicit) ? explicit : null;
	}

	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
	for (const name of names) {
		for (const dir of [...pathDirs, ...knownDirs]) {
			const candidate = paths.resolve(cwd, dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}

	return null;
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getAntigravityBinary(env: NodeJS.ProcessEnv = process.env): string | null {
	return resolveAntigravityBinary({
		env,
		platform: process.platform,
		homeDir: os.homedir(),
		isExecutable: isExecutableFile,
	});
}
