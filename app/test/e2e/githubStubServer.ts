/**
 * Local HTTP stand-in for GitHub's `GET /user`, for the collab run.
 *
 * Each app in the run is seeded with one of these tokens (MMA_E2E_GITHUB_TOKEN) and pointed
 * here (MMA_GITHUB_API); the local collab Worker checks tokens here too (its
 * GITHUB_API var), so a token stands for the same login on both sides.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const GITHUB_STUB_DEFAULT_PORT = 4602;

export const GITHUB_STUB_LOGINS: Record<string, string> = {
	"token-host": "host",
	"token-alice": "alice",
	"token-bob": "bob",
};

export interface GithubStub {
	port: number;
	close: () => Promise<void>;
}

export async function startGithubStub(
	port = Number(process.env.MMA_E2E_GITHUB_PORT) || GITHUB_STUB_DEFAULT_PORT,
	log: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Promise<GithubStub> {
	const server = http.createServer((req, res) => {
		const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
		const login = GITHUB_STUB_LOGINS[token];
		const path = (req.url ?? "").split("?")[0];
		log(`[github-stub] ${req.method} ${path} -> ${login ?? "rejected"}`);
		const [status, body] =
			req.method === "GET" && path === "/user" && login
				? [200, { login, avatar_url: null }]
				: [401, { message: "Bad credentials" }];
		const payload = Buffer.from(JSON.stringify(body), "utf-8");
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": String(payload.length),
		});
		res.end(payload);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const actual = (server.address() as AddressInfo).port;
	log(`[github-stub] listening on http://127.0.0.1:${actual}`);

	return {
		port: actual,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
