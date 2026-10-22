// Three apps at once for the collab spec: a host and two joiners, each behind its own
// tauri-driver with its own data dir and GitHub login, meeting through a local Worker.
//
// Expects the drivers and the Worker already listening (see scripts/internal/e2e-collab.sh,
// which starts the drivers on these ports).

import { config as base } from "./wdio.conf";
import { startGithubStub, type GithubStub } from "./test/e2e/githubStubServer";

const { hostname: _h, port: _p, capabilities, ...shared } = base;
const [native] = capabilities as WebdriverIO.Capabilities[];
const drivers = { host: 4444, alice: 4446, bob: 4448 };

let githubStub: GithubStub | undefined;

export const config: WebdriverIO.Config = {
	...shared,
	specs: ["./test/e2e/collab.test.ts"],
	exclude: [],
	capabilities: Object.fromEntries(
		Object.entries(drivers).map(([name, port]) => [
			name,
			{ hostname: "localhost", port, path: "/", capabilities: native },
		]),
	),
	onPrepare: async (...args) => {
		githubStub = await startGithubStub();
		await (base.onPrepare as (...a: typeof args) => Promise<void>)(...args);
	},
	onComplete: async (...args) => {
		await githubStub?.close();
		await (base.onComplete as (...a: typeof args) => Promise<void>)(...args);
	},
};
