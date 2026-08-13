import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
	copyFile,
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
	chmod,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const PRIME_HOST_COMMIT = "83a0f9f9566219551fcb6ffaf7f519a815749a58";
const PRIME_HOST_VERSION = "0.7.2";

const run = promisify(execFile);
const project = path.resolve(".");
const root = await mkdtemp(path.join(os.tmpdir(), "resyst-prime-smoke-"));
const savedEnv = { ...process.env };
const npmCache =
	process.env.npm_config_cache ?? path.join(os.homedir(), ".npm");
const bootstrapHome = path.join(root, "bootstrap-home");
const bootstrapTmp = path.join(root, "bootstrap-tmp");
await mkdir(bootstrapHome, { recursive: true });
await mkdir(bootstrapTmp, { recursive: true });
const bootstrapEnv = {
	PATH: process.env.PATH ?? "",
	HOME: bootstrapHome,
	XDG_CONFIG_HOME: path.join(bootstrapHome, ".config"),
	XDG_STATE_HOME: path.join(bootstrapHome, ".state"),
	XDG_CACHE_HOME: path.join(bootstrapHome, ".cache"),
	TMPDIR: bootstrapTmp,
	GIT_TERMINAL_PROMPT: "0",
	npm_config_cache: npmCache,
	npm_config_audit: "false",
	npm_config_fund: "false",
};
const primeHost = path.join(
	project,
	"node_modules",
	".cache",
	`resyst-prime-host-${PRIME_HOST_COMMIT.slice(0, 12)}`,
);

async function preparePrimeHost() {
	await mkdir(path.dirname(primeHost), { recursive: true });
	if (!(await stat(path.join(primeHost, ".git")).catch(() => undefined))) {
		await rm(primeHost, { recursive: true, force: true });
		await run(
			"git",
			[
				"clone",
				"--quiet",
				"--filter=blob:none",
				"--no-checkout",
				"https://github.com/PrimeIntellect-ai/prime-agent.git",
				primeHost,
			],
			{ env: bootstrapEnv },
		);
	}
	await run("git", ["reset", "--hard", PRIME_HOST_COMMIT], {
		cwd: primeHost,
		env: bootstrapEnv,
	});
	await run("git", ["clean", "-ffd"], {
		cwd: primeHost,
		env: bootstrapEnv,
	});
	for (const workspaceName of ["tui", "ai", "agent", "coding-agent"]) {
		await rm(path.join(primeHost, "packages", workspaceName, "dist"), {
			recursive: true,
			force: true,
		});
	}
	await run(
		"npm",
		["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
		{ cwd: primeHost, env: bootstrapEnv },
	);
	for (const [command, args] of [
		["npm", ["run", "build", "-w", "packages/tui"]],
		[
			path.join(primeHost, "node_modules", ".bin", "tsgo"),
			["-p", "packages/ai/tsconfig.build.json"],
		],
		["npm", ["run", "build", "-w", "packages/agent"]],
		["npm", ["run", "build", "-w", "packages/coding-agent"]],
	]) {
		await run(command, args, { cwd: primeHost, env: bootstrapEnv });
	}
	assert.equal(
		(
			await run("git", ["rev-parse", "HEAD"], {
				cwd: primeHost,
				env: bootstrapEnv,
			})
		).stdout.trim(),
		PRIME_HOST_COMMIT,
	);
	assert.equal(
		JSON.parse(
			await readFile(
				path.join(primeHost, "packages", "coding-agent", "package.json"),
				"utf8",
			),
		).version,
		PRIME_HOST_VERSION,
	);
	return import(
		pathToFileURL(
			path.join(primeHost, "packages", "coding-agent", "dist", "index.js"),
		).href
	);
}

const agentDir = path.join(root, "agent");
const workspace = path.join(root, "workspace", "atlas");
const vault = path.join(root, "vault");
const configHome = path.join(root, "home", ".config");
const stateHome = path.join(root, "state");
const sourceRepo = path.join(root, "source");
const packDir = path.join(root, "pack");
const wrapper = path.join(root, "offline-npm.mjs");
const wrapperLog = path.join(root, "npm.log");
const gitConfig = path.join(root, "gitconfig");
const sessions = [];
let Prime;
let LegacyPrime;
const today = new Date().toISOString().slice(0, 10);

function context(manager) {
	return {
		cwd: workspace,
		sessionManager: manager,
		model: undefined,
		hasUI: false,
		isIdle: () => true,
		isProjectTrusted: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "BASE",
		getSystemPromptOptions: () => ({}),
		compact: () => undefined,
		abort: () => undefined,
		shutdown: () => undefined,
		ui: {},
	};
}

async function sessionFile(depth, id) {
	const directory = path.join(root, "sessions");
	await mkdir(directory, { recursive: true });
	const manager = Prime.SessionManager.create(workspace, directory);
	manager.newSession({ id, rlmDepth: depth });
	manager.flushNow();
	assert.equal(manager.getHeader()?.rlmDepth, depth);
	assert.equal(manager.isPersisted(), true);
	return manager;
}

try {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, {
		PATH: savedEnv.PATH ?? "",
		HOME: path.join(root, "home"),
		XDG_CONFIG_HOME: configHome,
		XDG_STATE_HOME: stateHome,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_GLOBAL: gitConfig,
		HTTP_PROXY: "http://127.0.0.1:9",
		HTTPS_PROXY: "http://127.0.0.1:9",
		ALL_PROXY: "http://127.0.0.1:9",
		NO_PROXY: "",
		npm_config_cache: npmCache,
	});
	for (const key of Object.keys(process.env)) {
		if (/(?:API_KEY|TOKEN|SECRET)$/u.test(key)) delete process.env[key];
	}
	Prime = await preparePrimeHost();
	LegacyPrime = await import("@earendil-works/pi-coding-agent");
	assert.equal(Prime.VERSION, PRIME_HOST_VERSION);
	await mkdir(packDir, { recursive: true });
	const packed = JSON.parse(
		(
			await run(
				"npm",
				["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
				{ cwd: project },
			)
		).stdout,
	);
	const tarball = path.join(packDir, packed[0].filename);
	await mkdir(sourceRepo, { recursive: true });
	await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", sourceRepo]);
	await copyFile(
		path.join(project, "package-lock.json"),
		path.join(sourceRepo, "package-lock.json"),
	);
	assert.equal(
		JSON.parse(await readFile(path.join(sourceRepo, "package.json"), "utf8")).pi
			.extensions[0],
		"./dist/extension/index.js",
	);
	await run("git", ["init", "-q", "-b", "main"], { cwd: sourceRepo });
	await run("git", ["add", "."], { cwd: sourceRepo });
	await run(
		"git",
		[
			"-c",
			"user.name=Casey",
			"-c",
			["user.email=tester", "example.invalid"].join("@"),
			"commit",
			"-qm",
			"synthetic package",
		],
		{ cwd: sourceRepo },
	);
	const sha = (
		await run("git", ["rev-parse", "HEAD"], { cwd: sourceRepo })
	).stdout.trim();
	await writeFile(
		gitConfig,
		`[url "file://${sourceRepo}"]\n\tinsteadOf = https://offline.invalid/resyst/vault\n`,
		"utf8",
	);
	await writeFile(
		wrapper,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(${JSON.stringify(wrapperLog)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv.slice(2).join(" ") !== "install") process.exit(9);
const result = spawnSync("npm", ["ci", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: process.cwd(), stdio: "inherit", env: process.env });
process.exit(result.status ?? 8);
`,
		"utf8",
	);
	await chmod(wrapper, 0o755);

	await mkdir(path.join(vault, ".resyst"), { recursive: true });
	for (const directory of [
		"Notas Diarias",
		"Proyectos",
		"Inbox",
		"_plantillas",
		"_adjuntos",
	])
		await mkdir(path.join(vault, directory), { recursive: true });
	await writeFile(
		path.join(vault, "CLAUDE.md"),
		"# Resyst Vault\n\n## Identity\n- Name: Casey\n",
		"utf8",
	);
	await writeFile(
		path.join(vault, "MOC — Inicio.md"),
		"# Inicio\n\n- [[Atlas]]\n",
		"utf8",
	);
	await writeFile(
		path.join(vault, "_plantillas", "Daily Note.md"),
		"# {{date}}\n\n## Tareas\n\n## Reflexión\n\n## Notas\n\n## Enlaces del día\n",
		"utf8",
	);
	await writeFile(
		path.join(vault, "Proyectos", "Atlas.md"),
		"---\nresyst_project:\n  id: atlas\n---\n# Atlas\n\n## Estado\nmanual\n",
		"utf8",
	);
	await writeFile(
		path.join(vault, "Notas Diarias", `${today}.md`),
		`# ${today}\n\n## Tareas\n\n## Reflexión\n\n## Notas\n\n## Enlaces del día\n`,
		"utf8",
	);
	await writeFile(
		path.join(vault, ".resyst", "agent-vault.yaml"),
		`version: 1\nlayout:\n  daily_dir: "Notas Diarias"\n  projects_dir: "Proyectos"\n  inbox_dir: "Inbox"\n  templates_dir: "_plantillas"\n  attachments_dir: "_adjuntos"\ntemplates:\n  daily: "_plantillas/Daily Note.md"\nmanaged_headings:\n  tareas: "## Tareas"\n  reflexion: "## Reflexión"\n  notas: "## Notas"\n  enlaces: "## Enlaces del día"\nbudget:\n  context_tokens: 5000\nconventions:\n  project_frontmatter_field: "resyst_project"\n`,
		"utf8",
	);
	await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
	await writeFile(
		path.join(configHome, "resyst-vault", "config.json"),
		JSON.stringify({
			version: 1,
			host_id: "casey",
			vault_path: vault,
			project_overrides: [{ path: workspace, project_id: "atlas" }],
		}),
		"utf8",
	);
	await mkdir(workspace, { recursive: true });

	const settings = Prime.SettingsManager.inMemory({
		npmCommand: [wrapper],
		enableInstallTelemetry: false,
		enableAnalytics: false,
	});
	const packages = new Prime.DefaultPackageManager({
		cwd: workspace,
		agentDir,
		settingsManager: settings,
		bundledSkillsDir: null,
	});
	const source = `git:https://offline.invalid/resyst/vault@${sha}`;
	await packages.installAndPersist(source);
	const installed = packages.getInstalledPath(source, "user");
	assert.ok(installed);
	assert.equal(
		(await run("git", ["rev-parse", "HEAD"], { cwd: installed })).stdout.trim(),
		sha,
	);
	assert.equal((await readFile(wrapperLog, "utf8")).trim(), "install");
	const extensionPath = path.join(installed, "dist", "extension", "index.js");
	assert.equal((await stat(extensionPath)).isFile(), true);
	assert.equal(await realpath(extensionPath), extensionPath);
	const installedModules = path.join(installed, "node_modules");
	assert.equal((await stat(installedModules)).isDirectory(), true);
	assert.equal(await realpath(installedModules), installedModules);
	assert.notEqual(
		await realpath(installedModules),
		await realpath(path.join(project, "node_modules")),
	);
	for (const dependency of ["typebox", "yaml"]) {
		const dependencyPath = path.join(installedModules, dependency);
		assert.equal((await stat(dependencyPath)).isDirectory(), true);
		assert.equal(await realpath(dependencyPath), dependencyPath);
	}

	for (const [depth, id] of [
		[0, "session-root"],
		[1, "session-child"],
	]) {
		const loader = new Prime.DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			settingsManager: settings,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.deepEqual(
			loader.getExtensions().extensions.map((item) => item.resolvedPath),
			[extensionPath],
		);
		const manager = await sessionFile(depth, id);
		const { session, extensionsResult } = await Prime.createAgentSession({
			cwd: workspace,
			agentDir,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: manager,
			noTools: "builtin",
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		sessions.push(session);
		await session.bindExtensions({ mode: "rpc" });
		const expected =
			depth === 0
				? ["vault_checkpoint", "vault_read", "vault_search"]
				: ["vault_read", "vault_search"];
		const extensionTools = session
			.getAllTools()
			.map((tool) => tool.name)
			.filter((name) => name.startsWith("vault_"))
			.sort();
		assert.deepEqual(extensionTools, expected);
		assert.deepEqual(session.getActiveToolNames().sort(), expected);
		const extension = extensionsResult.extensions[0];
		assert.equal(
			(extension.handlers.get("before_agent_start") ?? []).length,
			1,
		);
		const runner = session._extensionRunner;
		assert.ok(runner);
		const beforeResult = await runner.emitBeforeAgentStart(
			"synthetic",
			undefined,
			"BASE",
			{},
		);
		if (depth === 0) {
			const systemPrompt = beforeResult?.systemPrompt ?? "";
			assert.match(
				systemPrompt,
				new RegExp(["BEGIN", "RESYST", "VAULT", "CONTEXT"].join(" "), "u"),
			);
			assert.match(systemPrompt, /Atlas/);
			assert.doesNotMatch(
				systemPrompt,
				new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
			);
			const before = await readFile(
				path.join(vault, "Notas Diarias", `${today}.md`),
				"utf8",
			);
			const tool = session.getToolDefinition("vault_checkpoint");
			assert.ok(tool);
			const result = await tool.execute(
				"noop-smoke",
				{ version: 1, kind: "noop", reason: "no_new_knowledge" },
				undefined,
				undefined,
				context(manager),
			);
			assert.equal(result.details?.outcome, "noop");
			assert.equal(
				await readFile(
					path.join(vault, "Notas Diarias", `${today}.md`),
					"utf8",
				),
				before,
			);
		} else {
			assert.equal(beforeResult, undefined);
			assert.equal(session.getToolDefinition("vault_checkpoint"), undefined);
		}
	}
	const legacySettings = LegacyPrime.SettingsManager.inMemory({
		enableInstallTelemetry: false,
		enableAnalytics: false,
	});
	const legacyLoader = new LegacyPrime.DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager: legacySettings,
		additionalExtensionPaths: [extensionPath],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await legacyLoader.reload();
	assert.deepEqual(legacyLoader.getExtensions().errors, []);
	const legacyManager = LegacyPrime.SessionManager.inMemory(workspace);
	assert.equal(legacyManager.getHeader()?.rlmDepth, undefined);
	const legacyResult = await LegacyPrime.createAgentSession({
		cwd: workspace,
		agentDir,
		resourceLoader: legacyLoader,
		settingsManager: legacySettings,
		sessionManager: legacyManager,
		noTools: "builtin",
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	sessions.push(legacyResult.session);
	await legacyResult.session.bindExtensions({ mode: "rpc" });
	assert.deepEqual(
		legacyResult.session
			.getAllTools()
			.map((tool) => tool.name)
			.filter((name) => name.startsWith("vault_"))
			.sort(),
		["vault_read", "vault_search"],
	);
	assert.equal(
		legacyResult.session.getToolDefinition("vault_checkpoint"),
		undefined,
	);
	assert.equal(
		await legacyResult.session._extensionRunner?.emitBeforeAgentStart(
			"synthetic",
			undefined,
			"BASE",
			{},
		),
		undefined,
	);

	process.stdout.write(
		JSON.stringify({
			version: 1,
			prime: Prime.VERSION,
			legacy: LegacyPrime.VERSION,
			outcome: "ok",
		}) + "\n",
	);
} finally {
	for (const session of sessions) session.dispose();
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	await rm(root, { recursive: true, force: true });
}
