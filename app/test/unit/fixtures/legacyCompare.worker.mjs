import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";

import { compareTypes } from "../../../../plugins/check-legacy.mjs";

parentPort.on("message", ({ i, job }) => {
	const dir = mkdtempSync(join(job.dir ?? tmpdir(), "mma-legacy-"));
	try {
		const [oldPath, newPath] = [join(dir, "old.d.ts"), join(dir, "new.d.ts")];
		writeFileSync(oldPath, job.before);
		writeFileSync(newPath, job.after);
		const { missing, broken } = compareTypes(oldPath, newPath);
		parentPort.postMessage({ i, result: { missing, broken: broken.map((b) => b.name) } });
	} catch (e) {
		parentPort.postMessage({ i, error: e instanceof Error ? e.stack : String(e) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
