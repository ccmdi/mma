import http from "node:http";
import { svStubPort } from "./svStubServer";

/**
 * How fast the mock itself can answer, measured from a client that does nothing else.
 *
 *   bash scripts/e2e.sh --mock test/e2e/sv-stub-ceiling.test.ts
 *
 * This exists to keep a zero-latency A/B honest. The webview mock answers in-process (a
 * function call); the Rust engine's requests cross localhost HTTP into a single-threaded
 * Node server. If an engine's measured request rate is at or near this ceiling, the
 * number describes the harness, not the engine.
 */

const CONCURRENCY = Number(process.env.MMA_STUB_CONCURRENCY ?? 64);
const REQUESTS = Number(process.env.MMA_STUB_REQUESTS ?? 20000);

const BODY = JSON.stringify([
	["apiv3"],
	[[null, null, 40.758, -73.9855], 50],
	[
		[null, null, null, null, null, null, null, null, null, null, [1654041600, 1656633600]],
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		[1],
		null,
		[[[2, true, 2]]],
	],
	[[2, 6]],
]);

const PATH =
	"/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch";

function once(agent: http.Agent): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: svStubPort(),
				path: PATH,
				method: "POST",
				agent,
				headers: { "content-type": "application/json+protobuf" },
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve());
			},
		);
		req.on("error", reject);
		req.end(BODY);
	});
}

describe("sv stub ceiling", () => {
	it(`serves ${REQUESTS} requests at concurrency ${CONCURRENCY}`, async function () {
		this.timeout?.(600_000);
		const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
		let issued = 0;
		let done = 0;
		const started = Date.now();
		await new Promise<void>((resolve, reject) => {
			const pump = () => {
				while (issued < REQUESTS && issued - done < CONCURRENCY) {
					issued++;
					once(agent).then(
						() => {
							done++;
							if (done === REQUESTS) resolve();
							else pump();
						},
						(e: Error) => reject(e),
					);
				}
			};
			pump();
		});
		const ms = Date.now() - started;
		const rps = Math.round((REQUESTS / ms) * 1000);
		console.log(
			`[stub-ceiling] ${REQUESTS} requests, concurrency ${CONCURRENCY}: ${ms}ms -> ${rps} req/s`,
		);
		agent.destroy();
		expect(done).toBe(REQUESTS);
	});
});
