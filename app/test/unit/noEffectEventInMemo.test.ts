import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "../../eslint-rules/no-effect-event-in-memo.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: {
		parser: tseslint.parser as never,
		parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
	},
});

const imports = 'import { memo, forwardRef, useEffectEvent } from "react";\n';
const frozen = [{ messageId: "frozen" }];

tester.run("no-effect-event-in-memo", rule as never, {
	valid: [
		imports + "function C({ x }) { const f = useEffectEvent(() => x); return f; }",
		'function useEffectEvent(f) { return f; }\nconst C = memo(function C({ x }) { return useEffectEvent(() => x); });',
		'import { memo } from "react";\nimport { useEffectEvent } from "./shim";\nconst C = memo(function C({ x }) { return useEffectEvent(() => x); });',
		imports + "const C = memo(function C({ x }) { return x; });",
		imports + "const A = memo(function A() { return null; });\nfunction B({ x }) { return useEffectEvent(() => x); }",
	],
	invalid: [
		{
			code: imports + "const C = memo(function C({ x }) { return useEffectEvent(() => x); });",
			errors: frozen,
		},
		{
			code: imports + "const C = memo(({ x }) => useEffectEvent(() => x));",
			errors: frozen,
		},
		{
			code: imports + "const C = forwardRef(function C({ x }, ref) { return useEffectEvent(() => x); });",
			errors: frozen,
		},
		{
			code: imports + "const C = memo(forwardRef(function C({ x }, ref) { return useEffectEvent(() => x); }));",
			errors: frozen,
		},
		{
			code: 'import * as React from "react";\nimport { useEffectEvent } from "react";\nconst C = React.memo(function C({ x }) { return useEffectEvent(() => x); });',
			errors: frozen,
		},
	],
});
