import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const allowedRootFiles = new Set(["README.md", "package.json"]);
const allowedDirectories = ["dist/", "docs/"];
const forbiddenNames =
	/(?:^|\/)(?:tests?|fixtures?|coverage|node_modules|src|scripts|\.github|\.git|\.resyst|journal|journals|receipt|receipts|backup|backups|pending)(?:\/|$)/iu;
const forbiddenExtensions = /\.(?:log|sqlite|db|bak|tmp)$/iu;
const MAX_ARTIFACT_FILES = 512;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const privateContent = [
	/\/(?:Users|root)\/[^\s`"'<>]+/u,
	/\/home\/(?!tester(?:\/|[\s`"'<>]|$))[^\s`"'<>]+/u,
	/\b(?:gh[pousr]_|github_pat_|npm_|sk_(?:live|test)_)[A-Za-z0-9_-]{16,}\b/u,
	/\bsk-(?:proj|ant)-[A-Za-z0-9_-]{16,}\b/u,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
	/(?:^|[\/\\])Resyst Vault(?:[\/\\]|$)/u,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
	/(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s"'<>]+/iu,
	/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/iu,
	/(?<![A-Za-z0-9+/])[0-9a-hjkmnp-tv-z]{26}(?![A-Za-z0-9+/])/iu,
	/\b[0-9a-f]{64}\b/iu,
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
];

const approvedAbsolutePaths = new Set([
	"/home/tester",
	"/tmp",
	"/proc/self/stat",
	"/-",
	"/fork.",
	"/new",
	"/shutdown",
]);

function absolutePaths(text) {
	const values = new Set();
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])((?:\/[\p{L}\p{N}._-]+){2,})/gu,
	))
		values.add(match[1]);
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])(\/[\p{L}\p{N}._-]+)(?![\/\p{L}\p{N}._-])/gu,
	))
		values.add(match[1]);
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])([A-Za-z]:(?:\\|\/)[^\s`"'<>]+)/gu,
	))
		values.add(match[1]);
	for (const match of text.matchAll(
		/(?:^|[\s`"'(=])(\\\\[\p{L}\p{N}._-]+[\\/][\p{L}\p{N}._-]+(?:[\\/][^\s`"'<>]+)?)/gu,
	))
		values.add(match[1]);
	return [...values];
}

function approvedAbsolutePath(value) {
	return (
		value === "/home/tester" ||
		value.startsWith("/home/tester/") ||
		value === "/tmp" ||
		value.startsWith("/tmp/") ||
		approvedAbsolutePaths.has(value)
	);
}

function fail() {
	process.stderr.write("artifact manifest invalid\n");
	process.exit(1);
}

function assertRegularAncestry(file) {
	let current = root;
	for (const segment of file.split("/")) {
		current = path.join(current, segment);
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) fail();
	}
}

try {
	const raw = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 8 * 1024 * 1024,
		},
	);
	const packs = JSON.parse(raw);
	if (
		!Array.isArray(packs) ||
		packs.length !== 1 ||
		!Array.isArray(packs[0]?.files)
	)
		fail();
	const files = packs[0].files.map((entry) => entry?.path).sort();
	if (
		files.length === 0 ||
		files.length > MAX_ARTIFACT_FILES ||
		new Set(files).size !== files.length
	)
		fail();
	let total = 0;
	for (const file of files) {
		if (
			typeof file !== "string" ||
			path.isAbsolute(file) ||
			file.includes("..")
		)
			fail();
		if (forbiddenNames.test(file) || forbiddenExtensions.test(file)) fail();
		if (
			!allowedRootFiles.has(file) &&
			!allowedDirectories.some((prefix) => file.startsWith(prefix))
		)
			fail();
		const absolute = path.join(root, file);
		if (!existsSync(absolute)) fail();
		assertRegularAncestry(file);
		const stat = lstatSync(absolute);
		if (!stat.isFile() || stat.isSymbolicLink()) fail();
		total += stat.size;
		if (total > MAX_ARTIFACT_BYTES) fail();
		const bytes = readFileSync(absolute);
		if (bytes.includes(0)) fail();
		const source = decoder.decode(bytes);
		if (privateContent.some((pattern) => pattern.test(source))) fail();
		if (
			/["'](?:event_id|idempotency_key|before_hash|after_hash)["']\s*:/u.test(
				source,
			) &&
			/["'](?:created_at|outcome|source|targets)["']\s*:/u.test(source)
		)
			fail();
		for (const line of source.split(/\r?\n/u))
			if (absolutePaths(line).some((value) => !approvedAbsolutePath(value)))
				fail();
	}
	const packageMetadata = JSON.parse(
		readFileSync(path.join(root, "package.json"), "utf8"),
	);
	if (packageMetadata.private !== true) fail();
	if (packageMetadata.peerDependencies !== undefined) fail();
	if (packageMetadata.engines?.node !== ">=22.19.0") fail();
	if (
		JSON.stringify(packageMetadata.pi?.extensions) !==
		JSON.stringify(["./dist/extension/index.js"])
	)
		fail();
	if (packageMetadata.bin?.["resyst-vault"] !== "./dist/cli.js") fail();
	if (
		!files.includes("dist/extension/index.js") ||
		!files.includes("dist/cli.js")
	)
		fail();
	if (
		JSON.stringify(packageMetadata.files) !==
		JSON.stringify(["dist/", "docs/", "README.md"])
	)
		fail();
	process.stdout.write(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
} catch {
	fail();
}
