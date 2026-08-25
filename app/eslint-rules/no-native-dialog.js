/**
 * Flags `confirm()` / `alert()` / `prompt()`, however they are reached.
 *
 * These hang WebView2 for 15-20 seconds. A `no-restricted-syntax` selector used to
 * cover this, but it matched on `callee.name`, which only exists on a bare
 * `Identifier` callee -- `window.prompt(...)` is a MemberExpression and sailed
 * straight through it for months while the polygon rename hung the app.
 *
 * Resolving through scope instead of matching shapes also means a local binding
 * (`const prompt = usePrompt()`) is correctly ignored.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const BANNED = new Set(["confirm", "alert", "prompt"]);
const GLOBALS = new Set(["window", "globalThis", "self", "top", "parent"]);

export default {
	meta: {
		type: "problem",
		messages: {
			nativeDialog:
				"Native {{name}}() hangs WebView2 for 15-20s - use a Radix dialog (@/components/primitives/Dialog) instead.",
		},
	},
	create(context) {
		const sourceCode = context.sourceCode ?? context.getSourceCode();

		function isGlobal(node) {
			if (node.type !== "Identifier") return false;
			let scope = sourceCode.getScope(node);
			while (scope) {
				const variable = scope.variables.find((v) => v.name === node.name);
				if (variable) return variable.defs.length === 0;
				scope = scope.upper;
			}
			return true;
		}

		return {
			CallExpression(node) {
				const callee = node.callee;

				// prompt(...)
				if (callee.type === "Identifier" && BANNED.has(callee.name) && isGlobal(callee)) {
					context.report({ node, messageId: "nativeDialog", data: { name: callee.name } });
					return;
				}

				// window.prompt(...) / globalThis.prompt(...)
				if (
					callee.type === "MemberExpression" &&
					!callee.computed &&
					callee.property.type === "Identifier" &&
					BANNED.has(callee.property.name) &&
					callee.object.type === "Identifier" &&
					GLOBALS.has(callee.object.name) &&
					isGlobal(callee.object)
				) {
					context.report({
						node,
						messageId: "nativeDialog",
						data: { name: callee.property.name },
					});
				}
			},
		};
	},
};
