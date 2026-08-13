import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TRACKED_FILES = 4_096;
const TEXT_EXTENSIONS = new Set([
	".css",
	".html",
	".js",
	".json",
	".md",
	".mjs",
	".ts",
	".txt",
	".yaml",
	".yml",
]);
// Minimal semantic allowlist for deliberate containment/schema attack literals.
// These exact values remain in tests to prove rejection; no prefix is allowed.
const EXACT_NEGATIVE_PATH_FIXTURES = new Set([
	"/-",
	"/-----BEGIN",
	"/20",
	"/BASE/gu",
	"/fork.",
	"/new",
	"/node",
	"/required",
	"/resyst-vault",
	"/session",
	"/shutdown",
	"/target",
	"/Proyectos/Atlas.md",
	"/absolute.md",
	"/abs/../escape.md",
	"/different/local/path",
	"/invalid_config/u",
	"/invalid_request/u",
	"/etc/passwd",
	"/outside/Atlas.md",
	"/outside/Injected.md",
	"/outside/projects",
	"/placeholder/vault",
	"/private/vault/path",
	"/private/vault/secret.md",
	"/proc/self/stat",
	"/tmp",
	"/root-looking/path",
	"/secret/Atlas.md",
	"/spoof",
	"\\\\server\\share.md",
	"/secret/vault/Atlas.md",
	"/tmp/escape.md",
]);
const PRIVATE_PATH_SEGMENT =
	/(?:^|\/)(?:Resyst Vault|journal|journals|receipt|receipts|backup|backups)(?:\/|$)/iu;
const DURABLE_ARTIFACT_FILE =
	/(?:^|[-_.])(?:journal|receipt|backup)(?:s|[-_.]|$)/iu;
const TOKEN_PATTERNS = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
	/\bnpm_[A-Za-z0-9]{20,}\b/u,
	/\bsk-(?:proj|ant)-[A-Za-z0-9_-]{16,}\b/u,
	/\bsk_(?:live|test)_[A-Za-z0-9_-]{16,}\b/u,
	/\bsk-ant-[A-Za-z0-9_-]{16,}\b/u,
	/\bAKIA[0-9A-Z]{16}\b/u,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
	/(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s"'<>]+/iu,
] as const;

interface TrackedBlob {
	file: string;
	mode: string;
	source: string;
}
interface Finding {
	file: string;
	line: number;
	rule: string;
}
interface FixtureManifest {
	version: 1;
	people: readonly string[];
	projects: readonly string[];
	remotes: readonly string[];
	timestamps: readonly string[];
	roots: readonly string[];
}

function unsafeTrackedPath(file: string): boolean {
	if (PRIVATE_PATH_SEGMENT.test(file)) return true;
	const productSource = new Set([
		"src/journal.ts",
		"dist/journal.js",
		"tests/unit/journal.test.ts",
		"src/rollback.ts",
		"dist/rollback.js",
		"tests/integration/rollback.test.ts",
	]);
	return (
		DURABLE_ARTIFACT_FILE.test(path.basename(file)) && !productSource.has(file)
	);
}

async function gitBuffer(
	arguments_: string[],
	maxBuffer = 8 * 1024 * 1024,
): Promise<Buffer> {
	const result = await execFileAsync("git", arguments_, {
		cwd: ROOT,
		encoding: "buffer",
		maxBuffer,
	});
	return Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout);
}

async function trackedBlobs(): Promise<TrackedBlob[]> {
	const entries = (await gitBuffer(["ls-files", "--stage", "-z"]))
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
	if (entries.length > MAX_TRACKED_FILES)
		throw new Error("tracked file budget exceeded");
	const blobs: TrackedBlob[] = [];
	for (const entry of entries) {
		const match = /^(\d{6}) [0-9a-f]{40,64} \d\t(.+)$/u.exec(entry);
		if (match === null) throw new Error("invalid tracked entry");
		const [, mode, file] = match;
		if (mode !== "100644" && mode !== "100755")
			throw new Error("nonregular tracked entry");
		if (path.isAbsolute(file!) || file!.split("/").includes(".."))
			throw new Error("unsafe tracked path");
		if (unsafeTrackedPath(file!))
			throw new Error("private durable artifact path");
		if (file !== ".gitignore" && !TEXT_EXTENSIONS.has(path.extname(file!)))
			throw new Error("unapproved tracked file type");
		const bytes = await gitBuffer(["show", `:${file}`], MAX_FILE_BYTES + 1);
		if (bytes.length > MAX_FILE_BYTES || bytes.includes(0))
			throw new Error("binary or oversized tracked blob");
		const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		blobs.push({ file: file!, mode: mode!, source });
	}
	return blobs.sort((left, right) => left.file.localeCompare(right.file));
}

function absolutePaths(text: string): string[] {
	const values = new Set<string>();
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])((?:\/[\p{L}\p{N}._-]+){2,})/gu,
	))
		values.add(match[1]!);
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])(\/[\p{L}\p{N}._-]+)(?![\/\p{L}\p{N}._-])/gu,
	))
		values.add(match[1]!);
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])([A-Za-z]:(?:\\|\/)[^\s`"'<>]+)/gu,
	))
		values.add(match[1]!);
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])(\\\\[\p{L}\p{N}._-]+[\\/][\p{L}\p{N}._-]+(?:[\\/][^\s`"'<>]+)?)/gu,
	))
		values.add(match[1]!);
	return [...values];
}

function approvedAbsolutePath(value: string): boolean {
	return (
		value === "/home/tester" ||
		value.startsWith("/home/tester/") ||
		EXACT_NEGATIVE_PATH_FIXTURES.has(value)
	);
}

export function scanText(file: string, source: string): Finding[] {
	const findings: Finding[] = [];
	const add = (line: number, rule: string): void => {
		findings.push({ file, line, rule });
	};
	const lines = source.split(/\r?\n/u);
	for (const [index, text] of lines.entries()) {
		const line = index + 1;
		if (/(?:^|[\/\\])Resyst Vault(?:[\/\\]|$)/u.test(text))
			add(line, "personal-vault-name");
		for (const value of absolutePaths(text))
			if (!approvedAbsolutePath(value)) add(line, "non-neutral-absolute-path");
		if (/\b[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/iu.test(text))
			add(line, "email-address");
		if (TOKEN_PATTERNS.some((pattern) => pattern.test(text)))
			add(line, "credential-token");
		if (/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/iu.test(text))
			add(line, "uuid-session-form");
		if (
			/(?<![A-Za-z0-9+/])[0-9a-hjkmnp-tv-z]{26}(?![A-Za-z0-9+/])/iu.test(text)
		)
			add(line, "ulid-session-form");
		if (/\b[0-9a-f]{64}\b/iu.test(text)) add(line, "private-derived-hash");
	}
	if (
		/["'](?:event_id|idempotency_key|before_hash|after_hash)["']\s*:/u.test(
			source,
		) &&
		/["'](?:created_at|outcome|source|targets)["']\s*:/u.test(source)
	)
		add(0, "durable-artifact-record");
	return findings;
}

function relevantFixtureSource(blobs: TrackedBlob[]): string {
	return blobs
		.filter(
			({ file }) =>
				file.startsWith("tests/") && !file.startsWith("tests/privacy/"),
		)
		.map(({ source }) => source)
		.join("\n");
}

function generateFixtureManifest(blobs: TrackedBlob[]): FixtureManifest {
	const fixture =
		blobs.find(({ file }) => file === "tests/fixtures/create-vault.ts")
			?.source ?? "";
	const plan =
		blobs.find(({ file }) => file.endsWith("resyst-vault-bridge-v1.md"))
			?.source ?? "";
	const corpus = relevantFixtureSource(blobs);
	const decodedCorpus = corpus.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
	const collect = (
		pattern: RegExp,
		normalize?: (value: string) => string,
	): string[] =>
		[
			...new Set(
				[...corpus.matchAll(pattern)].map(
					(match) => normalize?.(match[0]) ?? match[0],
				),
			),
		].sort();
	return {
		version: 1,
		people: [
			...new Set(
				[
					...decodedCorpus.matchAll(
						/^(?:- )?Name:\s*([A-Za-z][A-Za-z -]{0,63})$/gmu,
					),
				].map((match) => match[1]!),
			),
		].sort(),
		projects: [
			...[...fixture.matchAll(/^- \[\[([^\]\r\n]{1,128})\]\]$/gmu)]
				.map((match) => match[1]!)
				.filter((value) => !/^20\d\d-\d\d-\d\d$/u.test(value)),
			...[
				...decodedCorpus.matchAll(
					/^title:\s*([A-Za-z][A-Za-z0-9 _-]{0,127})$/gmu,
				),
			].map((match) => match[1]!),
		]
			.filter((value, index, values) => values.indexOf(value) === index)
			.sort(),
		remotes: collect(
			/(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|(?:https?|ssh):\/\/(?:[^\s/@]+(?::[^\s/@]*)?@)?[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|(?:git@[A-Za-z0-9.-]+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/gu,
			(value) =>
				value
					.replace(/^(?:https?|ssh):\/\/(?:[^\s/@]+(?::[^\s/@]*)?@)?/u, "")
					.replace(/^git@/u, "")
					.replace(":", "/")
					.replace(/\.git$/u, ""),
		),
		timestamps: collect(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z/gu),
		roots: plan.includes("/home/tester")
			? ["/home/tester", "temporary-test-directory"]
			: [],
	};
}

describe("public repository hygiene", () => {
	it("scans exact staged blobs and fails closed on all tracked modes and text", async () => {
		const blobs = await trackedBlobs();
		expect(blobs.length).toBeGreaterThan(0);
		expect(blobs.flatMap(({ file, source }) => scanText(file, source))).toEqual(
			[],
		);
	});

	it("detects representative path, credential, session and multiline artifact leaks", () => {
		const values = [
			["", "PersonalNotes"].join("/"),
			["cwd:", ["", "PersonalNotes"].join("/")].join(" "),
			["Vault at `", ["", "PersonalNotes"].join("/"), "`."].join(""),
			["C:", "private", "vault"].join("/"),
			["", "", "server", "share", "vault"].join("\\"),
			["", "données", "private", "vault"].join("/"),
			["", "mnt", "private", "vault.md"].join("/"),
			`npm_${"a".repeat(24)}`,
			`sk-proj-${"a".repeat(24)}`,
			["Resyst Vault", "private.md"].join("/"),
			["12345678", "1234", "7123", "8123", "123456789abc"].join("-"),
			JSON.stringify(
				{ event_id: "private", nested: { outcome: "applied" } },
				null,
				2,
			),
		].join("\n");
		expect(scanText("synthetic.md", values).map(({ rule }) => rule)).toEqual([
			"non-neutral-absolute-path",
			"non-neutral-absolute-path",
			"non-neutral-absolute-path",
			"non-neutral-absolute-path",
			"non-neutral-absolute-path",
			"non-neutral-absolute-path",
			"non-neutral-absolute-path",
			"credential-token",
			"credential-token",
			"personal-vault-name",
			"uuid-session-form",
			"durable-artifact-record",
		]);
		expect(unsafeTrackedPath("docs/private.receipt.yaml")).toBe(true);
		expect(unsafeTrackedPath("src/journal.ts")).toBe(false);
	});

	it("rejects stale packed dist content that bypasses tracked-blob scanning", async () => {
		const probeDirectory = path.join(ROOT, "dist/privacy-probe-test");
		const probe = path.join(probeDirectory, "payload.js");
		await mkdir(probeDirectory, { recursive: true });
		try {
			await writeFile(
				probe,
				[
					`export const root = "${["", "mnt", "alice", "PersonalNotes"].join("/")}";`,
					`export const windows = "${["C:", "private", "vault"].join("\\")}";`,
					`export const unc = "${["", "", "server", "share", "vault"].join("\\")}";`,
					`export const email = "${["alice", "example.com"].join("@")}";`,
					`export const ulid = "${["01arz3ndektsv4", "rrffq69g5fav"].join("")}";`,
					`export const hash = "${"a".repeat(64)}";`,
					`export const record = {\n  "${["event", "id"].join("_")}": "private",\n  "nested": { "outcome": "applied" }\n};`,
				].join("\n"),
				"utf8",
			);
			await expect(
				execFileAsync("node", ["scripts/check-artifact-manifest.mjs"], {
					cwd: ROOT,
				}),
			).rejects.toBeDefined();
		} finally {
			await rm(probeDirectory, { recursive: true, force: true });
		}
	});

	it("matches the complete generated synthetic fixture manifest", async () => {
		const blobs = await trackedBlobs();
		const manifestBlob = blobs.find(
			({ file }) => file === "tests/fixtures/public-manifest.json",
		);
		expect(manifestBlob).toBeDefined();
		const published = JSON.parse(manifestBlob!.source) as FixtureManifest;
		expect(published).toEqual(generateFixtureManifest(blobs));
		expect(published.people).toEqual(["Casey"]);
		expect(published.projects).toEqual(["Alpha", "Atlas", "Launchpad", "x"]);
		expect(published.remotes).toEqual(
			[
				"github.com/PrimeIntellect-ai/prime-agent",
				"github.com/tester/atlas",
				"github.com/upstream/atlas",
				"offline.invalid/resyst/vault",
			].sort(),
		);
		expect(published.roots).toEqual([
			"/home/tester",
			"temporary-test-directory",
		]);
		expect(published.timestamps.length).toBeGreaterThan(0);

		const replaceBlob = (
			file: string,
			replacement: (source: string) => string,
		): TrackedBlob[] =>
			blobs.map((blob) =>
				blob.file === file
					? { ...blob, source: replacement(blob.source) }
					: blob,
			);
		expect(
			generateFixtureManifest(
				replaceBlob("tests/fixtures/create-vault.ts", (source) =>
					source.replace("- [[Atlas]]", "- [[Private Project]]"),
				),
			).projects,
		).toContain("Private Project");
		expect(
			generateFixtureManifest(
				replaceBlob(
					"tests/fixtures/create-vault.ts",
					(source) =>
						`${source}\nconst privateIdentity = "header\\nName: Alice\\n";`,
				),
			).people,
		).toContain("Alice");
		expect(
			generateFixtureManifest(
				replaceBlob(
					"tests/unit/project.test.ts",
					(source) =>
						`${source}\nconst privateTitle = "header\\ntitle: Private\\n";`,
				),
			).projects,
		).toContain("Private");
		expect(
			generateFixtureManifest(
				replaceBlob(
					"tests/unit/project.test.ts",
					(source) =>
						`${source}\nconst privateRemote = "gitlab.example/casey/atlas";`,
				),
			).remotes,
		).toContain("gitlab.example/casey/atlas");
	});
});
