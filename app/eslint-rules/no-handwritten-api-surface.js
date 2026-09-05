/**
 * `api.ts` decides nothing. A module listed there has its whole export list on the
 * surface and a module that is not listed has nothing on it, so whether a symbol is
 * public is settled by the file it lives in. A namespace object written here would
 * quietly reintroduce per-member curation, so the file holds imports, type aliases,
 * the `MMA` interface, and the spread literal -- and no object of its own.
 *
 * Nesting is the one exception a spread cannot express: a nested key must come from a
 * module that exports it (see `components/primitives/ui.ts`), not from a literal here.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
	meta: {
		type: "problem",
		messages: {
			handwritten:
				"Namespace objects belong in the module they describe, not in api.ts. Export it from that module and spread the module instead.",
		},
	},
	create(context) {
		const spreadOnly = (node) => node.properties.every((p) => p.type === "SpreadElement");
		return {
			VariableDeclarator(node) {
				const init = node.init;
				if (!init || init.type !== "ObjectExpression") return;
				if (spreadOnly(init)) return;
				context.report({ node: init, messageId: "handwritten" });
			},
		};
	},
};
