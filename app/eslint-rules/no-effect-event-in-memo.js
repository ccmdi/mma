/**
 * Flags `useEffectEvent` called inside a component wrapped in `memo()` or
 * `forwardRef()`.
 *
 * React 19.2 freezes an effect event's closures at mount values in those
 * components, so the handler silently keeps reading the first render's props and
 * state forever -- no error, no warning, just stale data. `useStableHandler`
 * (lib/hooks) is the house replacement and has no such hole.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const WRAPPERS = new Set(["memo", "forwardRef"]);
const FUNCTIONS = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
]);

function wrappedBy(node) {
	let child = node;
	let parent = node.parent;
	while (parent?.type === "CallExpression" && parent.arguments[0] === child) {
		const callee = parent.callee;
		const name = callee.type === "MemberExpression" ? callee.property?.name : callee.name;
		if (WRAPPERS.has(name)) return name;
		child = parent;
		parent = parent.parent;
	}
	return null;
}

export default {
	meta: {
		type: "problem",
		messages: {
			frozen:
				"useEffectEvent freezes its closures at mount values inside {{wrapper}}() in React 19.2 -- the handler will silently read stale props. Use useStableHandler from @/lib/hooks/useStableHandler.",
		},
	},
	create(context) {
		const sourceCode = context.sourceCode ?? context.getSourceCode();

		function isReactEffectEvent(node) {
			if (node.type !== "Identifier" || node.name !== "useEffectEvent") return false;
			let scope = sourceCode.getScope(node);
			while (scope) {
				const variable = scope.variables.find((v) => v.name === "useEffectEvent");
				if (variable) {
					return variable.defs.some(
						(d) => d.type === "ImportBinding" && d.parent.source.value === "react",
					);
				}
				scope = scope.upper;
			}
			return false;
		}

		return {
			CallExpression(node) {
				if (!isReactEffectEvent(node.callee)) return;

				let fn = node.parent;
				while (fn && !FUNCTIONS.has(fn.type)) fn = fn.parent;
				if (!fn) return;

				const wrapper = wrappedBy(fn);
				if (wrapper) {
					context.report({ node, messageId: "frozen", data: { wrapper } });
				}
			},
		};
	},
};
