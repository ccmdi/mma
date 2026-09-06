import { useMap, seedLocs, updateMapSettings, withApi } from "./helpers";

const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };
const LOCATION_COUNT = 600;

// The providers an enrich run holds, each with its own row in the dialog: pano
// resolution writes the panoId column the metadata pass requires. Every other provider
// is kept out of the run by the field selection below.
const PROVIDERS = ["Resolving panoramas", "Metadata"];

interface Row {
	label: string;
	bar: number;
	count: string;
}

interface Sample {
	status: string;
	/** Null once the run leaves the running state -- the meter only renders while running. */
	meter: string | null;
	bar: number | null;
	rows: Row[];
}

/** Record every rendered state of the progress dialog, not every state a poll happens to
 *  land on: a total that is briefly wrong and then settles has to be observable. */
async function recordProgress() {
	await browser.execute(() => {
		const w = window as unknown as { __bulkSamples?: Sample[]; __bulkObserver?: MutationObserver };
		w.__bulkSamples = [];
		const push = () => {
			const root = document.querySelector(".bulk-operation-modal");
			if (!root) return;
			const bar = root.querySelector(".bulk-operation__bar") as HTMLProgressElement | null;
			const rows = [...root.querySelectorAll(".bulk-operation__provider")].map((r) => ({
				label: r.querySelector(".bulk-operation__provider-label")?.textContent ?? "",
				bar: (r.querySelector(".bulk-operation__provider-bar") as HTMLProgressElement).value,
				count: r.querySelector(".bulk-operation__provider-count")?.textContent ?? "",
			}));
			const next = {
				status: root.querySelector(".bulk-operation__status")?.textContent ?? "",
				meter: root.querySelector(".bulk-operation__meter")?.textContent ?? null,
				bar: bar ? bar.value : null,
				rows,
			};
			const seen = w.__bulkSamples!;
			const last = seen[seen.length - 1];
			if (last && JSON.stringify(last) === JSON.stringify(next)) return;
			seen.push(next);
		};
		w.__bulkObserver?.disconnect();
		w.__bulkObserver = new MutationObserver(push);
		w.__bulkObserver.observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
		});
		push();
	});
}

async function drainSamples(): Promise<Sample[]> {
	return browser.execute(() => {
		const w = window as unknown as { __bulkSamples?: Sample[] };
		const out = w.__bulkSamples ?? [];
		w.__bulkSamples = [];
		return out;
	});
}

async function stopRecording() {
	await browser.execute(() => {
		const w = window as unknown as { __bulkObserver?: MutationObserver };
		w.__bulkObserver?.disconnect();
		w.__bulkObserver = undefined;
	});
}

/** `{done} / {total} ({pct}%)`, optionally trailed by a rate. */
function readMeter(meter: string): { done: number; total: number; pct: number } {
	const m = /^([\d,.\s]+?)\s*\/\s*([\d,.\s]+?)\s*\((\d+)%\)/.exec(meter);
	if (!m) throw new Error(`unparseable progress meter: ${JSON.stringify(meter)}`);
	const num = (s: string) => Number(s.replace(/[^\d]/g, ""));
	return { done: num(m[1]), total: num(m[2]), pct: Number(m[3]) };
}

/** `{done}/{total}`, optionally trailed by a failed count. */
function readCount(count: string): { done: number; total: number } {
	const m = /^([\d,.\s]+?)\/([\d,.\s]+)/.exec(count);
	if (!m) throw new Error(`unparseable provider count: ${JSON.stringify(count)}`);
	const num = (s: string) => Number(s.replace(/[^\d]/g, ""));
	return { done: num(m[1]), total: num(m[2]) };
}

async function openEnrichDialog() {
	await withApi(async (api) => {
		api.setSetting("pinnedCommands", ["bulk-enrich"]);
	});
	await browser.$('[data-qa="bulk-enrich"]').click();
	await browser.$(".bulk-operation-modal").waitForExist({ timeout: 10_000 });
	await browser.$(".bulk-operation-modal").$("button=Start").waitForClickable({ timeout: 10_000 });
}

describe("Bulk operation dialog -- enrichment progress", () => {
	useMap("E2E Bulk Progress");

	before(async () => {
		// Only fields the metadata pass produces, so exact dates, timezone and subdivision
		// stay out of the run and the provider rows are exactly the two asserted below.
		await updateMapSettings({
			enrichMetadata: true,
			enrichFields: ["countryCode", "altitude", "cameraType", "panoType", "imageDate"],
		});
		await seedLocs(LOCATION_COUNT, () => OFFICIAL_COORDS);
	});

	after(async () => {
		await stopRecording();
		await withApi(async (api) => {
			api.setSetting("pinnedCommands", []);
		});
	});

	it("shows every provider its own honest row and a monotonic overall bar", async () => {
		await openEnrichDialog();
		await recordProgress();
		await browser.$(".bulk-operation-modal").$("button=Start").click();

		const samples: Sample[] = [];
		// waitUntil retries a condition that throws, so a mid-run violation is banked and
		// ends the wait rather than asserted in place.
		const bad: string[] = [];
		const closeButton = () => browser.$(".bulk-operation-modal").$("button=Close");
		await browser.waitUntil(
			async () => {
				for (const s of await drainSamples()) {
					samples.push(s);
					if (s.meter == null) continue;
					const { done, total, pct } = readMeter(s.meter);
					// The doubled-total bug: a total that summed providers read 2N.
					if (total > LOCATION_COUNT || done > total || pct > 100) bad.push(s.meter);
					for (const r of s.rows) {
						const c = readCount(r.count);
						if (c.total > LOCATION_COUNT || c.done > c.total) bad.push(`${r.label} ${r.count}`);
					}
				}
				return bad.length > 0 || (await closeButton().isExisting());
			},
			{
				timeout: 120_000,
				interval: 50,
				timeoutMsg: "bulk enrichment never reached a terminal state",
			},
		);
		samples.push(...(await drainSamples()));
		await stopRecording();
		expect(bad).toEqual([]);

		const running = samples.filter((s) => s.meter != null);
		expect(running.length).toBeGreaterThan(0);

		// Every provider of the run gets a row, labels stay for the whole run, and each
		// row's done only grows -- there are no phases to reset between.
		const labelsSeen = new Set(running.flatMap((s) => s.rows.map((r) => r.label)));
		expect([...labelsSeen].sort()).toEqual([...PROVIDERS].sort());
		const perProvider = new Map<string, number>();
		const overall: number[] = [];
		for (const s of running) {
			overall.push(readMeter(s.meter!).done);
			for (const r of s.rows) {
				const c = readCount(r.count);
				expect(c.done).toBeGreaterThanOrEqual(perProvider.get(r.label) ?? 0);
				perProvider.set(r.label, c.done);
			}
		}
		// Overall is rows finished through every provider: monotonic, and it covers the
		// whole run by the end.
		for (let i = 1; i < overall.length; i++) {
			expect(overall[i]).toBeGreaterThanOrEqual(overall[i - 1]);
		}
		const totals = running.map((s) => readMeter(s.meter!).total);
		expect(Math.max(...totals)).toBe(LOCATION_COUNT);

		const last = samples[samples.length - 1];
		expect(last.meter).toBe(null);
		expect(last.bar).toBe(1);
		expect(last.status).toContain("updated");
		expect(await closeButton().isExisting()).toBe(true);
		await closeButton().click();
	});
});
