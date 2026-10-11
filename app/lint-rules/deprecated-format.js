const FORMAT = /^@deprecated v(\d+)\.(\d+)\.(\d+)\. \S/;

const docText = (comment) =>
	comment.value
		.split("\n")
		.map((line) => line.replace(/^\s*\*?\s?/, "").trim())
		.filter(Boolean)
		.join(" ");

const older = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export default {
	meta: {
		type: "problem",
		schema: [],
		messages: {
			format:
				"Open the doc comment with `@deprecated vX.Y.Z. <replacement>`, naming the release that deprecated it.",
			single: "A doc comment carries one `@deprecated` tag.",
			order: "`@unstable` closes a deprecated doc comment.",
			chronology: "Deprecations run oldest to newest: v{{version}} comes after v{{previous}}.",
		},
	},
	create(context) {
		const sourceCode = context.sourceCode ?? context.getSourceCode();
		return {
			Program() {
				let previous = null;
				for (const comment of sourceCode.getAllComments()) {
					if (comment.type !== "Block" || !comment.value.startsWith("*")) continue;
					const text = docText(comment);
					if (!text.includes("@deprecated")) continue;
					const report = (messageId, data) => context.report({ loc: comment.loc, messageId, data });
					const match = FORMAT.exec(text);
					if (!match) {
						report("format");
						continue;
					}
					if (text.split("@deprecated").length > 2) report("single");
					else if (text.includes("@unstable") && !text.endsWith("@unstable")) report("order");
					const version = match.slice(1).map(Number);
					if (previous && older(version, previous) < 0)
						report("chronology", { version: version.join("."), previous: previous.join(".") });
					else previous = version;
				}
			},
		};
	},
};
