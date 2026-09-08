/** Plural forms written at the call site. Authors supply English's `one`/`other`; other locales
 *  supply whatever categories `Intl.PluralRules` demands for them (Russian needs `few`/`many`). */
export interface PluralForms {
	one: string;
	other: string;
}

export type MessageSource = string | PluralForms;
export type MessageParams = Record<string, string | number>;
type CatalogEntry = string | Record<string, string>;

let catalog: Record<string, CatalogEntry> = {};
let locale = "en";
let pluralRules = new Intl.PluralRules("en");
let countFormat = new Intl.NumberFormat("en");

/** Load a locale's catalog. Call once before the first render -- language changes relaunch the
 *  app rather than re-rendering, so nothing observes `locale` changing mid-flight. */
export async function initLocale(code: string): Promise<void> {
	// The DEV branch constant-folds away in production, so en-XA never becomes a shipped chunk.
	const catalogs = import.meta.env.DEV
		? import.meta.glob<{ default: Record<string, CatalogEntry> }>("../locales/*.json")
		: import.meta.glob<{ default: Record<string, CatalogEntry> }>([
				"../locales/*.json",
				"!../locales/en-XA.json",
			]);
	const load = catalogs[`../locales/${code}.json`];
	catalog = load ? (await load()).default : {};
	locale = code;
	pluralRules = new Intl.PluralRules(code);
	countFormat = new Intl.NumberFormat(code);
	// Drives font selection for CJK and the language reported to screen readers.
	document.documentElement.lang = code;
}

export function getLocale(): string {
	return locale;
}

/** Marks a display string that lives in a data table so the extractor sees it. Identity at
 *  runtime -- the render site is what calls {@link t}. */
export function msg<const T extends string>(s: T): T {
	return s;
}

function catalogKey(src: MessageSource): string {
	return typeof src === "string" ? src : src.other;
}

/** The message text for `src` in the active locale, before interpolation. Falls back to the
 *  source string, so an untranslated key renders correct English rather than a key name. */
function lookup(src: MessageSource, params?: MessageParams): string {
	const entry = catalog[catalogKey(src)];
	if (typeof src !== "string") {
		const category = pluralRules.select(typeof params?.n === "number" ? params.n : 0);
		if (entry && typeof entry === "object") return entry[category] ?? entry.other ?? src.other;
		return category === "one" ? src.one : src.other;
	}
	if (typeof entry === "string") return entry;
	return src;
}

/** `n` is the count slot: it drives plural selection and is grouped per locale. Every other
 *  param interpolates verbatim, so years, versions, and ids keep their exact form. */
function interpolated(value: string | number, key: string): string {
	return key === "n" && typeof value === "number" ? countFormat.format(value) : String(value);
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function t(src: MessageSource, params?: MessageParams): string {
	const text = lookup(src, params);
	if (!params) return text;
	return text.replace(PLACEHOLDER, (whole, key: string) =>
		key in params ? interpolated(params[key], key) : whole,
	);
}

/** The resolved message split into literal runs and `{param}` slots, with string and number
 *  params already interpolated. Backs `<Trans>`, whose params can be React nodes. */
export function splitMessage(
	src: MessageSource,
	params: MessageParams,
): Array<string | { param: string }> {
	// split() with one capture group alternates literal, key, literal, key, ...
	return lookup(src, params)
		.split(PLACEHOLDER)
		.map((part, i) => {
			if (i % 2 === 0) return part;
			return part in params ? interpolated(params[part], part) : { param: part };
		});
}
