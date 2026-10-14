import { globSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { startCompiler, ts } from "./native-ts.mjs";
import { FLOOR, blockedGlobals, blockedMembers, toBcdOwner } from "./browser-compat-data.mjs";

const root = path.resolve(import.meta.dirname, "..");
const memberNames = new Set([...blockedMembers.values()].flatMap((members) => [...members.keys()]));
const floor = Object.entries(FLOOR)
	.map(([browser, version]) => `${browser} ${version}`)
	.join(" / ");

function isReference(node) {
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
	if (ts.isShorthandPropertyAssignment(parent)) return true;
	if (parent.name === node || parent.propertyName === node || parent.label === node) return false;
	if (ts.isQualifiedName(parent) && parent.right === node) return false;
	return !ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent);
}

/** Check only real comment trivia, so directive text in a string/template cannot suppress errors. */
function collectSuppressions(source, node, comments, suppressions, diagnostics) {
	const ranges = [
		...(ts.getLeadingCommentRanges(source.text, node.pos) ?? []),
		...(ts.getTrailingCommentRanges(source.text, node.end) ?? []),
	];
	for (const range of ranges) {
		if (comments.has(range.pos)) continue;
		comments.add(range.pos);
		const text = source.text
			.slice(
				range.pos + 2,
				range.kind === ts.SyntaxKind.MultiLineCommentTrivia ? range.end - 2 : range.end,
			)
			.trim();
		if (!text.startsWith("browser-compat-disable-next-line")) continue;
		const location = source.getLineAndCharacterOfPosition(range.pos);
		if (!/^browser-compat-disable-next-line\s+--\s*\S.*$/.test(text)) {
			diagnostics.push({
				file: source.fileName,
				line: location.line + 1,
				column: location.character + 1,
				message: "A browser compatibility suppression requires a reason after --.",
			});
			continue;
		}
		const targetLine = source.getLineAndCharacterOfPosition(range.end).line + 1;
		suppressions.set(targetLine, { location, used: false });
	}
}

/** @typedef {{file: string, line: number, column: number, name?: string, message: string}} Diagnostic */

/** Batch symbol resolution keeps the Node/Go boundary out of the per-property hot path.
 * @param {import("@typescript/native/unstable/sync").Project} project
 * @param {string[]} files
 * @returns {Diagnostic[]}
 */
export function checkProject(project, files) {
	const { program, checker } = project;
	/** @type {Diagnostic[]} */
	const diagnostics = [];
	const globals = [],
		members = [],
		sources = new Map(),
		seen = new Set();
	for (const file of files) {
		const source = program.getSourceFile(file);
		if (!source)
			throw new Error(`Browser compatibility: ${file} is missing from ${project.configFileName}`);
		const suppressions = new Map(),
			comments = new Set();
		const hasDirectives = source.text.includes("browser-compat-disable-next-line");
		sources.set(source, suppressions);
		function visit(node) {
			if (hasDirectives) collectSuppressions(source, node, comments, suppressions, diagnostics);
			if (
				ts.isIdentifier(node) &&
				isReference(node) &&
				(blockedGlobals.has(node.text) || blockedMembers.has(node.text))
			)
				globals.push(node);
			if (ts.isPropertyAccessExpression(node) && memberNames.has(node.name.text))
				members.push(node);
			node.forEachChild(visit);
		}
		visit(source);
	}
	function report(node, name, req) {
		if (seen.has(node)) return;
		seen.add(node);
		const source = node.getSourceFile(),
			location = source.getLineAndCharacterOfPosition(node.getStart(source));
		const suppression = sources.get(source).get(location.line);
		if (suppression) {
			suppression.used = true;
			return;
		}
		diagnostics.push({
			file: source.fileName,
			line: location.line + 1,
			column: location.character + 1,
			name,
			message: `${name} needs ${req}; our floor is ${floor}. Raise FLOOR in scripts/browser-compat-data.mjs only if you mean to stop supporting older macOS and WebKitGTK.`,
		});
	}
	const symbols = checker.getSymbolAtLocation(globals);
	for (let i = 0; i < globals.length; i++) {
		const node = globals[i];
		const symbol = ts.isShorthandPropertyAssignment(node.parent)
			? checker.getShorthandAssignmentValueSymbol(node.parent)
			: symbols[i];
		// Ambient declarations in library files remain globals; imports and local bindings do not.
		if (symbol?.declarations.some((decl) => decl.path === node.getSourceFile().path)) continue;
		const req = blockedGlobals.get(node.text);
		if (req) report(node, node.text, req);
		const parent = node.parent;
		if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
			const memberReq = blockedMembers.get(node.text)?.get(parent.name.text);
			if (memberReq) report(parent.name, `${node.text}.${parent.name.text}`, memberReq);
		}
	}
	const memberSymbols = checker.getSymbolAtLocation(members.map((node) => node.name));
	for (let i = 0; i < members.length; i++) {
		for (const handle of memberSymbols[i]?.declarations ?? []) {
			if (!program.getSourceFileMetadataByPath(handle.path)?.isDefaultLibrary) continue;
			const declaration = handle.resolve(project);
			const owner = toBcdOwner(declaration?.parent?.name?.text);
			const req = blockedMembers.get(owner)?.get(members[i].name.text);
			if (req) report(members[i].name, `${owner}.${members[i].name.text}`, req);
		}
	}
	for (const [source, suppressions] of sources) {
		for (const { location, used } of suppressions.values()) {
			if (!used)
				diagnostics.push({
					file: source.fileName,
					line: location.line + 1,
					column: location.character + 1,
					message: "Unused browser compatibility suppression.",
				});
		}
	}
	return diagnostics;
}

export function checkBrowserCompatibility() {
	const ignored = new Set(["src/bindings.gen.ts", "src/components/manual/manual-img-dims.gen.ts"]);
	const files = globSync(["src/**/*.ts", "src/**/*.tsx", "test/e2e/**/*.ts", "test/e2e/**/*.tsx"], {
		cwd: root,
	})
		.filter((file) => !ignored.has(file.replaceAll("\\", "/")))
		.sort();
	const api = startCompiler({ cwd: root });
	try {
		const configs = ["tsconfig.app.json", "test/tsconfig.json"].map((file) =>
			path.join(root, file),
		);
		const snapshot = api.updateSnapshot({ openProjects: configs });
		try {
			const diagnostics = configs.flatMap((config, index) => {
				const project = snapshot.getProject(config);
				if (!project) throw new Error(`Browser compatibility: could not load ${config}`);
				return checkProject(
					project,
					files
						.filter((file) => file.replaceAll("\\", "/").startsWith("test/") === (index === 1))
						.map((file) => path.join(root, file)),
				);
			});
			return { diagnostics, files: files.length };
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const start = performance.now();
	const { diagnostics, files } = checkBrowserCompatibility();
	for (const diagnostic of diagnostics)
		console.error(
			`${path.relative(root, diagnostic.file)}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
		);
	console.log(
		`[browser-compat] ${files} files, ${diagnostics.length} errors (${((performance.now() - start) / 1000).toFixed(2)}s)`,
	);
	process.exitCode = diagnostics.length ? 1 : 0;
}
