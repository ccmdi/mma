/**
 * Local HTTP GeoGuessr stub.
 *
 * The `ggapi` proxy and the sign-in cookie lift both run Rust-side, with reqwest and a real
 * webview, so the window.fetch mock cannot see them. The harness starts this server and the app is launched with MMA_E2E_GG_ORIGIN
 * pointing at it (scripts/internal/e2e-native.sh); `origin()` in net/geoguessr.rs (e2e
 * feature only) reads that, so every upstream call and the sign-in page itself land here
 * instead of geoguessr.com.
 *
 * The stub lives in the wdio launcher process, so a spec worker drives it over the control
 * paths below rather than by touching this object.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const GG_STUB_DEFAULT_PORT = 4601;

/** Port the harness serves on: from MMA_E2E_GG_ORIGIN if the launcher set one. */
export function ggStubPort(): number {
	const origin = process.env.MMA_E2E_GG_ORIGIN;
	if (origin) {
		const p = Number(new URL(origin).port);
		if (p) return p;
	}
	return Number(process.env.MMA_E2E_GG_PORT) || GG_STUB_DEFAULT_PORT;
}

/** The session the app was seeded with (scripts/internal/e2e-native.sh sets both sides). */
export const GG_STUB_NCFA = process.env.MMA_E2E_GG_NCFA || "e2e-ncfa-token";
export const GG_STUB_NICK = "e2e-user";

export const GG_STUB_CONTROL_PATH = "/__mma/gg";

export interface GgHit {
	method: string;
	url: string;
	cookie: string;
	body: string;
}

export interface GgStub {
	port: number;
	close: () => Promise<void>;
}

export async function startGgStub(
	port = ggStubPort(),
	log: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Promise<GgStub> {
	let hits: GgHit[] = [];

	const json = (res: http.ServerResponse, status: number, value: unknown) => {
		const payload = Buffer.from(JSON.stringify(value), "utf-8");
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": String(payload.length),
		});
		res.end(payload);
	};

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const url = req.url ?? "";
			const method = req.method ?? "GET";
			if (url.startsWith(GG_STUB_CONTROL_PATH)) {
				if (method === "DELETE") hits = [];
				json(res, 200, { hits });
				return;
			}
			const hit: GgHit = {
				method,
				url,
				cookie: String(req.headers.cookie ?? ""),
				body: Buffer.concat(chunks).toString("utf-8"),
			};
			hits.push(hit);
			log(`[gg-stub] ${method} ${url.slice(0, 120)}`);

			const path = url.split("?")[0];
			const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
			if (path === "/api/v3/profiles") {
				json(res, 200, { user: { id: "e2e-1", nick: GG_STUB_NICK } });
				return;
			}
			if (path === "/api/v4/teapot") {
				json(res, 418, { message: "upstream said no" });
				return;
			}
			json(res, 200, { path, query, cookie: hit.cookie, method, body: hit.body });
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const actual = (server.address() as AddressInfo).port;
	log(`[gg-stub] listening on http://127.0.0.1:${actual}`);

	return {
		port: actual,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
