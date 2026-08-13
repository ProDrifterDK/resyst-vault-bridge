import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { resolveProject } from "../../src/project.js";
import { createProductionService } from "../../src/extension/tools.js";
import { createProductionCheckpointService } from "../../src/checkpoint-service.js";
import { normalizeCheckpoint } from "../../src/checkpoint.js";
import { JournalStore } from "../../src/journal.js";
import { LocalLock } from "../../src/lock.js";
import { VaultPaths } from "../../src/paths.js";
import { RecoveryService } from "../../src/recovery.js";
import { buildWritePlans } from "../../src/render.js";
import { RollbackService } from "../../src/rollback.js";
import {
	TransactionCrashError,
	TransactionService,
} from "../../src/transaction.js";
import type { CheckpointCommand } from "../../src/checkpoint-contract.js";
import type { ProjectId, VaultPath } from "../../src/types.js";
import { createVault } from "../fixtures/create-vault.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

const command: CheckpointCommand = {
	version: 1,
	kind: "apply",
	knowledge: {
		completed_tasks: [{ text: "Completed Atlas canary", evidence: ["test-1"] }],
		decisions: [],
		status_changes: [{ text: "Atlas is canary-green", evidence: ["test-1"] }],
		blockers: [],
		reusable_learnings: [],
		next_steps: [],
	},
	evidence: {
		commits: [],
		tests: [{ id: "test-1", value: "synthetic canary" }],
		files: [],
		deployments: [],
		observations: [],
	},
	targets: { daily: true, project: true, landscape: false },
};

describe("synthetic end-to-end canary", () => {
	it("resolves and reads Atlas before an idempotent daily plus project apply", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "resyst-canary-"));
		roots.push(root);
		const vaultPath = path.join(root, "vault");
		const workspace = path.join(root, "workspace", "atlas");
		const configHome = path.join(root, "config");
		const stateHome = path.join(root, "state");
		const vault = await createVault({
			vaultPath,
			withDailyNote: true,
			withProjectNote: true,
			dailyNoteDate: "2026-08-11",
		});
		await mkdir(workspace, { recursive: true });
		await writeFile(
			vault.absolute("Proyectos/Atlas.md"),
			`---
resyst_project:
  id: atlas
  repos:
    - github.com/tester/atlas
---
MANUAL-PROJECT-PREFIX
# Atlas

## Estado
manual status
MANUAL-PROJECT-SUFFIX
`,
			"utf8",
		);
		await mkdir(path.join(configHome, "resyst-vault"), { recursive: true });
		await writeFile(
			path.join(configHome, "resyst-vault", "config.json"),
			JSON.stringify({ version: 1, host_id: "casey", vault_path: vaultPath }),
			"utf8",
		);
		const config = await loadConfig({ xdgConfigHome: configHome });
		const git = async () => ({
			ok: true as const,
			stdout:
				"origin https://github.com/tester/atlas.git (fetch)\norigin https://github.com/tester/atlas.git (push)\n",
			stderr: "",
		});
		await expect(
			resolveProject({ cwd: workspace, config, git }),
		).resolves.toEqual({
			kind: "resolved",
			project_id: "atlas",
			basis: "remote",
			note_path: "Proyectos/Atlas.md",
		});
		const readService = createProductionService({
			xdgConfigHome: configHome,
			xdgStateHome: stateHome,
			now: () => new Date("2026-08-11T12:00:00.000Z"),
			git,
		});
		const bootstrap = await readService.bootstrap({ cwd: workspace });
		expect(bootstrap).toContain("Atlas");
		expect(bootstrap).not.toContain(root);
		const search = await readService.search({
			query: "manual status",
			limit: 5,
		});
		expect(search.hits.some((hit) => hit.path === "Proyectos/Atlas.md")).toBe(
			true,
		);
		const note = await readService.read({
			path: "Proyectos/Atlas.md",
			heading: "## Estado",
		});
		expect(note.content).toContain("manual status");

		const dailyBefore = await readFile(
			vault.dailyNoteAbsolute("2026-08-11"),
			"utf8",
		);
		const projectBefore = await readFile(
			vault.absolute("Proyectos/Atlas.md"),
			"utf8",
		);
		const trusted = { cwd: workspace, session_id: "session-canary-atlas" };
		const resolution = {
			kind: "resolved" as const,
			project_id: "atlas" as ProjectId,
			basis: "remote" as const,
			note_path: "Proyectos/Atlas.md" as VaultPath,
		};
		const normalized = normalizeCheckpoint(
			{
				...command,
				source: {
					agent: "prime-agent",
					host_id: "casey",
					session_id: trusted.session_id,
					cwd: trusted.cwd,
				},
				project: { id: "atlas" },
			},
			resolution,
		);
		expect(normalized.kind).toBe("apply");
		if (normalized.kind !== "apply")
			throw new Error("synthetic checkpoint did not normalize");
		const dryRun = buildWritePlans({
			checkpoint: normalized.checkpoint,
			effective_targets: normalized.effective_targets,
			resolution,
			project_title: "Atlas",
			snapshots: {
				daily: dailyBefore,
				project: projectBefore,
				moc: await readFile(vault.paths.moc, "utf8"),
				claude: await readFile(vault.paths.claudeMd, "utf8"),
			},
			template_source: await readFile(vault.paths.dailyTemplate, "utf8"),
			config: {
				daily_dir: config.layout.daily_dir,
				managed_headings: config.managed_headings,
			},
			date: "2026-08-11",
		});
		expect(dryRun.kind).toBe("plan");
		if (dryRun.kind !== "plan")
			throw new Error("synthetic dry-run unavailable");
		expect(dryRun.plans.map((plan) => plan.reason).sort()).toEqual([
			"daily_update",
			"project_update",
		]);
		expect(await readFile(vault.dailyNoteAbsolute("2026-08-11"), "utf8")).toBe(
			dailyBefore,
		);
		expect(await readFile(vault.absolute("Proyectos/Atlas.md"), "utf8")).toBe(
			projectBefore,
		);
		expect(await readdir(vault.paths.journalDir)).toEqual([]);
		expect(await readdir(vault.paths.receiptsDir)).toEqual([]);
		expect(
			await readFile(
				path.join(stateHome, "resyst-vault", "cache", "lexical-index-v1.json"),
				"utf8",
			),
		).toContain("Proyectos/Atlas.md");
		const journal = new JournalStore({
			vaultRoot: config.vault_path,
			identity: config.vault_identity,
			now: () => "2026-08-11T12:00:00.000Z",
		});
		let crashed = false;
		const crashingTransaction = new TransactionService({
			vaultRoot: config.vault_path,
			stateRoot: stateHome,
			journal,
			config,
			now: () => "2026-08-11T12:00:00.000Z",
			afterRename: async () => {
				if (!crashed) {
					crashed = true;
					throw new TransactionCrashError();
				}
			},
		});
		const checkpoint = createProductionCheckpointService({
			xdgConfigHome: configHome,
			xdgStateHome: stateHome,
			now: () => new Date("2026-08-11T12:00:00.000Z"),
			git,
			journal,
			transaction: crashingTransaction,
		});
		await expect(
			checkpoint.checkpoint({ command, trusted }),
		).rejects.toBeInstanceOf(TransactionCrashError);
		const cleanTransaction = new TransactionService({
			vaultRoot: config.vault_path,
			stateRoot: stateHome,
			journal,
			config,
			now: () => "2026-08-11T12:01:00.000Z",
		});
		const recovery = new RecoveryService({
			journal,
			transaction: cleanTransaction,
			now: () => "2026-08-11T12:01:00.000Z",
		});
		const recovered = await recovery.recover();
		expect(recovered).toMatchObject({
			kind: "recovered",
			completed_event_ids: [expect.stringMatching(/^apply-/u)],
			deferred_event_ids: [],
			failed_event_ids: [],
		});
		const dailyAfter = await readFile(
			vault.dailyNoteAbsolute("2026-08-11"),
			"utf8",
		);
		const projectAfter = await readFile(
			vault.absolute("Proyectos/Atlas.md"),
			"utf8",
		);
		expect(dailyAfter).toContain("Completed Atlas canary");
		expect(projectAfter).toContain("Atlas is canary-green");
		expect(projectAfter).toContain("MANUAL-PROJECT-PREFIX");
		expect(projectAfter).toContain("MANUAL-PROJECT-SUFFIX");
		await expect(checkpoint.checkpoint({ command, trusted })).resolves.toEqual({
			outcome: "already_applied",
		});
		expect(await readFile(vault.dailyNoteAbsolute("2026-08-11"), "utf8")).toBe(
			dailyAfter,
		);
		expect(await readFile(vault.absolute("Proyectos/Atlas.md"), "utf8")).toBe(
			projectAfter,
		);
		if (
			recovered.kind !== "recovered" ||
			recovered.completed_event_ids.length !== 1
		)
			throw new Error("synthetic recovery did not complete one event");
		const paths = new VaultPaths(config.vault_path, {
			identity: config.vault_identity,
		});
		const rollback = new RollbackService({
			vaultRoot: config.vault_path,
			stateRoot: stateHome,
			identity: config.vault_identity,
			paths,
			journal,
			lock: new LocalLock({
				stateRoot: stateHome,
				pid: process.pid,
				processStart: "canary",
			}),
			now: () => "2026-08-11T12:02:00.000Z",
		});
		const rollbackRequest = {
			target_event_id: recovered.completed_event_ids[0]!,
			event_id: "rollback-canary-atlas",
			idempotency_key: "c".repeat(64),
		};
		expect((await rollback.rollback(rollbackRequest)).kind).toBe("rolled_back");
		expect(await readFile(vault.dailyNoteAbsolute("2026-08-11"), "utf8")).toBe(
			dailyBefore,
		);
		expect(await readFile(vault.absolute("Proyectos/Atlas.md"), "utf8")).toBe(
			projectBefore,
		);
		expect((await rollback.rollback(rollbackRequest)).kind).toBe(
			"already_rolled_back",
		);
	});

	it("declares the built extension and Prime compatibility floor", async () => {
		const metadata = JSON.parse(
			await readFile(path.resolve("package.json"), "utf8"),
		) as {
			engines?: { node?: string };
			pi?: { extensions?: string[] };
		};
		expect(metadata.pi?.extensions).toEqual(["./dist/extension/index.js"]);
		expect(metadata.engines?.node).toBe(">=22.19.0");
	});
});
