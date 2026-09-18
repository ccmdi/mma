/**
 * Flags markup that hand-writes what a primitive owns: a class the primitive emits, or an
 * element it wraps.
 *
 * A class string has no compiler behind it, so a typo renders unstyled and silent, and a
 * hand-built copy of a primitive drifts from it.
 *
 * A class tied to an element is checked only on that element and only in a plain string:
 * `<textarea className="text-input">` has no primitive to become. A class with no element is
 * checked on every element and in every string a className expression builds. Passing a modifier
 * to the primitive itself (`<NSelect className="nselect--compact">`) is what className is for,
 * and each primitive's own file is exempt from its entries.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const OWNED = {
	button: { primitive: "Button", element: "button" },
	checkbox: { primitive: "Checkbox", element: "input" },
	nselect: { primitive: "NSelect", element: "select" },
	radio: { primitive: "Radio", element: "input" },
	segmented: { primitive: "SegmentedControl", module: "Sidebar", element: "div" },
	slider: { primitive: "Slider", element: "input" },
	"text-input": { primitive: "TextInput", element: "input" },
	"icon-button": { primitive: "IconButton" },
	"context-menu": { primitive: "MenuPopup", module: "Menu" },
	"context-menu__item": { primitive: "MenuItem", module: "Menu" },
	"context-menu__separator": { primitive: "MenuSeparator", module: "Menu" },
	"menu-positioner": { primitive: "MenuPopup", module: "Menu" },
	"color-block": { primitive: "Swatch" },
	kbd: { primitive: "Kbd" },
	"search-input": { primitive: "SearchInput" },
};

function ownerOf(token) {
	return OWNED[token] ?? OWNED[token.split("--")[0]];
}

/** Every string a className expression can produce, from literals, templates, conditionals and
 *  helper calls such as clsx. */
function classStrings(node, out = []) {
	if (!node) return out;
	switch (node.type) {
		case "Literal":
			if (typeof node.value === "string") out.push(node.value);
			break;
		case "TemplateLiteral":
			for (const q of node.quasis) out.push(q.value.cooked ?? "");
			break;
		case "JSXExpressionContainer":
			classStrings(node.expression, out);
			break;
		case "ConditionalExpression":
			classStrings(node.consequent, out);
			classStrings(node.alternate, out);
			break;
		case "LogicalExpression":
			classStrings(node.right, out);
			break;
		case "CallExpression":
			for (const arg of node.arguments) classStrings(arg, out);
			break;
	}
	return out;
}

export default {
	meta: {
		type: "problem",
		messages: {
			primitiveClass:
				'"{{token}}" is {{primitive}}\'s class. Use <{{primitive}}> instead of hand-writing it -- a typo in a class string fails silently at runtime.',
			kbd: "Use <Kbd> for a key or shortcut instead of a bare <kbd>.",
			search: 'Use <SearchInput> instead of a type="search" field.',
		},
	},
	create(context) {
		const file = context.filename.replace(/\\/g, "/");
		const inPrimitive = (name) => file.endsWith(`/components/primitives/${name}.tsx`);

		return {
			JSXOpeningElement(node) {
				if (node.name.type !== "JSXIdentifier") return;
				if (node.name.name === "kbd" && !inPrimitive("Kbd")) {
					context.report({ node, messageId: "kbd" });
				}
				const type = node.attributes.find(
					(a) => a.type === "JSXAttribute" && a.name?.name === "type",
				);
				if (type?.value?.type === "Literal" && type.value.value === "search") {
					context.report({ node: type, messageId: "search" });
				}
			},
			JSXAttribute(node) {
				if (node.name?.name !== "className" || !node.value) return;
				const tag = node.parent?.name;
				if (tag?.type !== "JSXIdentifier" && tag?.type !== "JSXMemberExpression") return;
				const tagName = tag.type === "JSXIdentifier" ? tag.name : null;

				const literal = node.value.type === "Literal";
				for (const text of classStrings(node.value)) {
					for (const token of text.split(/\s+/)) {
						const owner = token && ownerOf(token);
						if (!owner || inPrimitive(owner.module ?? owner.primitive)) continue;
						if (owner.element ? !literal || owner.element !== tagName : tagName === owner.primitive)
							continue;
						context.report({
							node: node.value,
							messageId: "primitiveClass",
							data: { token, primitive: owner.primitive },
						});
						return;
					}
				}
			},
		};
	},
};
