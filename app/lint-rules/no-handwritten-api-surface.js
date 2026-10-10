/** `api.ts` exposes whole modules, either flat or under a namespace.
 * Public members are determined by their source module; the API must not pick individual exports. */
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
