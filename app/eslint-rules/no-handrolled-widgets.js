/**
 * Flags widgets built by hand where a primitive already owns the markup.
 *
 * - a `<label>` holding a `Checkbox` or `Radio` beside its text (pass the text as the
 *   primitive's children, which renders the one choice row);
 * - a raw `<input type="checkbox">` or `type="radio"` outside those two primitives;
 * - an inline `fontSize`, which sizes text outside the stylesheet (`inherit` is allowed);
 * - an inline fractional `opacity` on an element holding text, which mutes it by fading
 *   instead of with `--text-2`;
 * - the `nselect--compact`, `nselect--limited` and `segmented--fill` modifiers written as
 *   classes instead of the `compact`, `limited` and `fill` props.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const CHOICES = new Set(["Checkbox", "Radio"]);
const TEXT_TAGS = new Set([
	"span",
	"p",
	"small",
	"em",
	"strong",
	"b",
	"i",
	"label",
	"code",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
]);
const MODIFIER_PROPS = {
	"nselect--compact": "<NSelect compact>",
	"nselect--limited": "<NSelect limited>",
	"segmented--fill": "<SegmentedControl fill>",
};

function tagName(opening) {
	return opening.name.type === "JSXIdentifier" ? opening.name.name : null;
}

function hasContent(child) {
	switch (child.type) {
		case "JSXText":
			return child.value.trim() !== "";
		case "JSXExpressionContainer":
			return child.expression.type !== "JSXEmptyExpression";
		default:
			return true;
	}
}

function fractional(node) {
	switch (node?.type) {
		case "Literal":
			return typeof node.value === "number" && node.value > 0 && node.value < 1;
		case "ConditionalExpression":
			return fractional(node.consequent) || fractional(node.alternate);
		case "LogicalExpression":
			return fractional(node.left) || fractional(node.right);
		default:
			return false;
	}
}

export default {
	meta: {
		type: "problem",
		messages: {
			labelledChoice:
				"<label> wraps a <{{name}}> and its text. Pass the text as children of <{{name}}>, which renders its own label.",
			rawChoice: 'Use <{{name}}> instead of a raw <input type="{{type}}">.',
			inlineFontSize: "Inline fontSize sizes text outside the stylesheet. Use a class.",
			inlineOpacity:
				"Inline opacity mutes text by fading it. Use the text-muted class or Hint, or --disabled-opacity for a disabled control.",
			modifierClass: '"{{token}}" is a prop: use {{prop}}.',
		},
	},
	create(context) {
		const file = context.filename.replaceAll("\\", "/");
		const inChoicePrimitive = /\/components\/primitives\/(Checkbox|Radio)\.tsx$/.test(file);

		return {
			JSXElement(node) {
				if (tagName(node.openingElement) !== "label") return;
				const choice = node.children.find(
					(c) => c.type === "JSXElement" && CHOICES.has(tagName(c.openingElement)),
				);
				if (!choice) return;
				if (node.children.some((c) => c !== choice && hasContent(c))) {
					context.report({
						node: node.openingElement,
						messageId: "labelledChoice",
						data: { name: tagName(choice.openingElement) },
					});
				}
			},
			JSXOpeningElement(node) {
				if (inChoicePrimitive || tagName(node) !== "input") return;
				const type = node.attributes.find(
					(a) => a.type === "JSXAttribute" && a.name.name === "type" && a.value?.type === "Literal",
				)?.value.value;
				if (type === "checkbox" || type === "radio") {
					context.report({
						node,
						messageId: "rawChoice",
						data: { type, name: type === "checkbox" ? "Checkbox" : "Radio" },
					});
				}
			},
			JSXAttribute(node) {
				const name = node.name?.name;
				if (
					name === "className" &&
					node.value?.type === "Literal" &&
					typeof node.value.value === "string"
				) {
					for (const token of node.value.value.split(/\s+/)) {
						if (token in MODIFIER_PROPS) {
							context.report({
								node: node.value,
								messageId: "modifierClass",
								data: { token, prop: MODIFIER_PROPS[token] },
							});
						}
					}
					return;
				}
				if (name !== "style" || node.value?.type !== "JSXExpressionContainer") return;
				const expr = node.value.expression;
				if (expr.type !== "ObjectExpression") return;
				const element = node.parent.parent;
				const holdsText =
					TEXT_TAGS.has(tagName(node.parent)) &&
					element.children.some((c) => c.type !== "JSXElement" && hasContent(c));
				for (const prop of expr.properties) {
					if (prop.type !== "Property") continue;
					const key = prop.key.name ?? prop.key.value;
					if (
						key === "fontSize" &&
						!(prop.value.type === "Literal" && prop.value.value === "inherit")
					) {
						context.report({ node: prop, messageId: "inlineFontSize" });
					} else if (key === "opacity" && holdsText && fractional(prop.value)) {
						context.report({ node: prop, messageId: "inlineOpacity" });
					}
				}
			},
		};
	},
};
