import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "../../eslint-rules/no-label-wrapped-group.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: {
		parser: tseslint.parser as never,
		parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
	},
});

const button = [{ messageId: "buttonInLabel" }];
const controls = [{ messageId: "controlsInLabel" }];

tester.run("no-label-wrapped-group", rule as never, {
	valid: [
		"const a = <label><Checkbox />Name</label>;",
		"const a = <label>Name<TextInput /></label>;",
		"const a = <label>{x ? <NSelect /> : <TextInput />}</label>;",
		"const a = <div>Sampling<SegmentedControl /></div>;",
		"const a = <div><label><Radio />Saved</label><NSelect /></div>;",
	],
	invalid: [
		{ code: "const a = <label>Sampling<SegmentedControl /></label>;", errors: button },
		{ code: "const a = <label>Go<button /></label>;", errors: button },
		{ code: "const a = <label>{on && <span><Button /></span>}</label>;", errors: button },
		{ code: "const a = <label><Radio />Saved<NSelect /></label>;", errors: controls },
		{ code: "const a = <label><input /><>{b && <select />}</></label>;", errors: controls },
	],
});
