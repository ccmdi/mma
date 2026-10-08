/**
 * `api.ts` decides nothing per member. A module listed there has its whole export list
 * on the surface and a module that is not listed has nothing on it, so whether a symbol
 * is public is settled by the file it lives in. The surface literal may spread a module
 * flat or mount a whole module namespace under one key -- both are all-or-nothing -- but
 * never build an object of its own or pick members.
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
		const wholeModule = (p) =>
			p.type === "SpreadElement" ||
			(p.type === "Property" && !p.computed && p.value.type === "Identifier");
		return {
			VariableDeclarator(node) {
				const init = node.init;
				if (!init || init.type !== "ObjectExpression") return;
				if (init.properties.every(wholeModule)) return;
				context.report({ node: init, messageId: "handwritten" });
			},
		};
	},
};
