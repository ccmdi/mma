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
import noHandwrittenApiSurface from "./eslint-rules/no-handwritten-api-surface.js";
import noLabelWrappedGroup from "./eslint-rules/no-label-wrapped-group.js";
import noHandrolledDialogParts from "./eslint-rules/no-handrolled-dialog-parts.js";
import noHandrolledWidgets from "./eslint-rules/no-handrolled-widgets.js";

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

const QUERY_COMMANDS =
	"/^store(Resolve|Count|CountBy|Bounds|Sample|Spaced|EvenlySpaced|Values|Coverage|Columns|GroupBy|Collect)$/";

/** The store's query surface is named vocabulary, not raw IPC: `fieldCoverage`, not
 *  `cmd.storeCoverage`. Only useMapStore may reach past the wrappers. */
const QUERY_CMD_BAN = {
	selector: `MemberExpression[property.name=${QUERY_COMMANDS}]:matches([object.name='cmd'], [object.property.name='cmd'])`,
	message:
		"Query commands go through their named wrapper in store/useMapStore (resolveIds, countIn, fetchBounds, sampleFrom, fieldValues, countBy, fieldCoverage, fetchColumns, partition, fetchLocations), not raw cmd.",
};

const E2E_BRIDGE_RULES = [
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
];

/** The host machine decides how long anything takes, so an e2e spec waits on a condition,
 *  never on a duration. */
const E2E_TIMING_RULES = [
	{
		selector: "CallExpression[callee.object.name='browser'][callee.property.name='pause']",
		message:
			"No fixed sleeps in e2e. Wait on the real post-condition with a waitFor* helper or browser.waitUntil. To prove something did not happen, first wait on a signal that it would have by now: the work finished, or a later event landed.",
	},
	{
		selector: "CallExpression[callee.name='setTimeout'][arguments.length=2]:not([arguments.1.value=0])",
		message:
			"No timed sleeps or cutoffs in e2e. Await the operation, or poll its post-condition from the spec with browser.waitUntil.",
	},
	{
		selector: "CallExpression[callee.property.name=/^wait(Until|For)/] Property[key.name='timeout']",
		message:
			"No per-wait timeouts in e2e. waitforTimeout in wdio.conf.ts is the one hang bound; a wait ends on its condition.",
	},
];

const E2E_TIMED_TOOLS = [
	"test/e2e/scratch.test.ts",
	"test/e2e/performance.test.ts",
	"test/e2e/procedure-parity.test.ts",
	"test/e2e/procedure-faults.test.ts",
	"test/e2e/procedure-scale.test.ts",
	"test/e2e/sv-stub-ceiling.test.ts",
	"test/e2e/benchFixture.test.ts",
	"test/e2e/providerBench.test.ts",
	"test/e2e/parityDriver.ts",
	"test/e2e/svMockCore.ts",
];

const RESTRICTED_SYNTAX = [
	{
		selector: "JSXOpeningElement[name.name='select']",
		message: "Use <NSelect> (@/components/primitives/NSelect) instead of a raw <select>.",
	},
	{
		selector: "TSEnumDeclaration",
		message: "No enum - use `as const` plus EnumOf<typeof X> (@/types/util).",
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
	globalIgnores([
		"dist",
		"src/bindings.gen.ts",
		"src/components/manual/manual-img-dims.gen.ts",
		"procedures/prelude.d.ts",
	]),
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
					"no-handwritten-api-surface": noHandwrittenApiSurface,
					"no-label-wrapped-group": noLabelWrappedGroup,
					"no-handrolled-dialog-parts": noHandrolledDialogParts,
					"no-handrolled-widgets": noHandrolledWidgets,
				},
			},
		},
		languageOptions: {
			globals: globals.browser,
			// `local/no-unsupported-builtins` needs types to tell `someSet.union()` from a
			// method of our own with the same name. projectService costs ~4s over the suite.
			parser: tseslint.parser,
			parserOptions: {
				projectService: { allowDefaultProject: ["wdio.conf.ts", "wdio.web.conf.ts"] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"react-hooks/refs": "off",
			"react-hooks/set-state-in-effect": "off",
			"react-hooks/immutability": "off",
			"react-hooks/preserve-manual-memoization": "off",
			"no-console": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"local/no-unsupported-builtins": "error",
			"local/no-ipc-in-loop": "warn",
			"local/no-redundant-mutate-guard": "warn",
			"local/no-selection-alias": "warn",
			"local/no-primitive-class": "error",
			"local/no-effect-event-in-memo": "error",
			"local/no-native-dialog": "error",
			"local/no-undefined-css-class": "error",
			"local/no-label-wrapped-group": "error",
			"local/no-handrolled-dialog-parts": "error",
			"local/no-handrolled-widgets": "error",
			"no-restricted-imports": [
				"error",
				{
					paths: RESTRICTED_IMPORT_PATHS,
				},
			],
			"no-restricted-syntax": [
				"error",
				...RESTRICTED_SYNTAX,
				USE_SYNC_EXTERNAL_STORE_BAN,
				QUERY_CMD_BAN,
			],
			// A shim exists for plugins built against an older release; app code has no excuse.
			"@typescript-eslint/no-deprecated": "warn",
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
		files: ["src/lib/events.ts", "src/store/selectorPick.ts", "src/lib/hooks/useLocalStorage.ts"],
		rules: {
			"no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX],
		},
	},
	{
		// The store owns the query wrappers, so it is the one file that calls them raw.
		files: ["src/store/useMapStore.ts"],
		rules: {
			"no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX, USE_SYNC_EXTERNAL_STORE_BAN],
		},
	},
	{
		files: ["src/api.ts", "src/lib/tauri.ts", "src/App.tsx"],
		rules: { "no-restricted-imports": "off" },
	},
	{
		files: ["src/api.ts"],
		rules: { "local/no-handwritten-api-surface": "error" },
	},
	{
		files: ["src/store/commandDefs.ts"],
		rules: { "local/no-duplicate-command-icons": "error" },
	},
	{
		// The sanctioned raw select: this primitive wraps it.
		files: ["src/components/primitives/NSelect.tsx"],
		rules: { "no-restricted-syntax": "off" },
	},
	{
		// Node-side runner config: console reporting + ANSI stripping are legitimate.
		files: ["wdio.conf.ts"],
		rules: { "no-console": "off", "no-control-regex": "off" },
	},
	{
		files: ["test/**/*.{ts,tsx}"],
		rules: {
			"local/no-undefined-css-class": "off",
			"local/no-primitive-class": "off",
		},
	},
	{
		// Reporting suites: their stdout is the deliverable, read back from the run log.
		files: [
			"test/e2e/bulk-import-rust.test.ts",
			"test/e2e/procedure-parity.test.ts",
			"test/e2e/procedure-faults.test.ts",
			"test/e2e/procedure-scale.test.ts",
			"test/e2e/sv-stub-ceiling.test.ts",
		],
		rules: { "no-console": "off" },
	},
	{
		files: ["test/e2e/**/*.ts"],
		ignores: E2E_TIMED_TOOLS,
		rules: { "no-restricted-syntax": ["error", ...E2E_BRIDGE_RULES, ...E2E_TIMING_RULES] },
	},
	{
		// Benchmarks, engine A/B tools and the mock's latency model measure or model time on purpose.
		files: E2E_TIMED_TOOLS,
		rules: { "no-restricted-syntax": ["error", ...E2E_BRIDGE_RULES] },
	},
]);
