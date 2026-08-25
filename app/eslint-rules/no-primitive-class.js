/**
 * Flags JSX `className` string literals that hand-write a class a primitive owns.
 *
 * The class strings are the primitives' private implementation detail, but they are
 * reachable from anywhere as plain text, so they drift silently: `.input` and
 * `.button--danger` both shipped against classes that were never defined in
 * styles.css, and the elements simply rendered unstyled. A string has no compiler
 * behind it; this rule is the compiler.
 *
 * Only the element each primitive actually renders is checked. Passing a modifier to
 * the primitive itself (`<NSelect className="nselect--compact">`) is what className is
 * for, `<textarea className="text-input">` has no primitive to become, and the
 * primitives' own files are exempt.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const OWNED = {
	button: ["Button", "button"],
	checkbox: ["Checkbox", "input"],
	nselect: ["NSelect", "select"],
	radio: ["Radio", "input"],
	segmented: ["SegmentedControl", "div"],
	slider: ["Slider", "input"],
	"text-input": ["TextInput", "input"],
};

function ownerOf(token) {
	return OWNED[token] ?? OWNED[token.split("--")[0]];
}

export default {
	meta: {
		type: "problem",
		messages: {
			primitiveClass:
				'"{{token}}" is {{primitive}}\'s class. Use <{{primitive}}> instead of hand-writing it -- a typo in a class string fails silently at runtime.',
		},
	},
	create(context) {
		if (context.filename.replace(/\\/g, "/").includes("/components/primitives/")) return {};

		return {
			JSXAttribute(node) {
				if (node.name?.name !== "className") return;
				if (node.value?.type !== "Literal" || typeof node.value.value !== "string") return;

				const tag = node.parent?.name;
				if (tag?.type !== "JSXIdentifier") return;

				for (const token of node.value.value.split(/\s+/)) {
					const owner = ownerOf(token);
					if (owner && owner[1] === tag.name) {
						context.report({
							node: node.value,
							messageId: "primitiveClass",
							data: { token, primitive: owner[0] },
						});
						return;
					}
				}
			},
		};
	},
};
