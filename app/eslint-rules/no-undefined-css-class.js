/**
 * Flags a `className` literal token whose namespace does not exist in any stylesheet.
 *
 * A class string is the one part of a component nothing type-checks, so a typo or a
 * class from a deleted design system renders browser-default and ships that way. It
 * has happened repeatedly: `.input` (three files), `.button--danger` (two), the
 * `report-dialog__*` pair, and `export-format` -- which left the GeoJSON row without
 * the `.export-modal__format` its two siblings had.
 *
 * Only a *fully orphaned* namespace is reported. A BEM block whose children are
 * styled (`.disambig` with 18 `.disambig__*` rules) is a deliberate anchor, not a
 * mistake, and flagging those would be the noise that gets a rule switched off.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
import fs from "node:fs";
import path from "node:path";

let cache = null;

function collectClasses(dir) {
	const found = new Set();
	const walk = (d) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".css")) {
				const css = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
				for (const [, , selector] of css.matchAll(/(^|\})([^{}]*)\{/gm)) {
					for (const [, cls] of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) found.add(cls);
				}
			}
		}
	};
	walk(dir);
	return found;
}

export default {
	meta: {
		type: "problem",
		messages: {
			undefinedClass:
				'"{{token}}" matches no rule in any stylesheet, so it styles nothing. Fix the name or add the rule.',
		},
	},
	create(context) {
		const src = path.join(context.cwd ?? process.cwd(), "src");
		if (!cache) {
			cache = fs.existsSync(src) ? collectClasses(src) : new Set();
		}
		const defined = cache;
		if (defined.size === 0) return {};

		const hasNamespace = (token) => {
			if (defined.has(token)) return true;
			for (const cls of defined) {
				if (cls.startsWith(`${token}__`) || cls.startsWith(`${token}--`)) return true;
			}
			return false;
		};

		return {
			JSXAttribute(node) {
				if (node.name?.name !== "className") return;
				if (node.value?.type !== "Literal" || typeof node.value.value !== "string") return;

				for (const token of node.value.value.split(/\s+/)) {
					if (token && !hasNamespace(token)) {
						context.report({
							node: node.value,
							messageId: "undefinedClass",
							data: { token },
						});
						return;
					}
				}
			},
		};
	},
};
