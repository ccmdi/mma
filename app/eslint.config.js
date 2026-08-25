import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import noDuplicateCommandIcons from "./eslint-rules/no-duplicate-command-icons.js";
import noIpcInLoop from "./eslint-rules/no-ipc-in-loop.js";
import noRedundantMutateGuard from "./eslint-rules/no-redundant-mutate-guard.js";
import noSelectionAlias from "./eslint-rules/no-selection-alias.js";
import noUnsupportedBuiltins from "./eslint-rules/no-unsupported-builtins.js";
import noPrimitiveClass from "./eslint-rules/no-primitive-class.js";
import noEffectEventInMemo from "./eslint-rules/no-effect-event-in-memo.js";
import noNativeDialog from "./eslint-rules/no-native-dialog.js";
import noUndefinedCssClass from "./eslint-rules/no-undefined-css-class.js";

const RESTRICTED_IMPORT_PATHS = [
	{
		name: "@tauri-apps/api/core",
		importNames: ["invoke"],
		message: "Use the typed cmd proxy (lib/commands.ts) instead of raw invoke().",
	},
];

const USE_SYNC_EXTERNAL_STORE_BAN = {
	selector:
		"ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name='useSyncExternalStore']",
	message:
		"Use useEvent/useEventValue from @/lib/events instead of raw useSyncExternalStore. The event system handles subscribe + versioning centrally.",
};

const RESTRICTED_SYNTAX = [
	{
		selector: "JSXOpeningElement[name.name='select']",
		message: "Use <NSelect> (@/components/primitives/NSelect) instead of a raw <select>.",
	},
	{
		selector:
			"JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value='radio']",
		message: 'Use <Radio> (@/components/primitives/Radio) instead of a raw <input type="radio">.',
	},
	{
		selector:
			"JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value='checkbox']",
		message:
			'Use <Checkbox> (@/components/primitives/Checkbox) instead of a raw <input type="checkbox">.',
	},
	{
		selector: "AssignmentExpression[left.property.name='innerHTML']",
		message: "No raw innerHTML - use React or textContent.",
	},
	{
		selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
		message: "No insertAdjacentHTML - use React or DOM APIs.",
	},
];

export default defineConfig([
	globalIgnores(["dist", "src/bindings.gen.ts", "src/components/manual/manual-img-dims.gen.ts"]),
	{
		files: ["**/*.{ts,tsx}"],
		extends: [
			js.configs.recommended,
			tseslint.configs.recommended,
			reactHooks.configs.flat.recommended,
			reactRefresh.configs.vite,
		],
		plugins: {
			local: {
				rules: {
					"no-ipc-in-loop": noIpcInLoop,
					"no-duplicate-command-icons": noDuplicateCommandIcons,
					"no-redundant-mutate-guard": noRedundantMutateGuard,
					"no-selection-alias": noSelectionAlias,
					"no-unsupported-builtins": noUnsupportedBuiltins,
					"no-primitive-class": noPrimitiveClass,
					"no-effect-event-in-memo": noEffectEventInMemo,
					"no-native-dialog": noNativeDialog,
					"no-undefined-css-class": noUndefinedCssClass,
				},
			},
		},
		languageOptions: {
			globals: globals.browser,
			// `local/no-unsupported-builtins` needs types to tell `someSet.union()` from a
			// method of our own with the same name. projectService costs ~4s over the suite.
			parser: tseslint.parser,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			"react-hooks/refs": "off",
			"react-hooks/set-state-in-effect": "off",
			"react-hooks/immutability": "off",
			"react-hooks/preserve-manual-memoization": "off",
			"no-console": "error",
			"local/no-unsupported-builtins": "error",
			"local/no-ipc-in-loop": "warn",
			"local/no-redundant-mutate-guard": "warn",
			"local/no-selection-alias": "warn",
			"local/no-primitive-class": "error",
			"local/no-effect-event-in-memo": "error",
			"local/no-native-dialog": "error",
			"local/no-undefined-css-class": "error",
			"no-restricted-imports": [
				"error",
				{
					paths: RESTRICTED_IMPORT_PATHS,
				},
			],
			"no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX, USE_SYNC_EXTERNAL_STORE_BAN],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
		},
	},
	{
		// Store adds a ban on dialogs (dialogs belong in components, not the store).
		files: ["src/store/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						...RESTRICTED_IMPORT_PATHS,
						{
							name: "@tauri-apps/plugin-dialog",
							message:
								"File dialogs belong in components, not the store. Call the dialog in the component, pass the result to a store function.",
						},
					],
				},
			],
		},
	},
	{
		// Legitimate low-level users of useSyncExternalStore: exempt from that one ban.
		files: [
			"src/lib/events.ts",
			"src/store/scope.ts",
			"src/lib/hooks/useLocalStorage.ts",
			"src/plugins/generator/ui/progressSignal.ts",
		],
		rules: {
			"no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX],
		},
	},
	{
		files: ["src/api.ts", "src/App.tsx"],
		rules: { "no-restricted-imports": "off" },
	},
	{
		files: ["src/store/commandDefs.ts"],
		rules: { "local/no-duplicate-command-icons": "error" },
	},
	{
		// The sanctioned raw form builtins: these primitives wrap them.
		files: [
			"src/components/primitives/NSelect.tsx",
			"src/components/primitives/Radio.tsx",
			"src/components/primitives/Checkbox.tsx",
		],
		rules: { "no-restricted-syntax": "off" },
	},
	{
		// Node-side runner config: console reporting + ANSI stripping are legitimate.
		files: ["wdio.conf.ts"],
		rules: { "no-console": "off", "no-control-regex": "off" },
	},
	{
		files: ["test/e2e/bulk-import-rust.test.ts"],
		rules: { "no-console": "off" },
	},
	{
		files: ["test/e2e/**/*.ts"],
		ignores: ["test/e2e/helpers.ts"],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					selector: "Literal[value='__TAURI_INTERNALS__']",
					message: "Use withApi() from helpers instead of raw __TAURI_INTERNALS__",
				},
				{
					selector: "MemberExpression[property.name='__TAURI_INTERNALS__']",
					message: "Use withApi() from helpers instead of raw __TAURI_INTERNALS__",
				},
				{
					selector: "Literal[value='__TEST_API__']",
					message: "Use withApi() from helpers instead of raw __TEST_API__",
				},
				{
					selector: "MemberExpression[property.name='__TEST_API__']",
					message: "Use withApi() from helpers instead of raw __TEST_API__",
				},
				{
					selector: "CallExpression[callee.object.name='browser'][callee.property.name='pause']",
					message:
						"No fixed sleeps in e2e — use a waitFor* helper (waitForActive/waitForWorkArea/waitForLocCount/waitForSave/waitForFlag/waitForOptions, or browser.waitUntil) that polls the real post-condition. For a genuine 'wait for X to NOT happen' settle, add an inline eslint-disable with a reason.",
				},
			],
		},
	},
]);
