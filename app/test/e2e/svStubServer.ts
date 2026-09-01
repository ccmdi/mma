/**
 * Local HTTP Street View stub for the Rust procedure engine.
 *
 * The engine fetches with reqwest from the Rust side, so the webview mock (svMock.ts)
 * cannot see it. Under `--mock` the harness starts this server and the app is launched
 * with MMA_E2E_SV_ORIGIN pointing at it; `http_fetch` (e2e feature only) rewrites the
 * origin of every outgoing request to match, so the same three RPC paths land here and
 * are answered by the same builders the webview uses.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { svMockCore, type SvMockConfig } from "./svMockCore";
import { loadNetModel } from "./svLatency";

export const SV_STUB_DEFAULT_PORT = 4599;

/** Port the harness serves on: from MMA_E2E_SV_ORIGIN if the launcher set one. */
export function svStubPort(): number {
	const origin = process.env.MMA_E2E_SV_ORIGIN;
	if (origin) {
		const p = Number(new URL(origin).port);
		if (p) return p;
	}
	return Number(process.env.MMA_E2E_SV_PORT) || SV_STUB_DEFAULT_PORT;
}

/** The one mock configuration both surfaces run on: the webview patch is handed this
 *  serialized, the stub builds it here. An A/B is only fair while they agree. */
export function svMockConfig(): SvMockConfig {
	return {
		net: loadNetModel(),
		hiddenCapture: !!process.env.MMA_E2E_SV_HIDDEN_CAPTURE,
		maxInflight: Number(process.env.MMA_E2E_SV_MAX_INFLIGHT ?? 0),
		faults: process.env.MMA_E2E_SV_FAULTS ? JSON.parse(process.env.MMA_E2E_SV_FAULTS) : undefined,
	};
}

export interface SvStub {
	port: number;
	/** One line per served request, in arrival order, up to `LOG_LIMIT`. */
	hits: string[];
	/** Every request served, logged or not. */
	served: () => number;
	close: () => Promise<void>;
}

/** A scale run serves hundreds of thousands of requests; logging each one costs more
 *  than answering it, and would be the thing a throughput number measured. */
const LOG_LIMIT = 200;

/** Control paths the stub answers on its own behalf, so a spec worker can read the
 *  request timeline the launcher process owns. */
export const SV_STUB_TIMELINE_PATH = "/__mma/timeline";
export const SV_STUB_FAULTS_PATH = "/__mma/faults";

export async function startSvStub(
	port = svStubPort(),
	log: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Promise<SvStub> {
	const core = svMockCore(svMockConfig());
	const hits: string[] = [];
	let served = 0;

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const url = req.url ?? "";
			const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null;
			if (url.startsWith(SV_STUB_FAULTS_PATH)) {
				try {
					core.setFaults(body ? JSON.parse(Buffer.from(body).toString("utf8")) : {});
					res.writeHead(200, { "content-type": "application/json" }).end("{}");
				} catch (e) {
					res.writeHead(400).end(String(e));
				}
				return;
			}
			if (url.startsWith(SV_STUB_TIMELINE_PATH)) {
				if (req.method === "DELETE") core.net.timeline.length = 0;
				const payload = Buffer.from(JSON.stringify(core.net.timeline), "utf-8");
				res.writeHead(200, {
					"content-type": "application/json",
					"content-length": String(payload.length),
				});
				res.end(payload);
				return;
			}
			const reply = core.respond(url, body);
			served++;
			if (served <= LOG_LIMIT) {
				const line = `[sv-stub] ${req.method} ${reply ? reply.kind : "404"} ${url.slice(0, 120)}`;
				hits.push(line);
				log(line);
				if (served === LOG_LIMIT) log(`[sv-stub] ${LOG_LIMIT} requests logged; muting the rest`);
			}
			if (!reply) {
				res.writeHead(404).end();
				return;
			}
			const payload =
				typeof reply.body === "string" ? Buffer.from(reply.body, "utf-8") : Buffer.from(reply.body);
			void core.net.serve(reply.kind).then(() => {
				res.writeHead(reply.status, {
					"content-type": reply.contentType,
					"content-length": String(payload.length),
				});
				res.end(payload);
			});
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const actual = (server.address() as AddressInfo).port;
	log(`[sv-stub] listening on http://127.0.0.1:${actual}`);

	return {
		port: actual,
		hits,
		served: () => served,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
