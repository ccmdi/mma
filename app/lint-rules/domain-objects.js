import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const OBJECTS = {
	"store/store": "Store",
	"store/maps": "Maps",
	"store/tag": "Tag",
	"store/location": "Location",
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
};
const objects = new Map(
	Object.entries(OBJECTS).map(([module, name]) => [resolve(srcDir, module), name]),
);
const objectName = (source, filename) => {
	const target = source.startsWith("@/")
		? resolve(srcDir, source.slice(2))
		: source.startsWith(".")
			? resolve(dirname(filename), source)
			: null;
	return target ? objects.get(target.replace(/\.tsx?$/, "")) : undefined;
};

export default {
	meta: {
		type: "problem",
		schema: [],
		messages: {
			canonical: "Import the domain object as {{name}}",
			barrel: "Import domain objects directly from their owning modules; do not re-export them.",
		},
	},
	create(context) {
		const imported = new Set();
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
