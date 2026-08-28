// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import { t, msg, initLocale, getLocale } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";
import {
	staleCatalogs,
	pseudo,
	auditUnwrapped,
	catalogTargets,
} from "../../scripts/i18n-extract.mjs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TAGS = { one: "{n} tag", other: "{n} tags" };

function renderToText(node: React.ReactNode): string {
	const host = document.createElement("div");
	const root = createRoot(host);
	act(() => root.render(node));
	const text = host.textContent ?? "";
	act(() => root.unmount());
	return text;
}

describe("i18n runtime", () => {
	beforeEach(async () => {
		// No catalog ships for "de-DE", so this exercises the fallback path with German plural
		// and number rules -- the shape every untranslated locale starts in.
		await initLocale("de-DE");
	});

	it("falls back to the source string when the catalog has no entry", () => {
		expect(t("Street View")).toBe("Street View");
		expect(getLocale()).toBe("de-DE");
	});

	it("interpolates params and leaves unknown placeholders visible", () => {
		expect(t("Top {k} by {field}", { k: 5, field: "Altitude" })).toBe("Top 5 by Altitude");
		expect(t("Requires app v{version}", {})).toBe("Requires app v{version}");
	});

	it("groups the count slot per locale but leaves other numbers verbatim", () => {
		expect(t("{n} selected", { n: 1234 })).toBe("1.234 selected");
		expect(t("Requires app v{version}", { version: 2026 })).toBe("Requires app v2026");
	});

	it("selects inline plural forms with the locale's rules", () => {
		expect(t(TAGS, { n: 1 })).toBe("1 tag");
		expect(t(TAGS, { n: 0 })).toBe("0 tags");
		expect(t(TAGS, { n: 2000 })).toBe("2.000 tags");
	});

	it("prefers a catalog entry over the source", async () => {
		await initLocale("en-XA");
		expect(t("Language")).toBe(pseudo("Language"));
	});

	it("msg() is identity", () => {
		expect(msg("Moving")).toBe("Moving");
	});
});

describe("Trans", () => {
	beforeEach(async () => {
		await initLocale("de");
	});

	it("splices React nodes into a translated sentence", () => {
		const text = renderToText(<Trans msg="Rename {n} tags in {name}" n={3} name={<b>Europe</b>} />);
		expect(text).toBe("Rename 3 tags in Europe");
	});

	it("formats the count slot and pluralises like t()", () => {
		expect(renderToText(<Trans msg={TAGS} n={1} />)).toBe("1 tag");
		expect(renderToText(<Trans msg={TAGS} n={4000} />)).toBe("4.000 tags");
	});

	it("shows unknown placeholders rather than dropping them", () => {
		expect(renderToText(<Trans msg="Hello {who}" />)).toBe("Hello {who}");
	});
});

const LOCALE_DIR = path.resolve(__dirname, "../../src/locales");
const locales = fs
	.readdirSync(LOCALE_DIR)
	.filter((f) => f.endsWith(".json"))
	.map((f) => ({
		code: f.replace(/\.json$/, ""),
		catalog: JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), "utf8")) as Record<
			string,
			string | Record<string, string>
		>,
	}));

const en = locales.find((l) => l.code === "en")!;
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
const forms = (entry: string | Record<string, string>) =>
	typeof entry === "string" ? [entry] : Object.values(entry);

describe("i18n catalogs", () => {
	it("are regenerated from the current source tree", () => {
		expect(staleCatalogs().map(([f]: string[]) => path.basename(f))).toEqual([]);
	});

	it("leave no user-visible string unwrapped", () => {
		const unwrapped: string[] = [];
		for (const [file, hits] of auditUnwrapped(catalogTargets().files)) {
			for (const h of hits as { kind: string; text: string }[]) {
				unwrapped.push(`${file}: [${h.kind}] ${JSON.stringify(h.text)}`);
			}
		}
		expect(unwrapped).toEqual([]);
	});

	it("ship at least the base locale and the pseudolocale", () => {
		expect(locales.map((l) => l.code).sort()).toEqual(expect.arrayContaining(["en", "en-XA"]));
	});

	for (const { code, catalog } of locales.filter((l) => l.code !== "en")) {
		// Deliberately strict in both directions. A missing key would render correct English via
		// `t()`'s fallback, so this could be a warning -- but then translations rot silently.
		it(`${code} covers every key in en with no orphans`, () => {
			expect(Object.keys(catalog).sort()).toEqual(Object.keys(en.catalog).sort());
		});

		it(`${code} keeps every placeholder from the source message`, () => {
			for (const [key, entry] of Object.entries(catalog)) {
				const expected = placeholders(key);
				for (const form of forms(entry)) {
					expect({ key, form, got: placeholders(form) }).toEqual({
						key,
						form,
						got: expected,
					});
				}
			}
		});

		it(`${code} covers the plural categories Intl requires`, () => {
			const required = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
			for (const [key, entry] of Object.entries(catalog)) {
				if (typeof en.catalog[key] === "string") continue;
				expect({ key, categories: Object.keys(entry).sort() }).toEqual({
					key,
					categories: [...required].sort(),
				});
			}
		});
	}
});
