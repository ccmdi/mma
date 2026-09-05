import { useMap, seedLocs, updateMapSettings, withApi } from "./helpers";

const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };
const LOCATION_COUNT = 600;

// The waves an enrich run walks, in order: pano resolution writes the panoId column that
// the metadata pass requires. Every other provider is kept out of the run by the field
// selection below, so these two are the whole phase vocabulary.
const PHASES = ["Resolving panoramas", "Metadata"];

interface Sample {
	status: string;
	/** Null once the run leaves the running state -- the meter only renders while running. */
	meter: string | null;
	bar: number | null;
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
			const next = {
				status: root.querySelector(".bulk-operation__status")?.textContent ?? "",
				meter: root.querySelector(".bulk-operation__meter")?.textContent ?? null,
				bar: bar ? bar.value : null,
			};
			const seen = w.__bulkSamples!;
			const last = seen[seen.length - 1];
			if (last && last.status === next.status && last.meter === next.meter && last.bar === next.bar)
				return;
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
		// stay out of the run and the phase order is the two waves asserted below.
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

	it("never displays a total above the locations in the run, and walks the real phases", async () => {
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
					// The doubled-total bug: a phase whose total summed every provider of the
					// wave read 2N under one phase's label before settling.
					if (total > LOCATION_COUNT || done > total || pct > 100) bad.push(s.meter);
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

		const labels: string[] = [];
		for (const s of running) {
			if (s.status !== "" && s.status !== labels[labels.length - 1]) labels.push(s.status);
		}
		expect(labels.length).toBeGreaterThan(0);
		// Every label is a real phase, each appears once, and they appear in wave order.
		expect(labels).toEqual(PHASES.filter((p) => labels.includes(p)));
		// The bar covered the whole run rather than some fraction of it, so the ceiling
		// asserted above is the one a doubled total would have broken.
		const totals = running.filter((s) => s.status !== "").map((s) => readMeter(s.meter!).total);
		expect(Math.max(...totals)).toBe(LOCATION_COUNT);

		const last = samples[samples.length - 1];
		expect(last.meter).toBe(null);
		expect(last.bar).toBe(1);
		expect(last.status).toContain("updated");
		expect(await closeButton().isExisting()).toBe(true);
		await closeButton().click();
	});
});
