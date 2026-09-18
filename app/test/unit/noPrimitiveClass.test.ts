import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "../../eslint-rules/no-primitive-class.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: {
		parser: tseslint.parser as never,
		parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
	},
});

const cls = (token: string, primitive: string) => [
	{ messageId: "primitiveClass", data: { token, primitive } },
];
const inFile = (code: string, name: string) => ({
	code,
	filename: `/app/src/components/primitives/${name}.tsx`,
});

tester.run("no-primitive-class", rule as never, {
	valid: [
		"const a = <textarea className='text-input' />;",
		"const a = <div className={clsx('button', x)} />;",
		"const a = <NSelect className='nselect--compact' />;",
		"const a = <IconButton className='icon-button--inline' icon={p} label='x' />;",
		"const a = <span className='tag-tree__chevron-spacer' />;",
		"const a = <input type='text' />;",
		inFile("const a = <button className={clsx('icon-button', c)} />;", "IconButton"),
		inFile("const a = <Menu.Item className='context-menu__item' />;", "Menu"),
		inFile("const a = <kbd className='kbd' />;", "Kbd"),
		inFile("const a = <span className='color-block' />;", "Swatch"),
		inFile("const a = <span className='search-input' />;", "SearchInput"),
	],
	invalid: [
		{ code: "const a = <button className='button' />;", errors: cls("button", "Button") },
		{ code: "const a = <input className='text-input' />;", errors: cls("text-input", "TextInput") },
		{
			code: "const a = <button className='icon-button job__cancel' />;",
			errors: cls("icon-button", "IconButton"),
		},
		{
			code: "const a = <DialogTrigger className='icon-button' />;",
			errors: cls("icon-button", "IconButton"),
		},
		{
			code: "const a = <button className={clsx('icon-button', { 'is-active': on })} />;",
			errors: cls("icon-button", "IconButton"),
		},
		{
			code: "const a = <ContextMenu.Item className='context-menu__item' />;",
			errors: cls("context-menu__item", "MenuItem"),
		},
		{
			code: "const a = <div className={`context-menu popover-surface${x}`} />;",
			errors: cls("context-menu", "MenuPopup"),
		},
		{
			code: "const a = <div className='context-menu__separator' />;",
			errors: cls("context-menu__separator", "MenuSeparator"),
		},
		{
			code: "const a = <span className={on ? 'color-block color-block--sm' : ''} />;",
			errors: cls("color-block", "Swatch"),
		},
		{
			code: "const a = <button className='icon-button' />;",
			filename: "/app/src/components/primitives/Dialog.tsx",
			errors: cls("icon-button", "IconButton"),
		},
		{ code: "const a = <kbd>Q</kbd>;", errors: [{ messageId: "kbd" }] },
		{ code: "const a = <input type='search' />;", errors: [{ messageId: "search" }] },
		{ code: "const a = <TextInput type='search' />;", errors: [{ messageId: "search" }] },
	],
});
