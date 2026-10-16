import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import rule from "../../lint-rules/deprecated-format.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	eslintCompat: true,
	languageOptions: { parserOptions: { lang: "ts" } },
});

const at = (doc: string) => `${doc}\nexport const a = 1;`;

tester.run("deprecated-format", rule as never, {
	valid: [
		at("/** @deprecated v0.12.0. Use `MMA.Store.get`. */"),
		at("/** @deprecated v0.8.2. Read `MMA.Store.get().map`. @unstable */"),
		at(
			"/** @deprecated v0.11.3. A provider's `fieldDefs` are offered\n *  as enrichment options. @unstable */",
		),
		at("/** Plain doc that mentions nothing. */"),
		at("// @deprecated in a line comment is not a doc"),
		[
			"/** @deprecated v0.9.4. Use `a`. */\nexport const a = 1;",
			"/** @deprecated v0.10.0. Use `b`. */\nexport const b = 1;",
			"/** @deprecated v0.10.0. Use `c`. */\nexport const c = 1;",
		].join("\n"),
	],
	invalid: [
		{ code: at("/** @deprecated Use `MMA.Store.get`. */"), errors: [{ messageId: "format" }] },
		{
			code: at("/** @deprecated 0.12.0. Use `MMA.Store.get`. */"),
			errors: [{ messageId: "format" }],
		},
		{
			code: at("/** @deprecated v0.12. Use `MMA.Store.get`. */"),
			errors: [{ messageId: "format" }],
		},
		{
			code: at("/** @deprecated v0.12.0 Use `MMA.Store.get`. */"),
			errors: [{ messageId: "format" }],
		},
		{ code: at("/** @deprecated v0.12.0. */"), errors: [{ messageId: "format" }] },
		{
			code: at("/** Reads the map. @deprecated v0.12.0. Use `MMA.Store.get`. */"),
			errors: [{ messageId: "format" }],
		},
		{
			code: at("/** @deprecated v0.12.0. Use `a`. @deprecated v0.12.0. Use `b`. */"),
			errors: [{ messageId: "single" }],
		},
		{
			code: at("/** @deprecated v0.12.0. @unstable Use `MMA.Store.get`. */"),
			errors: [{ messageId: "order" }],
		},
		{
			code: [
				"/** @deprecated v0.12.0. Use `a`. */\nexport const a = 1;",
				"/** @deprecated v0.11.3. Use `b`. */\nexport const b = 1;",
				"/** @deprecated v0.11.4. Use `c`. */\nexport const c = 1;",
			].join("\n"),
			errors: [{ messageId: "chronology" }, { messageId: "chronology" }],
		},
	],
});
