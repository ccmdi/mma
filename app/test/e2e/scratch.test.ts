/**
 * SCRATCH — ad-hoc dynamic E2E verification.
 *
 * This file is EXCLUDED from the default suite (see wdio.conf.ts `exclude`), so it
 * never runs unless you ask for it explicitly. Edit it freely to prove that some
 * user-facing behavior works end-to-end across the whole stack, then run:
 *
 *   bash scripts/e2e-scratch.sh          # fresh ephemeral DB in Docker, SV mocked
 *   bash scripts/e2e.sh test/e2e/scratch.test.ts --mock   # same thing, long form
 *
 * `test/` is live-mounted into the e2e image, so editing this file needs NO rebuild.
 * Read the result in app/test/logs/<newest>.txt (pass/fail + assertion diffs).
 *
 * Everything a user can do is expressible here: `withApi` runs arbitrary async code
 * inside the running app with the full `window.MMA` API injected as `api`.
 */

import { addLocs, createLocation, getLoc, withApi, useMap } from "./helpers";

describe("scratch", () => {
	useMap("Scratch");

	it("example: a location round-trips through the store", async () => {
		const [id] = await addLocs([createLocation({ lat: 10, lng: 20, heading: 90 })]);

		// Arbitrary user action / orchestration goes here. `api` is window.MMA.
		await withApi(async (api, locId) => {
			await api.updateLocations([{ id: locId, heading: 180 }]);
			await api.autosave.flush();
		}, id);

		const loc = await getLoc(id);
		expect(loc.heading).toBe(180);
	});
});
