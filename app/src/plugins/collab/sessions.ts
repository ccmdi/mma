import { mdiAccountGroup, mdiAccountGroupOutline } from "@mdi/js";
import {
	events,
	type CollabSession,
	type CollabSessions,
	type Origin,
	type Via,
} from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { subscribeMany, useEventValue } from "@/lib/events";
import { Scene } from "@/lib/render/scene";
import { appWindow, openWindow, openWindows } from "@/lib/window";
import { latest } from "@/lib/util/latest";
import { definePluginEvent, emitPluginEvent } from "@/plugins/scope";
import { isPluginEnabled } from "@/plugins/registry";
import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { toast } from "@/lib/util/toast";
import { errText } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { msg, t } from "@/lib/i18n";
import { toPeople, type Person } from "./people";

const SESSIONS = definePluginEvent("collab", "sessions");

/** A collab session with everyone in it as people. */
export type Session = CollabSession & { people: Person[]; live: boolean; ended: boolean };

const Session = {
	of(raw: CollabSession): Session {
		return {
			...raw,
			people: toPeople(raw.roster),
			live: raw.link.state === "live",
			ended: raw.link.state === "ended",
		};
	},
};

/** What the user has yet to answer about a map: its session ended without them leaving it, or
 *  joining it through `via` replaces edits to their copy. */
type Notice = { ask: "ended" } | { ask: "replace"; via: Via };

/** A map this app collaborates on: its session, where it was copied from, and what the user has
 *  yet to answer about it. */
type Entry = { map: string; session: Session | null; origin: Origin | null; notice: Notice | null };

/** What this app knows about the maps it collaborates on, at one moment. */
class Known {
	readonly entries: ReadonlyMap<string, Entry>;
	constructor(entries: ReadonlyMap<string, Entry> = new Map()) {
		this.entries = entries;
	}
	/** The session on map `map`, if this app is in one. */
	on(map: string | null): Session | undefined {
		return (map !== null && this.entries.get(map)?.session) || undefined;
	}
	/** Where map `map` was copied from, when it is a collab copy. */
	origin(map: string | null): Origin | undefined {
		return (map !== null && this.entries.get(map)?.origin) || undefined;
	}
	/** The first map with something the user has yet to answer. */
	asking(): (Entry & { notice: Notice }) | undefined {
		for (const entry of this.entries.values())
			if (entry.notice) return entry as Entry & { notice: Notice };
	}
	/** The same knowledge with map `map`'s notice set to `notice`. */
	noting(map: string, notice: Notice | null): Known {
		const entry = this.entries.get(map) ?? { map, session: null, origin: null, notice: null };
		return new Known(new Map(this.entries).set(map, { ...entry, notice }));
	}
}

let known = new Known();
const publish = (next: Known) => {
	known = next;
	emitPluginEvent(SESSIONS);
};

async function showsHere(map: string): Promise<boolean> {
	if (appWindow.type === "editor") return appWindow.mapId === map;
	return !(await openWindows("editor")).some((w) => w.mapId === map);
}

function hear({ sessions, copies }: CollabSessions) {
	const entries = new Map<string, Entry>();
	const kept = (map: string, session: Session | null) => {
		const notice = known.entries.get(map)?.notice ?? null;
		return notice?.ask === "ended" && !session?.ended ? null : notice;
	};
	for (const { map, origin } of copies)
		entries.set(map, { map, session: null, origin, notice: kept(map, null) });
	for (const raw of sessions) {
		const origin = entries.get(raw.map)?.origin ?? null;
		const session = Session.of(raw);
		const before = known.on(raw.map);
		entries.set(raw.map, { map: raw.map, session, origin, notice: kept(raw.map, session) });
		if (before && !before.ended && session.ended)
			void showsHere(raw.map).then((here) => {
				if (here && known.on(raw.map)?.ended) publish(known.noting(raw.map, { ask: "ended" }));
			});
		if (before?.live && session.link.state === "reconnecting" && !session.hosting)
			void showsHere(raw.map).then(
				(here) =>
					here &&
					toast(
						t("Lost the connection to {host}'s map. Edits are paused until it is back.", {
							host: session.host,
						}),
						6000,
					),
			);
	}
	publish(new Known(entries));
}

async function joining(via: Via, replace: boolean): Promise<void> {
	const outcome = await cmd.collabJoin(via, replace);
	if (outcome.outcome === "edited") {
		publish(known.noting(outcome.map, { ask: "replace", via }));
		return;
	}
	publish(known.noting(outcome.map, null));
	await Maps.reload();
	const name = Maps.list().find((m) => m.id === outcome.map)?.name || t("(unnamed)");
	await openWindow({ type: "editor", mapId: outcome.map }, name);
}

export const Sessions = {
	/** Raised whenever this app's collab sessions change. */
	changed: SESSIONS,
	/** What this app knows about its collab maps now. */
	get: (): Known => known,
	/** React hook: what this app knows about its collab maps, as it changes. */
	use: (): Known => useEventValue(SESSIONS, () => known),
	/** Follow this app's collab sessions: hold the open map loading while it arrives, and tell the
	 *  user when a connection drops or a session ends without them leaving it. */
	follow: (): (() => void) => {
		const initial = latest<CollabSessions>({
			publish: hear,
			failed: (e) => log.warn(`[collab] sessions check failed: ${errText(e)}`),
		});
		const unlisten = events.collabSessions.listen((e) => {
			initial.cancel();
			hear(e.payload);
		});
		void initial.replace(() => cmd.collabSessions());
		let release: (() => void) | null = null;
		const unfollow = subscribeMany([SESSIONS, "snapshot:changed"], () => {
			const s = known.on(Store.get().mapId);
			const arriving =
				!!s && !s.hosting && (s.link.state === "connecting" || s.link.state === "syncing");
			if (arriving && !release) release = Scene.loading.hold();
			if (!arriving && release) {
				release();
				release = null;
			}
		});
		return () => {
			initial.cancel();
			void unlisten.then((stop) => stop());
			unfollow();
			release?.();
			publish(new Known());
		};
	},
	/** Stop asking the user about map `map`. */
	settle: (map: string): void => publish(known.noting(map, null)),
	/** Join a host's map through `via` and open it, first asking the user when that would replace
	 *  edits to their copy. */
	join: (via: Via): Promise<void> => joining(via, false),
	/** Join the map the user was asked about, replacing the edits to their copy of map `map`. */
	replace: async (map: string): Promise<void> => {
		const notice = known.entries.get(map)?.notice;
		if (notice?.ask === "replace") await joining(notice.via, true);
	},
	/** Leave the session on map `map`: a host ends it for everyone, an ended one is dismissed. */
	leave: async (map: string): Promise<void> => {
		Sessions.settle(map);
		await cmd.collabLeave(map);
	},
};

Maps.registerBadges({
	id: "collab",
	label: msg("Collab sessions"),
	events: [SESSIONS, "plugins:changed"],
	*collect() {
		if (!isPluginEnabled("collab")) return;
		for (const { map, session, origin } of known.entries.values()) {
			if (session && !session.ended)
				yield [
					map,
					{
						key: "collab",
						icon: mdiAccountGroup,
						title: session.hosting
							? t("You are hosting this map")
							: t("Following {host}'s map", { host: session.host }),
					},
				];
			else if (origin)
				yield [
					map,
					{
						key: "collab",
						icon: mdiAccountGroupOutline,
						title: t("Copy of {host}'s map", { host: origin.host }),
					},
				];
		}
	},
});
