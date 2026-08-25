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
import { svMockCore } from "./svMockCore";

export const SV_STUB_DEFAULT_PORT = 4599;

/** Milliseconds every mocked Street View answer waits before it is sent. Zero by default,
 *  so specs stay fast; a benchmark sets it, because a provider's width only shows up
 *  against a request that takes time. Read by both mock surfaces (this server for the
 *  engine, `installSvMock` for the webview) so an A/B measures the same network. */
export function svStubLatencyMs(): number {
	const raw = Number(process.env.MMA_E2E_SV_LATENCY_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Port the harness serves on: from MMA_E2E_SV_ORIGIN if the launcher set one. */
export function svStubPort(): number {
	const origin = process.env.MMA_E2E_SV_ORIGIN;
	if (origin) {
		const p = Number(new URL(origin).port);
		if (p) return p;
	}
	return Number(process.env.MMA_E2E_SV_PORT) || SV_STUB_DEFAULT_PORT;
}

export interface SvStub {
	port: number;
	/** One line per served request, in arrival order. */
	hits: string[];
	close: () => Promise<void>;
}

export async function startSvStub(
	port = svStubPort(),
	log: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Promise<SvStub> {
	const core = svMockCore();
	const hits: string[] = [];
	const latency = svStubLatencyMs();

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const url = req.url ?? "";
			const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null;
			const reply = core.respond(url, body);
			const line = `[sv-stub] ${req.method} ${reply ? reply.kind : "404"} ${url.slice(0, 120)}`;
			hits.push(line);
			log(line);
			if (!reply) {
				res.writeHead(404).end();
				return;
			}
			const payload =
				typeof reply.body === "string" ? Buffer.from(reply.body, "utf-8") : Buffer.from(reply.body);
			const send = () => {
				res.writeHead(reply.status, {
					"content-type": reply.contentType,
					"content-length": String(payload.length),
				});
				res.end(payload);
			};
			if (latency > 0) setTimeout(send, latency);
			else send();
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
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
