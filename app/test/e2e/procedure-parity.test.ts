import fs from "node:fs";
import path from "node:path";
import { waitForReady } from "./helpers";
import {
	addFixture,
	createMap,
	detectBuild,
	dropMap,
	dumpRows,
	runEnrich,
	runPin,
	runValidate,
	setEnrich,
	type Build,
} from "./parityDriver";
import { fixtureRows, key, kindOf } from "./parityFixture";

/**
 * Drives one build over the hostile fixture, one procedure at a time, and dumps what it
 * left behind after each. It asserts almost nothing on its own: run it against both
 * images and diff the two dumps with scripts/compare-parity.mjs, which owns the list of
 * divergences we intend.
 *
 *   MMA_E2E_SV_HIDDEN_CAPTURE=1 bash scripts/e2e.sh --mock test/e2e/procedure-parity.test.ts
 *   MMA_E2E_IMAGE=mma-v092-e2e:latest MMA_E2E_SV_HIDDEN_CAPTURE=1 bash scripts/e2e.sh --mock \
 *     test/e2e/procedure-parity.test.ts
 *
 * Phases run in a fixed order on one map, so each dump is what the previous phase left
 * plus this phase's work -- a divergence is attributed to the phase that introduced it.
 * `bulkPanHeading` is deliberately absent: neither build exposes it on the API, so
 * driving it would mean driving two different bulk dialogs.
 */

/** Fields both builds know. A field only one side has would read as a divergence for
 *  every row, drowning the ones that matter. */
const FIELDS = [
	"countryCode",
	"altitude",
	"cameraType",
	"panoType",
	"imageDate",
	"uploaderName",
	"subdivision",
	"datetime",
	"timezone",
];

const RESULT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "../perf/results");

interface Phase {
	name: string;
	durationMs: number;
	outcomes: unknown;
	rows: Record<string, unknown>[];
}

describe("procedure parity: every procedure over the hostile fixture", () => {
	let build: Build;
	let mapId = "";
	const phases: Phase[] = [];

	const snapshot = async (name: string, durationMs: number, outcomes: unknown) => {
		const rows = await dumpRows(build.legacy);
		phases.push({
			name,
			durationMs,
			outcomes,
			rows: rows.map((r) => {
				const k = key(r as { lat: unknown; lng: unknown });
				return { key: k, kind: kindOf(k), ...r };
			}),
		});
		if (rows.length !== fixtureRows().length) {
			throw new Error(`${name} lost rows: ${rows.length}/${fixtureRows().length}`);
		}
	};

	before(async () => {
		await waitForReady();
		await browser.setTimeout({ script: 900_000 });
		build = await detectBuild();
		mapId = await createMap(`Parity ${Date.now()}`);
		await setEnrich(FIELDS);
		await addFixture(fixtureRows(), build.legacy);
	});

	after(async () => {
		if (mapId) await dropMap(mapId);
	});

	it("enriches", async () => {
		const run = await runEnrich(build, false);
		await snapshot("enrich", run.durationMs, run.outcomes);
	});

	it("pins to panoramas", async () => {
		const run = await runPin(build, true);
		await snapshot("pin", run.durationMs, run.outcomes);
	});

	it("validates", async () => {
		const run = await runValidate(build);
		await snapshot("validate", run.durationMs, run.states);
	});

	it("writes the dump", async () => {
		const side = build.legacy ? "v092" : "head";
		const dump = { side, build, fields: FIELDS, phases };
		fs.mkdirSync(RESULT_DIR, { recursive: true });
		const out = process.env.MMA_PARITY_OUT ?? path.join(RESULT_DIR, `parity-${side}.json`);
		fs.writeFileSync(out, JSON.stringify(dump, null, "\t") + "\n");
		console.log(`[parity] ${side}: ${phases.length} phases -> ${out}`);
		for (const p of phases) {
			console.log(`[parity]   ${p.name} ${p.durationMs}ms ${JSON.stringify(p.outcomes)}`);
		}
	});
});
