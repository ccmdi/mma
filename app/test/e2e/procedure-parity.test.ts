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

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RESULT_DIR = path.join(HERE, "../perf/results");
/** The pinned answer. Derived from a run that v0.9.2 agreed with row for row, so it
 *  outlives the ability to build the old tag - and unlike a two-build diff, it still
 *  fails when both sides regress the same way. Rewrite with MMA_PARITY_UPDATE_GOLDEN=1,
 *  and only with a reason. */
const GOLDEN = path.join(HERE, "fixtures/parity-golden.json");

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

	/** Providers report in wave-completion order, which is not stable run to run; the
	 *  set and its counts are the contract, not the order. */
	const stable = (outcomes: unknown): unknown =>
		Array.isArray(outcomes)
			? [...outcomes].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
			: outcomes;

	const snapshot = async (name: string, durationMs: number, outcomes: unknown) => {
		const rows = await dumpRows(build.legacy);
		phases.push({
			name,
			durationMs,
			outcomes: stable(outcomes),
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

	it("matches the pinned golden", function () {
		if (build.legacy) this.skip();
		const mine = phases.map((p) => ({ name: p.name, outcomes: p.outcomes, rows: p.rows }));
		if (process.env.MMA_PARITY_UPDATE_GOLDEN) {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, JSON.stringify({ phases: mine }, null, "\t") + "\n");
			console.log(`[parity] golden rewritten: ${GOLDEN}`);
			return;
		}
		if (!fs.existsSync(GOLDEN)) throw new Error(`no golden at ${GOLDEN}`);
		const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as { phases: unknown[] };
		expect(mine).toEqual(golden.phases);
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
