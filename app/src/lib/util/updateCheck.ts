import { emit, useEventValue } from "@/lib/events";
import { log } from "@/lib/util/log";
import { getSettings } from "@/store/settings";
import { saveSession } from "@/store/session";
import { openWindows } from "@/lib/window";
import { cmpVersion, isPrereleaseVersion, errText } from "@/lib/util/util";
import { appVersion } from "@/lib/version";
import { cmd } from "@/lib/commands";
import { events } from "@/bindings.gen";
import { getLocal, setLocal, persisted } from "@/lib/hooks/useLocalStorage";

const REPO = "ccmdi/mma";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
/** A published GitHub release. The release, not CHANGELOG.md, is what the app reads: nothing
 *  exists until it is published, and pre-release is a fact of the release rather than of a
 *  file on master. */
export interface Release {
	tag: string;
	version: string;
	body: string;
	prerelease: boolean;
	publishedAt: string;
	/** This release's own `latest.json`, which the updater is pointed at. */
	manifestUrl: string | null;
}

/** A release the updater can actually be pointed at. */
type Installable = Release & { manifestUrl: string };

export interface ApiRelease {
	tag_name: string;
	body: string | null;
	draft: boolean;
	prerelease: boolean;
	published_at: string | null;
	assets: { name: string; browser_download_url: string }[];
}

let releasesPromise: Promise<Release[] | null> | null = null;

/** Unauthenticated GitHub allows 60 calls an hour per IP, and every window checks on launch.
 *  Caching across windows keeps a session of opening maps well clear of that. */
const CACHE_TTL_MS = 30 * 60 * 1000;
const releaseCache = persisted<{ at: number; list: Release[] } | null>("mma-releases", null);

/** Published app releases, newest first. The update check and the map list's "what's new"
 *  panel share the one fetch. `force` is for the manual check button, which has to be able to
 *  see a release cut in the last half hour. */
export function fetchReleases(force = false): Promise<Release[] | null> {
	const cached = getLocal(releaseCache);
	if (!force && cached && Date.now() - cached.at <= CACHE_TTL_MS)
		return Promise.resolve(cached.list);
	if (force) releasesPromise = null;
	releasesPromise ??= fetchReleasesUncached();
	return releasesPromise;
}

async function fetchReleasesUncached(): Promise<Release[] | null> {
	try {
		const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const raw = (await res.json()) as ApiRelease[];
		const list = raw.filter((r) => !r.draft && /^v\d/.test(r.tag_name)).map(toRelease);
		list.sort((a, b) => cmpVersion(b.version, a.version));
		if (!list.length) return null;
		setLocal(releaseCache, { at: Date.now(), list });
		return list;
	} catch (e) {
		log.warn("[updater] release list unavailable:", e);
		return null;
	}
}

/** The one place a GitHub release becomes a [`Release`], including what counts as a
 *  pre-release: the repo's own flag, or a semver pre-release tag on the version. */
export function toRelease(r: ApiRelease): Release {
	const version = r.tag_name.replace(/^v/, "");
	return {
		tag: r.tag_name,
		version,
		body: r.body ?? "",
		prerelease: r.prerelease || isPrereleaseVersion(version),
		publishedAt: r.published_at ?? "",
		manifestUrl: r.assets.find((a) => a.name === "latest.json")?.browser_download_url ?? null,
	};
}

/** The newest release worth offering to someone on `current`, or null if they are up to date.
 *  Never returns something older than `current`: turning pre-releases off leaves you where you
 *  are until stable catches up, it does not roll you back. */
export function pickRelease(
	releases: readonly Release[],
	current: string,
	includePrerelease: boolean,
): Installable | null {
	const eligible = releases.filter(
		(r): r is Installable =>
			r.manifestUrl !== null &&
			(includePrerelease || !r.prerelease) &&
			cmpVersion(r.version, current) > 0,
	);
	return eligible[0] ?? null;
}

type Phase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";

interface UpdateState {
	phase: Phase;
	version: string | null;
	notes: string;
	/** Whether the offered version is a pre-release. */
	prerelease: boolean;
	percent: number;
	error: string | null;
	dismissed: boolean;
}

let state: UpdateState = {
	phase: "idle",
	version: null,
	notes: "",
	prerelease: false,
	percent: 0,
	error: null,
	dismissed: false,
};

function set(patch: Partial<UpdateState>) {
	state = { ...state, ...patch };
	emit("update:changed");
}

const DISMISS_KEY = "mma-update-dismissed-version";

export async function checkForUpdate(force = false) {
	set({ phase: "checking", error: null });
	try {
		const target = await resolveTarget(force);
		if (!target) {
			set({ phase: "up-to-date", version: null, prerelease: false });
			return;
		}
		const found = await cmd.updateCheck(target.manifestUrl);
		if (!found) {
			set({ phase: "up-to-date", version: null, prerelease: false });
			return;
		}
		log.info(`[updater] update available: v${found.version}`);
		set({
			phase: "available",
			version: found.version,
			notes: target.body || found.notes || "",
			prerelease: target.prerelease,
			dismissed: localStorage.getItem(DISMISS_KEY) === found.version,
		});
	} catch (e) {
		log.warn("[updater] check failed:", e);
		set({ phase: "error", error: errText(e) });
	}
}

/** The release to point the updater at, or null when there is nothing to offer. */
async function resolveTarget(force: boolean): Promise<Installable | null> {
	const releases = await fetchReleases(force);
	const current = appVersion();
	if (!releases || !current) return null;
	return pickRelease(releases, current, getSettings().prereleaseUpdates);
}

// Updating never fires onCloseRequested (the installer kills the app
// inside downloadAndInstall), so snapshot the session here or the post-update
// restore reopens the stale list from the last normal quit.
async function snapshotSessionForRestart() {
	if (!getSettings().restoreSession) return;
	try {
		const ids = (await openWindows("editor")).map((w) => w.mapId);
		saveSession(ids);
		log.info(`[session] saved ${ids.length} open map(s) before restart: ${ids.join(", ")}`);
	} catch (e) {
		log.warn("[session] snapshot before restart failed:", e);
	}
}

export async function installUpdate() {
	if (state.phase !== "available" && state.phase !== "error") return;
	await snapshotSessionForRestart();
	set({ phase: "downloading", percent: 0, error: null });
	const unlisten = await events.updateProgress.listen((e) => {
		const { downloaded, total } = e.payload;
		if (total) set({ percent: Math.round((downloaded / total) * 100) });
	});
	try {
		await cmd.updateInstall();
		set({ phase: "ready" });
	} catch (e) {
		log.error("[updater] install failed:", e);
		set({ phase: "error", error: errText(e) });
	} finally {
		unlisten();
	}
}

export async function relaunchApp() {
	await snapshotSessionForRestart();
	const { relaunch } = await import("@tauri-apps/plugin-process");
	await relaunch();
}

export function dismissUpdate() {
	if (!state.version) return;
	localStorage.setItem(DISMISS_KEY, state.version);
	set({ dismissed: true });
}

export function useUpdateState(): UpdateState {
	return useEventValue("update:changed", () => state);
}
