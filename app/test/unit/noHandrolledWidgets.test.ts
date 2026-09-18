import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "../../eslint-rules/no-handrolled-widgets.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: {
		parser: tseslint.parser as never,
		parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
	},
});

const err = (messageId: string) => [{ messageId }];

tester.run("no-handrolled-widgets", rule as never, {
	valid: [
		"const a = <Checkbox checked>Name</Checkbox>;",
		"const a = <label className='cell'><Checkbox checked /></label>;",
		"const a = <label>Name<TextInput /></label>;",
		'const a = <input type="text" />;',
		{
			code: 'const a = <input type="checkbox" />;',
			filename: "/app/src/components/primitives/Checkbox.tsx",
		},
		'const a = <TextInput style={{ fontSize: "inherit" }} />;',
		"const a = <li style={{ opacity: 0.4 }}>{name}</li>;",
		"const a = <span style={{ opacity: 0.6 }}><svg /></span>;",
		"const a = <span style={{ opacity: 1 }}>{name}</span>;",
		'const a = <NSelect compact className="map-list__sort" />;',
	],
	invalid: [
		{ code: "const a = <label><Checkbox />Name</label>;", errors: err("labelledChoice") },
		{ code: "const a = <label><Radio />{t('All')}</label>;", errors: err("labelledChoice") },
		{ code: "const a = <label><Radio /><span>All</span></label>;", errors: err("labelledChoice") },
		{ code: 'const a = <input type="checkbox" />;', errors: err("rawChoice") },
		{ code: 'const a = <input type="radio" />;', errors: err("rawChoice") },
		{ code: 'const a = <p style={{ fontSize: "0.85rem" }}>x</p>;', errors: err("inlineFontSize") },
		{ code: "const a = <div style={{ fontSize: 12 }} />;", errors: err("inlineFontSize") },
		{
			code: "const a = <span style={{ opacity: 0.6 }}>{total}</span>;",
			errors: err("inlineOpacity"),
		},
		{
			code: "const a = <span style={{ opacity: off ? 0.5 : 1 }}>Off</span>;",
			errors: err("inlineOpacity"),
		},
		{ code: 'const a = <NSelect className="nselect--compact" />;', errors: err("modifierClass") },
		{ code: 'const a = <NSelect className="nselect--limited" />;', errors: err("modifierClass") },
		{
			code: 'const a = <SegmentedControl className="segmented--fill tabs" />;',
			errors: err("modifierClass"),
		},
	],
});
