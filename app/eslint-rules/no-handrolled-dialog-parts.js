/**
 * Flags dialog interiors built by hand instead of from the Dialog primitives.
 *
 * A footer or form written out per dialog drifts: gaps, margins, button order and which
 * side the destructive action sits on all ended up different across dialogs. The
 * primitives fix those in one place, so the hand-written shapes are reported:
 *
 * - a `<form>` in a file that uses the Dialog module (use `DialogForm`);
 * - an inline style that right-aligns a row (`justifyContent: "flex-end"`), which is a
 *   footer by another name (use `DialogActions`);
 * - an `__actions` or `__footer` class on an element placed directly in `<DialogContent>`,
 *   `<DialogForm>`, `<ConfirmDialog>` or `<PromptDialog>` (use `DialogActions`).
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const DIALOG_MODULE = /(^|\/)Dialog$/;
const DIALOG_BODIES = new Set(["DialogContent", "DialogForm", "ConfirmDialog", "PromptDialog"]);
const FOOTER_CLASS = /__(actions|footer)$/;

/** Whether the element carrying `attribute` sits directly in a dialog body, looking through
 *  fragments and conditionals but not through other elements. */
function inDialogBody(attribute) {
	const element = attribute.parent.parent;
	for (let p = element.parent; p; p = p.parent) {
		if (p.type === "JSXElement") return DIALOG_BODIES.has(p.openingElement.name?.name);
	}
	return false;
}

export default {
	meta: {
		type: "problem",
		messages: {
			form: "Use <DialogForm> for a form in a dialog: it owns submit handling and the body layout.",
			rightAligned:
				'A right-aligned row of controls is a dialog footer. Use <DialogActions> instead of justifyContent: "flex-end".',
			footerClass:
				'"{{token}}" hand-builds a dialog footer. Use <DialogActions>, which fixes the button order and spacing.',
		},
	},
	create(context) {
		const file = context.filename.replace(/\\/g, "/");
		if (file.endsWith("/components/primitives/Dialog.tsx")) return {};
		let usesDialog = false;

		return {
			ImportDeclaration(node) {
				if (DIALOG_MODULE.test(String(node.source.value))) usesDialog = true;
			},
			JSXOpeningElement(node) {
				if (usesDialog && node.name.type === "JSXIdentifier" && node.name.name === "form") {
					context.report({ node, messageId: "form" });
				}
			},
			JSXAttribute(node) {
				const name = node.name?.name;
				if (name === "style" && node.value?.type === "JSXExpressionContainer") {
					const expr = node.value.expression;
					if (expr.type !== "ObjectExpression") return;
					for (const prop of expr.properties) {
						if (
							prop.type === "Property" &&
							(prop.key.name ?? prop.key.value) === "justifyContent" &&
							prop.value.type === "Literal" &&
							prop.value.value === "flex-end"
						) {
							context.report({ node: prop, messageId: "rightAligned" });
						}
					}
					return;
				}
				if (name !== "className" || node.value?.type !== "Literal") return;
				if (typeof node.value.value !== "string") return;
				const token = node.value.value.split(/\s+/).find((c) => FOOTER_CLASS.test(c));
				if (token && inDialogBody(node)) {
					context.report({ node: node.value, messageId: "footerClass", data: { token } });
				}
			},
		};
	},
};
