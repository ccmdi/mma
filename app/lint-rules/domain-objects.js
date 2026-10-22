import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
/** Every companion object, by the module under `src` that owns it. */
const COMPANIONS = {
	"store/store": "Store",
	"store/maps": "Maps",
	"store/tag": "Tag",
	"store/location": "Location",
	"store/layer": "Layer",
	"store/editor": "Editor",
	"store/history": "History",
	"store/commit": "Commit",
	"store/field": "Field",
	"store/selectionList": "SelectionList",
	"store/feed": "Feed",
	"store/mutation": "Mutation",
	"store/query": "Query",
	"store/edit": "Edit",
	"store/autosave": "Autosave",
	"store/commitDiff": "CommitDiff",
	"store/import": "Import",
	"store/savedSelection": "SavedSelection",
	"lib/render/scene": "Scene",
	"lib/map/host": "MapHost",
	"lib/review/review": "Review",
	"lib/seen/seen": "Seen",
	"lib/sv/pano": "Pano",
	"lib/data/procedure": "Procedure",
	"lib/data/provider": "Provider",
	"lib/account": "Account",
	"plugins/collab/sessions": "Sessions",
	"plugins/collab/presence": "Presence",
};

const objects = new Map(
	Object.entries(COMPANIONS).map(([module, name]) => [resolve(srcDir, module), name]),
);
const withoutExtension = (path) => path.replace(/\.tsx?$/, "");
const objectName = (source, filename) => {
	const target = source.startsWith("@/")
		? resolve(srcDir, source.slice(2))
		: source.startsWith(".")
			? resolve(dirname(filename), source)
			: null;
	return target ? objects.get(withoutExtension(target)) : undefined;
};
/** The name a module's companion takes: its file name, capitalized. Only plain modules have one. */
const companionNameOf = (filename) => {
	if (!filename.endsWith(".ts")) return null;
	const base = basename(filename, ".ts");
	return base[0].toUpperCase() + base.slice(1);
};

/** Names of the objects a declaration exports, built as a literal or by a factory call. */
function exportedObjects(declaration) {
	if (declaration?.type !== "VariableDeclaration") return [];
	return declaration.declarations.flatMap((d) =>
		d.id.type === "Identifier" &&
		(d.init?.type === "ObjectExpression" || d.init?.type === "CallExpression")
			? [d.id.name]
			: [],
	);
}

export default {
	meta: {
		type: "problem",
		schema: [],
		messages: {
			canonical: "Import the domain object as {{name}}",
			barrel: "Import domain objects directly from their owning modules; do not re-export them.",
			unrostered:
				"{{name}} is a companion object; add its module to COMPANIONS in lint-rules/domain-objects.js.",
		},
	},
	create(context) {
		const imported = new Set();
		const ownName = companionNameOf(context.filename);
		const rostered = objects.has(withoutExtension(resolve(context.filename)));
		return {
			ImportDeclaration(node) {
				if (node.importKind === "type") return;
				const name = objectName(node.source.value, context.filename);
				if (!name) return;
				for (const specifier of node.specifiers) {
					if (specifier.importKind === "type") continue;
					imported.add(specifier.local.name);
					if (
						specifier.type !== "ImportSpecifier" ||
						specifier.imported.name !== name ||
						specifier.local.name !== name
					)
						context.report({ node: specifier, messageId: "canonical", data: { name } });
				}
			},
			ExportAllDeclaration(node) {
				if (node.exportKind !== "type" && objectName(node.source.value, context.filename))
					context.report({ node, messageId: "barrel" });
			},
			ExportNamedDeclaration(node) {
				if (node.exportKind === "type") return;
				if (!rostered && ownName && exportedObjects(node.declaration).includes(ownName))
					context.report({ node, messageId: "unrostered", data: { name: ownName } });
				const domainSource = node.source && objectName(node.source.value, context.filename);
				for (const specifier of node.specifiers) {
					if (specifier.exportKind === "type") continue;
					if (domainSource || (!node.source && imported.has(specifier.local.name)))
						context.report({ node: specifier, messageId: "barrel" });
				}
			},
		};
	},
};
