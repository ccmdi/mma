import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import rule from "../../lint-rules/no-redundant-mutate-guard.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	eslintCompat: true,
	languageOptions: { parserOptions: { lang: "ts" } },
});

const redundant = [{ messageId: "redundantGuard" }];

tester.run("no-redundant-mutate-guard", rule as never, {
	valid: [
		"async function f() { if (!Store.get().map) return; await Edit.work(s, op); refresh(); }",
		"async function f() { if (!Store.get().map) return; await Edit.meta({ name: 'x' }); }",
		"async function f() { if (Store.get().map) return; await Edit.work(s, op); }",
		"async function f() { if (!Store.get().map) return 0; return Edit.work(s, op); }",
		"async function f() { if (!Store.get().map && x) return; await Mutation.run(w); }",
		"async function f() { if (!other.map) return; await Mutation.run(w); }",
	],
	invalid: [
		{
			code: "async function f() { if (!Store.get().map) return; await Edit.work(s, op); }",
			errors: redundant,
		},
		{
			code: "async function f() { if (!Store.get().map || a === b) return; await Edit.locations(t, e, null); }",
			errors: redundant,
		},
		{
			code: "const f = async () => { if (!Store.get().map) { return; } return Mutation.run(w); };",
			errors: redundant,
		},
		{
			code: "function f() { if (!Store.get().map) return; void Edit.values(field, edits); }",
			errors: redundant,
		},
	],
});
