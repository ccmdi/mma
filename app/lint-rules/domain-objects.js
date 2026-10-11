import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const storeDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/store");
const modules = new Set([
	"store",
	"maps",
	"tag",
	"location",
	"editor",
	"history",
	"commit",
	"field",
	"selectionList",
	"feed",
	"mutation",
	"query",
	"edit",
	"autosave",
]);
const moduleName = (source, filename) => {
	const target = source.startsWith("@/")
		? resolve(storeDir, "..", source.slice(2))
		: source.startsWith(".")
			? resolve(dirname(filename), source)
			: null;
	if (!target || dirname(target) !== storeDir) return null;
	const name = basename(target).replace(/\.tsx?$/, "");
	return modules.has(name) ? name[0].toUpperCase() + name.slice(1) : null;
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
				const name = moduleName(node.source.value, context.filename);
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
				if (node.exportKind !== "type" && moduleName(node.source.value, context.filename))
					context.report({ node, messageId: "barrel" });
			},
			ExportNamedDeclaration(node) {
				if (node.exportKind === "type") return;
				const domainSource = node.source && moduleName(node.source.value, context.filename);
				for (const specifier of node.specifiers) {
					if (specifier.exportKind === "type") continue;
					if (domainSource || (!node.source && imported.has(specifier.local.name)))
						context.report({ node: specifier, messageId: "barrel" });
				}
			},
		};
	},
};
