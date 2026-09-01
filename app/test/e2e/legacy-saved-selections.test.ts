import { waitForReady, withApi } from "./helpers";

/**
 * The pre-0.10 handoff: saved selections lived in the `appSettings` localStorage blob and
 * move to SQLite on first launch of a build that has the migration. Reproducing it needs a
 * real page load, because the failure is an ordering one between two module-level effects,
 * so these drive `location.reload()` rather than calling the importer directly.
 */

const LEGACY_RULE = {
	id: "legacy-e2e-1",
	name: "E2E Legacy Rule",
	items: [{ props: { type: "TagName", tagName: "e2e-legacy-tag" }, color: [255, 0, 0] }],
	createdAt: 1_700_000_000_000,
};

async function clearSavedSelections() {
	await withApi(async (api) => {
		const rows = await api.cmd.storeListSavedSelections();
		for (const r of rows) await api.cmd.storeDeleteSavedSelection(r.id);
	});
}

/** Write a v0.9.2-shaped `appSettings` blob, then reload so module init runs against it. */
async function seedLegacyBlobAndReload(rules: unknown[]) {
	await browser.execute((json: string) => {
		const raw = localStorage.getItem("appSettings");
		const blob = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		blob.savedSelections = JSON.parse(json);
		localStorage.setItem("appSettings", JSON.stringify(blob));
	}, JSON.stringify(rules));

	await browser.refresh();
	await waitForReady();
}

/** The index is read lazily from render paths, so ask for it, then wait for SQLite. */
async function importedRules() {
	await withApi((api) => api.getSavedSelectionIndex());
	let rows: { id: string; name: string }[] = [];
	await browser
		.waitUntil(
			async () => {
				rows = await withApi(async (api) => api.cmd.storeListSavedSelections());
				return rows.length > 0;
			},
			{ timeout: 10000, interval: 250, timeoutMsg: "legacy rules never reached SQLite" },
		)
		.catch(() => undefined);
	return rows;
}

describe("Legacy saved selections survive the upgrade", () => {
	before(async () => {
		await waitForReady();
		await clearSavedSelections();
	});

	after(async () => {
		await clearSavedSelections();
		await browser.execute(() => {
			const raw = localStorage.getItem("appSettings");
			if (!raw) return;
			const blob = JSON.parse(raw) as Record<string, unknown>;
			delete blob.savedSelections;
			localStorage.setItem("appSettings", JSON.stringify(blob));
		});
	});

	it("a rule stored by v0.9.2 is imported into SQLite", async () => {
		await seedLegacyBlobAndReload([LEGACY_RULE]);
		const rows = await importedRules();
		expect(rows.map((r) => r.name)).toContain("E2E Legacy Rule");
	});

	it("the blob still carries the rule when the importer runs", async () => {
		await seedLegacyBlobAndReload([LEGACY_RULE]);
		const present = await browser.execute(() => {
			const raw = localStorage.getItem("appSettings");
			const list = raw
				? (JSON.parse(raw) as { savedSelections?: unknown[] }).savedSelections
				: null;
			return Array.isArray(list) && list.length > 0;
		});
		expect(present).toBe(true);
	});
});
