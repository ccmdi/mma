// The app's TypeScript through its native API, for the scripts that read source and declarations.
import { dirname, join } from "node:path";
import * as ast from "@typescript/native/unstable/ast";
import * as sync from "@typescript/native/unstable/sync";

export const ts = { ...ast, ...sync };

const fileKey = (file) =>
	process.platform === "win32" ? file.replaceAll("\\", "/").toLowerCase() : file;

const served = new Map();
let api;
let configs = 0;

/** A compiler process for `options`, started again when a busy machine keeps it from opening
 *  its pipe in time. Every script and test starts the native compiler through this. */
export function startCompiler(options) {
	for (let attempt = 1; ; attempt++) {
		try {
			return new ts.API(options);
		} catch (error) {
			if (attempt === 5 || !String(error?.message).includes("timed out connecting")) throw error;
		}
	}
}

/** Runs `use(project)` on one program over `rootFiles`. `files` maps a path to the text served
 *  in place of the disk; every other file is read from disk. One compiler process serves
 *  every program in this process. */
export function withProgram(rootFiles, compilerOptions, use, files = new Map()) {
	api ??= startCompiler({
		cwd: import.meta.dirname,
		fs: {
			readFile: (file) => served.get(fileKey(file)),
			fileExists: (file) => served.has(fileKey(file)) || undefined,
		},
	});
	const config = join(dirname(rootFiles[0]), `tsconfig.native-${configs++}.json`);
	const paths = [config, ...files.keys()];
	for (const [path, text] of files) served.set(fileKey(path), text);
	served.set(fileKey(config), JSON.stringify({ files: rootFiles, compilerOptions }));
	const snapshot = api.updateSnapshot({
		openProjects: [config],
		fileChanges: { changed: [...files.keys()] },
	});
	try {
		return use(snapshot.getProject(config));
	} finally {
		snapshot.dispose();
		api.updateSnapshot({ closeProjects: [config] }).dispose();
		for (const path of paths) served.delete(fileKey(path));
	}
}
