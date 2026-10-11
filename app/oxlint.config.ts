import { defineConfig } from "oxlint";

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

/** Location queries go through the typed query object. */
const QUERY_CMD_BAN = {
	selector: `MemberExpression[property.name=${QUERY_COMMANDS}]:matches([object.name='cmd'], [object.property.name='cmd'])`,
	message: "Use Query.read(selector, ask) from store/query rather than raw query commands.",
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
		selector:
			"CallExpression[callee.name='setTimeout'][arguments.length=2]:not([arguments.1.value=0])",
		message:
			"No timed sleeps or cutoffs in e2e. Await the operation, or poll its post-condition from the spec with browser.waitUntil.",
	},
	{
		selector:
			"CallExpression[callee.property.name=/^wait(Until|For)/] Property[key.name='timeout']",
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

/** ESLint's, typescript-eslint's and react-hooks' recommended sets, named so an oxlint upgrade cannot add rules. */
const RECOMMENDED = [
	"for-direction",
	"no-async-promise-executor",
	"no-case-declarations",
	"no-compare-neg-zero",
	"no-cond-assign",
	"no-constant-binary-expression",
	"no-constant-condition",
	"no-control-regex",
	"no-debugger",
	"no-delete-var",
	"no-dupe-else-if",
	"no-duplicate-case",
	"no-empty",
	"no-empty-character-class",
	"no-empty-pattern",
	"no-empty-static-block",
	"no-ex-assign",
	"no-extra-boolean-cast",
	"no-fallthrough",
	"no-global-assign",
	"no-invalid-regexp",
	"no-irregular-whitespace",
	"no-loss-of-precision",
	"no-misleading-character-class",
	"no-nonoctal-decimal-escape",
	"no-prototype-builtins",
	"no-regex-spaces",
	"no-self-assign",
	"no-shadow-restricted-names",
	"no-sparse-arrays",
	"no-unassigned-vars",
	"no-unexpected-multiline",
	"no-unsafe-finally",
	"no-unsafe-optional-chaining",
	"no-unused-labels",
	"no-unused-private-class-members",
	"no-useless-assignment",
	"no-useless-backreference",
	"no-useless-catch",
	"no-useless-escape",
	"preserve-caught-error",
	"require-yield",
	"use-isnan",
	"valid-typeof",
	"no-array-constructor",
	"no-unused-expressions",
	"no-var",
	"prefer-const",
	"prefer-rest-params",
	"prefer-spread",
	"typescript/ban-ts-comment",
	"typescript/no-duplicate-enum-values",
	"typescript/no-empty-object-type",
	"typescript/no-explicit-any",
	"typescript/no-extra-non-null-assertion",
	"typescript/no-misused-new",
	"typescript/no-namespace",
	"typescript/no-non-null-asserted-optional-chain",
	"typescript/no-require-imports",
	"typescript/no-this-alias",
	"typescript/no-unnecessary-type-constraint",
	"typescript/no-unsafe-declaration-merging",
	"typescript/no-unsafe-function-type",
	"typescript/no-wrapper-object-types",
	"typescript/prefer-as-const",
	"typescript/prefer-namespace-keyword",
	"typescript/triple-slash-reference",
	"react/rules-of-hooks",
	"react/static-components",
	"react/use-memo",
	"react/globals",
	"react/error-boundaries",
	"react/purity",
	"react/set-state-in-render",
];

export default defineConfig({
	plugins: ["typescript", "react"],
	jsPlugins: ["./lint-rules/index.js"],
	categories: { correctness: "off" },
	env: { browser: true },
	options: { typeAware: true },
	ignorePatterns: [
		"**/*.{js,mjs,cjs}",
		"dist",
		"src/bindings.gen.ts",
		"src/components/manual/manual-img-dims.gen.ts",
		"procedures/prelude.d.ts",
	],
	rules: {
		...Object.fromEntries(RECOMMENDED.map((rule) => [rule, "error"])),
		"no-console": "error",
		"no-unused-vars": [
			"error",
			{
				argsIgnorePattern: "^_",
				varsIgnorePattern: "^_",
				destructuredArrayIgnorePattern: "^_",
				caughtErrorsIgnorePattern: "^_",
			},
		],
		"typescript/no-floating-promises": "error",
		"typescript/no-misused-promises": "error",
		// A shim exists for plugins built against an older release; app code has no excuse.
		"typescript/no-deprecated": "warn",
		"react/exhaustive-deps": "warn",
		"react/incompatible-library": "warn",
		"react/unsupported-syntax": "warn",
		"react/only-export-components": ["error", { allowConstantExport: true }],
		"no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }],
		"local/restricted-syntax": [
			"error",
			...RESTRICTED_SYNTAX,
			USE_SYNC_EXTERNAL_STORE_BAN,
			QUERY_CMD_BAN,
		],
		"local/no-ipc-in-loop": "warn",
		"local/domain-objects": "error",
		"local/deprecated-format": "error",
		"local/no-redundant-mutate-guard": "warn",
		"local/no-selection-alias": "warn",
		"local/no-primitive-class": "error",
		"local/no-effect-event-in-memo": "error",
		"local/no-native-dialog": "error",
		"local/no-undefined-css-class": "error",
		"local/no-label-wrapped-group": "error",
		"local/no-handrolled-dialog-parts": "error",
		"local/no-handrolled-widgets": "error",
	},
	overrides: [
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
			rules: { "local/restricted-syntax": ["error", ...RESTRICTED_SYNTAX] },
		},
		{
			// The store owns the query wrappers, so it is the one file that calls them raw.
			files: ["src/store/query.ts"],
			rules: {
				"local/restricted-syntax": ["error", ...RESTRICTED_SYNTAX, USE_SYNC_EXTERNAL_STORE_BAN],
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
			// Legacy shims are the sanctioned aliases: they keep shipped plugins' calls working.
			files: ["src/legacy.ts"],
			rules: { "local/no-selection-alias": "off" },
		},
		{
			files: ["src/store/commandDefs.ts"],
			rules: { "local/no-duplicate-command-icons": "error" },
		},
		{
			// The sanctioned raw select: this primitive wraps it.
			files: ["src/components/primitives/NSelect.tsx"],
			rules: { "local/restricted-syntax": "off" },
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
			rules: {
				"local/restricted-syntax": ["error", ...E2E_BRIDGE_RULES, ...E2E_TIMING_RULES],
			},
		},
		{
			// Benchmarks, engine A/B tools and the mock's latency model measure or model time on purpose.
			files: E2E_TIMED_TOOLS,
			rules: { "local/restricted-syntax": ["error", ...E2E_BRIDGE_RULES] },
		},
	],
});
