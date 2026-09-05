/**
 * The `ggapi` authenticated proxy, end to end: webview fetch -> scheme handler -> reqwest ->
 * upstream, and back. Upstream is the local stub (ggStubServer.ts) the app was launched
 * against via MMA_E2E_GG_ORIGIN, and the session is the one the harness seeded, so no
 * account, credentials or network are involved.
 *
 * The pure mapping/parsing logic is unit-tested in src-tauri/src/net/geoguessr.test.rs. The
 * sign-in window is not covered: creating a second native window wedges tauri-driver.
 */

import { waitForReady, withApi } from "./helpers";
import { GG_STUB_CONTROL_PATH, GG_STUB_NCFA, GG_STUB_NICK, ggStubPort } from "./ggStubServer";

const control = `http://127.0.0.1:${ggStubPort()}${GG_STUB_CONTROL_PATH}`;

interface Hit {
	method: string;
	url: string;
	cookie: string;
	body: string;
}

/** The stub runs in the wdio launcher process, so its record is read over HTTP. */
async function hits(reset = false): Promise<Hit[]> {
	const res = await fetch(control, reset ? { method: "DELETE" } : undefined);
	return ((await res.json()) as { hits: Hit[] }).hits;
}

interface ProxyResult {
	status: number;
	body: string;
}

/** GET through the `ggapi` scheme from inside the webview, as the app's client does. */
function ggFetch(path: string): Promise<ProxyResult> {
	return withApi(async (_api, p: string) => {
		const base = navigator.platform.startsWith("Win")
			? "http://ggapi.localhost"
			: "ggapi://localhost";
		const res = await fetch(base + p);
		return { status: res.status, body: await res.text() };
	}, path);
}

// Without the stub origin these would call geoguessr.com for real.
const stubbed = !!process.env.MMA_E2E_GG_ORIGIN;

describe("ggapi proxy", function () {
	before(async function () {
		if (!stubbed) this.skip();
		await waitForReady();
		await hits(true);
	});

	it("reads the signed-in profile through the stored session", async () => {
		const me = await withApi(async (api) => api.cmd.geoguessrMe());
		expect(me?.nick).toBe(GG_STUB_NICK);
		// The cookie is HttpOnly and lives only in Rust. If the proxy stopped attaching it,
		// every call would silently become an anonymous one.
		expect((await hits())[0].cookie).toContain(`_ncfa=${GG_STUB_NCFA}`);
	});

	it("maps path and query upstream and relays the body", async () => {
		await hits(true);
		const res = await ggFetch("/api/v4/user-maps/drafts?page=2");
		expect(res.status).toBe(200);
		const echo = JSON.parse(res.body) as { path: string; query: string; cookie: string };
		expect(echo.path).toBe("/api/v4/user-maps/drafts");
		expect(echo.query).toBe("page=2");
		expect(echo.cookie).toContain(`_ncfa=${GG_STUB_NCFA}`);
	});

	it("relays a non-2xx status and its body verbatim", async () => {
		// Callers branch on the upstream status (401 vs 409 vs 400); flattening it into a
		// generic proxy error would make those branches unreachable.
		const res = await ggFetch("/api/v4/teapot");
		expect(res.status).toBe(418);
		expect(JSON.parse(res.body)).toEqual({ message: "upstream said no" });
	});

	it("cannot be steered off the geoguessr origin", async () => {
		const before = (await hits(true)).length;
		const res = await ggFetch("//evil.example/api/v4/echo");
		expect(res.status).toBe(200);
		// Landing on the stub is the assertion: the host comes from the proxy's own origin
		// and never from the request path, so a caller cannot aim the session cookie
		// somewhere else.
		expect((JSON.parse(res.body) as { path: string }).path).toBe("/evil.example/api/v4/echo");
		expect((await hits()).length).toBe(before + 1);
	});

	it("answers 401 after a logout and never calls upstream", async () => {
		await withApi(async (api) => api.cmd.geoguessrLogout());
		expect(await withApi(async (api) => api.cmd.geoguessrHasSession())).toBe(false);
		await hits(true);
		const res = await ggFetch("/api/v4/user-maps/drafts");
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ message: "not signed in to GeoGuessr" });
		// Short-circuiting matters: an upstream call with no cookie comes back 200 with a
		// logged-out payload, which reads as success to every caller.
		expect(await hits()).toEqual([]);
	});
});
