import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const companions = new Map();
/** The companion a module exports: an object named for its file, capitalized. */
const companionOf = (module) => {
	if (!companions.has(module)) {
		const base = basename(module);
		const name = base[0].toUpperCase() + base.slice(1);
		let source = "";
		try {
			source = readFileSync(`${module}.ts`, "utf8");
		} catch {}
		const exported = new RegExp(`^export const ${name}\\b`, "m").test(source);
		companions.set(module, exported ? name : undefined);
	}
	return companions.get(module);
};

const objectName = (source, filename) => {
	const target = source.startsWith("@/")
		? resolve(srcDir, source.slice(2))
		: source.startsWith(".")
			? resolve(dirname(filename), source)
			: null;
	return target ? companionOf(target.replace(/\.tsx?$/, "")) : undefined;
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
