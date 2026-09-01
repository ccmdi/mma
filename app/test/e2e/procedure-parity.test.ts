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
	setEnrich,
	type Build,
} from "./parityDriver";
import { fixtureRows, key, kindOf } from "./parityFixture";

/**
 * Drives one build over the hostile fixture and dumps what it left behind. It asserts
 * almost nothing on its own: run it against both images and diff the two dumps with
 * scripts/compare-parity.mjs, which owns the list of divergences we intend.
 *
 *   MMA_E2E_SV_HIDDEN_CAPTURE=1 bash scripts/e2e.sh --mock test/e2e/procedure-parity.test.ts
 *   MMA_E2E_IMAGE=mma-v092-e2e:latest MMA_E2E_SV_HIDDEN_CAPTURE=1 bash scripts/e2e.sh --mock \
 *     test/e2e/procedure-parity.test.ts
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
	"datetime",
	"timezone",
];

const RESULT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "../perf/results");

describe("procedure parity: enrichment over the hostile fixture", () => {
	let build: Build;
	let mapId = "";

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

	it("enriches every fixture row and dumps the outcome", async () => {
		const run = await runEnrich(build, false);
		const rows = await dumpRows(build.legacy);

		const dump = {
			side: build.legacy ? "v092" : "head",
			build,
			fields: FIELDS,
			durationMs: run.durationMs,
			outcomes: run.outcomes,
			rows: rows.map((r) => {
				const k = key(r as { lat: unknown; lng: unknown });
				return { key: k, kind: kindOf(k), ...r };
			}),
		};
		fs.mkdirSync(RESULT_DIR, { recursive: true });
		const out =
			process.env.MMA_PARITY_OUT ?? path.join(RESULT_DIR, `parity-${dump.side}.json`);
		fs.writeFileSync(out, JSON.stringify(dump, null, "\t") + "\n");
		console.log(`[parity] ${dump.side}: ${rows.length} rows -> ${out}`);
		console.log("[parity] outcomes " + JSON.stringify(run.outcomes));

		if (rows.length !== fixtureRows().length) {
			throw new Error(`fixture lost rows: ${rows.length}/${fixtureRows().length}`);
		}
	});
});
