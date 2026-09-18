/**
 * Flags a JSX `<label>` wrapping a group of controls.
 *
 * A label forwards hover, active and click to its first labelable descendant, so wrapping
 * a SegmentedControl or several controls makes the first option light up whenever any
 * other one is hovered. Caption a group with `Field` or a plain element instead.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const BUTTONS = new Set(["button", "Button", "SegmentedControl"]);
const CONTROLS = new Set([
	"input",
	"select",
	"textarea",
	"Checkbox",
	"Radio",
	"Slider",
	"TextInput",
	"NSelect",
	"Switch",
]);

function tagName(node) {
	const name = node.openingElement.name;
	return name.type === "JSXIdentifier" ? name.name : null;
}

function scan(node, found) {
	switch (node?.type) {
		case "JSXExpressionContainer":
			return scan(node.expression, found);
		case "LogicalExpression":
			return scan(node.left, found) + scan(node.right, found);
		case "ConditionalExpression":
			return Math.max(scan(node.consequent, found), scan(node.alternate, found));
		case "JSXFragment":
			return node.children.reduce((n, c) => n + scan(c, found), 0);
		case "JSXElement": {
			const name = tagName(node);
			if (BUTTONS.has(name)) found.button ??= name;
			const own = CONTROLS.has(name) ? 1 : 0;
			return own + node.children.reduce((n, c) => n + scan(c, found), 0);
		}
		default:
			return 0;
	}
}

export default {
	meta: {
		type: "problem",
		messages: {
			buttonInLabel:
				"<label> wraps <{{name}}>: a label forwards hover and clicks to its first control. Caption the group with Field or a plain element.",
			controlsInLabel:
				"<label> wraps {{count}} controls: a label forwards hover and clicks to the first one. Caption the group with Field or a plain element.",
		},
	},
	create(context) {
		return {
			JSXElement(node) {
				if (tagName(node) !== "label") return;
				const found = {};
				const controls = node.children.reduce((n, c) => n + scan(c, found), 0);
				if (found.button) {
					context.report({
						node: node.openingElement,
						messageId: "buttonInLabel",
						data: { name: found.button },
					});
				} else if (controls > 1) {
					context.report({
						node: node.openingElement,
						messageId: "controlsInLabel",
						data: { count: String(controls) },
					});
				}
			},
		};
	},
};
