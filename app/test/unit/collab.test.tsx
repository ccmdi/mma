// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type {
	CollabCopy,
	CollabPresence,
	CollabSession,
	CollabSessions,
	MapMeta,
	Shares,
} from "@/bindings.gen";
import type { Spot } from "@/plugins/collab/presence";
import { cmd } from "@/lib/commands";
import { initLocale } from "@/lib/i18n";
import { appWindow, openWindow } from "@/lib/window";
import { toast } from "@/lib/util/toast";
import { Scene } from "@/lib/render/scene";
import { useDialog } from "@/store/dialogBus";
import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { MapHost } from "@/lib/map/host";
import type { Bounds } from "@/types";
import { registerPlugin, setPluginEnabled } from "@/plugins/registry";
import { PluginSlot } from "@/plugins/PluginPanels";
import { setLocal } from "@/lib/hooks/useLocalStorage";
import { mountAsync, typeInto } from "./fixtures/harness";

const me = { login: "me", avatarUrl: "" };
const emptyShares: Shares = { mine: [], withMe: [] };
let heard: ((e: { payload: CollabSessions }) => void) | null = null;
let heardSessions: CollabSession[] = [];
let copies: CollabCopy[] = [];
const origins = new Map<string, CollabCopy["origin"]>();
let heardPresence: ((e: { payload: CollabPresence }) => void) | null = null;
const release = vi.fn();

type Handler = (arg: unknown) => void;
const hostOf = (bounds: Bounds) => {
	const handlers = new Map<string, Set<Handler>>();
	const fire = (event: string, arg?: unknown) => {
		for (const fn of handlers.get(event) ?? []) fn(arg);
	};
	const overlay = { setProps: vi.fn(), finalize: vi.fn() };
	return {
		fire,
		overlay,
		on: vi.fn((event: string, fn: Handler) => {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)!.add(fn);
			return () => handlers.get(event)!.delete(fn);
		}),
		getBounds: vi.fn(() => bounds),
		getZoom: vi.fn(() => 10),
		createDeckOverlay: vi.fn(() => overlay),
	};
};
const fakeHost = hostOf({ west: 1, south: 2, east: 3, north: 4 });
const { fire: mapEvent, overlay } = fakeHost;

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn() }));
vi.mock("@/lib/window", () => ({
	openWindow: vi.fn(async () => {}),
	openWindows: vi.fn(async () => []),
	appWindow: { type: "list" },
	hasWindowHost: false,
}));
vi.mock("@/lib/util/toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/render/scene", () => ({ Scene: { loading: { hold: vi.fn(() => release) } } }));
vi.mock("@deck.gl/layers", () => {
	class Layer {
		props: Record<string, unknown>;
		constructor(props: Record<string, unknown>) {
			this.props = props;
		}
	}
	return { IconLayer: Layer, PathLayer: Layer, ScatterplotLayer: Layer, TextLayer: Layer };
});
vi.mock("@/bindings.gen", async (original) => ({
	...(await original<object>()),
	events: {
		collabSessions: {
			listen: vi.fn(async (fn: typeof heard) => {
				heard = fn;
				return () => (heard = null);
			}),
		},
		collabPresence: {
			listen: vi.fn(async (fn: typeof heardPresence) => {
				heardPresence = fn;
				return () => (heardPresence = null);
			}),
		},
	},
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		githubMe: vi.fn(async () => me),
		githubLogout: vi.fn(async () => null),
		storeListMaps: vi.fn(async () => []),
		storeDuplicateMap: vi.fn(async (_id: string, name: string) => ({ id: "kept", name })),
		collabShares: vi.fn(async () => emptyShares),
		collabSessions: vi.fn(async () => ({ sessions: [], copies })),
		collabJoin: vi.fn(),
		collabLeave: vi.fn(async () => null),
		collabShare: vi.fn(async () => null),
		collabHost: vi.fn(async () => null),
		collabInvite: vi.fn(async () => null),
		collabPresent: vi.fn(async () => null),
	},
}));

MapHost.set(fakeHost as unknown as MapHost);

const { CollabBadge, CollabDialog } = await import("@/plugins/collab/CollabDialog");
const { CollabHeader } = await import("@/plugins/collab/CollabHeader");
const { Presence } = await import("@/plugins/collab/presence");
const { toPeople } = await import("@/plugins/collab/people");
const { Sessions } = await import("@/plugins/collab/sessions");
(window as unknown as { MMA: unknown }).MMA = { registerPlugin };
await import("@/plugins/collab");

const ann = { host: "ann", map: "a1", login: "me" };
const mapRow = (
	id: string,
	name: string,
	origin?: { host: string; map: string; login?: string; invite?: string },
) => {
	if (origin) {
		const { invite, ...at } = origin;
		const via = invite ? { code: invite } : { host: at.host, map: at.map };
		origins.set(id, { login: "me", parted: null, via, ...at });
	} else origins.delete(id);
	return { id, name, settings: {} } as MapMeta;
};

const members = (...logins: string[]) =>
	logins.map((login) => ({ login, guest: login.startsWith("guest--") }));
const session = (over: Partial<CollabSession>): CollabSession => ({
	map: "m1",
	host: "me",
	you: "me",
	hosting: true,
	roster: [],
	link: { state: "live" },
	...over,
});
const following = (state: CollabSession["link"], over: Partial<CollabSession> = {}) =>
	session({ map: "copy", host: "ann", hosting: false, link: state, ...over });

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const button = (text: string) =>
	buttons().find((b) => b.textContent === text && b.getAttribute("role") !== "tab");
const tab = (text: string) =>
	document.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${text}"]`) ??
	buttons().find((b) => b.textContent === text && b.getAttribute("role") === "tab");
const selectedTab = () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const sectionTitled = (title: string) =>
	[...document.querySelectorAll("section")].find(
		(s) => s.querySelector(".eyebrow")?.textContent === title,
	);
const labelled = (label: string) =>
	document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (el: HTMLElement | null | undefined) =>
	act(async () => {
		el!.click();
	});
const field = (placeholder: string) =>
	document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;

async function hear(sessions: CollabSession[]) {
	heardSessions = sessions;
	await act(async () => heard?.({ payload: { sessions, copies } }));
}

async function useMaps(rows: MapMeta[]) {
	copies = rows.flatMap((row) => {
		const origin = origins.get(row.id);
		return origin ? [{ map: row.id, origin }] : [];
	});
	vi.mocked(cmd.storeListMaps).mockResolvedValue(rows);
	await act(() => Maps.reload());
	await hear(heardSessions);
}

async function openDialog() {
	const mounted = await mountAsync(<CollabDialog onClose={() => {}} />);
	await act(async () => {});
	return mounted;
}

let stop: (() => void) | null = null;

beforeAll(async () => {
	await initLocale("en");
	setPluginEnabled("collab", true);
});

beforeEach(async () => {
	heardSessions = [];
	setLocal("collabTab", null);
	vi.mocked(cmd.collabShares).mockResolvedValue(emptyShares);
	await useMaps([]);
	Store.patch({ mapId: null });
	Object.assign(appWindow, { type: "list", mapId: undefined });
	stop = (await mountAsync(<PluginSlot slot="layer" />)).unmount;
});

afterEach(() => {
	stop?.();
	setLocal(Presence.shown, { cursors: true, viewports: true, pings: true });
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("collab badge", () => {
	it("shows the open map's session state on its button", async () => {
		Store.patch({ mapId: "copy" });
		const { container } = await mountAsync(<CollabBadge />);
		expect(container.querySelector(".collab__dot")).toBeNull();
		await hear([following({ state: "syncing" })]);
		expect(container.querySelector(".collab__dot--pending")).not.toBeNull();
		await hear([following({ state: "live" })]);
		expect(container.querySelector(".collab__dot")?.className).toBe("collab__dot");
	});

	it("shows on the map list only while a map shared with the user is live, checked every half minute", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const shared = { host: "ann", map: "a1", name: "Ann's map", live: false };
		vi.mocked(cmd.collabShares).mockResolvedValue({ mine: [], withMe: [shared] });
		const { container } = await mountAsync(<CollabBadge />);
		await act(async () => {});
		expect(container.querySelector(".collab__dot")).toBeNull();

		vi.mocked(cmd.collabShares).mockResolvedValue({
			mine: [],
			withMe: [shared, { ...shared, map: "a2", live: true }],
		});
		await act(() => vi.advanceTimersByTimeAsync(29_000));
		expect(container.querySelector(".collab__dot")).toBeNull();
		await act(() => vi.advanceTimersByTimeAsync(1_000));
		expect(container.querySelector(".collab__dot")).not.toBeNull();
	});

	it("checks shares once for the badge and the dialog open beside it", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		await mountAsync(<CollabBadge />);
		await openDialog();
		expect(cmd.collabShares).toHaveBeenCalledOnce();
		await act(() => vi.advanceTimersByTimeAsync(30_000));
		expect(cmd.collabShares).toHaveBeenCalledTimes(2);
	});
});

describe("collab rejoin", () => {
	const shared = { host: "ann", map: "a1", name: "Ann's map", live: true };

	beforeEach(async () => {
		await useMaps([mapRow("copy", "Ann's map", shared)]);
		vi.mocked(cmd.collabShares).mockResolvedValue({ mine: [], withMe: [shared] });
		vi.mocked(cmd.collabJoin).mockImplementation(async (_via, replace) =>
			replace ? { outcome: "following", map: "copy" } : { outcome: "edited", map: "copy" },
		);
		await openDialog();
		await click(button("Join"));
		expect(cmd.collabJoin).toHaveBeenCalledWith({ host: "ann", map: "a1" }, false);
		expect(document.body.textContent).toContain("Your copy has changes");
	});

	it("keeps a copy of the edited map, then joins replacing it", async () => {
		await click(button("Keep a copy and join"));
		expect(cmd.storeDuplicateMap).toHaveBeenCalledWith("copy", "Ann's map (copy)");
		expect(cmd.collabJoin).toHaveBeenLastCalledWith({ host: "ann", map: "a1" }, true);
		expect(vi.mocked(cmd.storeDuplicateMap).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(cmd.collabJoin).mock.invocationCallOrder[1],
		);
		expect(openWindow).toHaveBeenCalledWith({ type: "editor", mapId: "copy" }, "Ann's map");
	});

	it("replaces the edits without a copy", async () => {
		await click(button("Replace my edits"));
		expect(cmd.storeDuplicateMap).not.toHaveBeenCalled();
		expect(cmd.collabJoin).toHaveBeenLastCalledWith({ host: "ann", map: "a1" }, true);
		expect(openWindow).toHaveBeenCalledWith({ type: "editor", mapId: "copy" }, "Ann's map");
	});

	it("does nothing when cancelled", async () => {
		await click(button("Cancel"));
		expect(cmd.storeDuplicateMap).not.toHaveBeenCalled();
		expect(cmd.collabJoin).toHaveBeenCalledOnce();
		expect(openWindow).not.toHaveBeenCalled();
	});
});

describe("collab join with code", () => {
	beforeEach(async () => {
		await useMaps([mapRow("copy", "Ann's map", ann)]);
		await openDialog();
		typeInto(field("Invite code"), " ABC123 ");
	});

	it("joins as a guest and opens the map", async () => {
		vi.mocked(cmd.collabJoin).mockResolvedValue({ outcome: "following", map: "copy" });
		await click(button("Join with code"));
		expect(cmd.collabJoin).toHaveBeenCalledWith({ code: "ABC123" }, false);
		expect(openWindow).toHaveBeenCalledWith({ type: "editor", mapId: "copy" }, "Ann's map");
	});

	it("keeps the code when joining fails, and clears it once joined", async () => {
		vi.mocked(cmd.collabJoin).mockRejectedValueOnce(new Error("no such invite"));
		await click(button("Join with code"));
		expect(document.body.textContent).toContain("no such invite");
		expect(field("Invite code").value).toBe(" ABC123 ");

		vi.mocked(cmd.collabJoin).mockResolvedValue({ outcome: "following", map: "copy" });
		await click(button("Join with code"));
		expect(field("Invite code").value).toBe("");
	});

	it("asks before replacing an edited copy, then joins replacing it", async () => {
		vi.mocked(cmd.collabJoin).mockImplementation(async (_via, replace) =>
			replace ? { outcome: "following", map: "copy" } : { outcome: "edited", map: "copy" },
		);
		await click(button("Join with code"));
		expect(openWindow).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Your copy has changes");
		await click(button("Replace my edits"));
		expect(cmd.collabJoin).toHaveBeenLastCalledWith({ code: "ABC123" }, true);
		expect(openWindow).toHaveBeenCalledWith({ type: "editor", mapId: "copy" }, "Ann's map");
	});
});

describe("collab sessions", () => {
	it("are followed while collab is enabled, and let go when it is disabled", async () => {
		Store.patch({ mapId: "copy" });
		await hear([following({ state: "syncing" })]);
		expect(Scene.loading.hold).toHaveBeenCalledOnce();

		await act(async () => setPluginEnabled("collab", false));
		expect(heard).toBeNull();
		expect(release).toHaveBeenCalledOnce();

		await act(async () => setPluginEnabled("collab", true));
		expect(heard).not.toBeNull();
	});
});

describe("collab loading hold", () => {
	it("holds the open map loading while it arrives from the host", async () => {
		Store.patch({ mapId: "copy" });
		await hear([following({ state: "waiting" })]);
		expect(Scene.loading.hold).not.toHaveBeenCalled();

		await hear([following({ state: "connecting" })]);
		await hear([following({ state: "syncing" })]);
		expect(Scene.loading.hold).toHaveBeenCalledOnce();
		expect(release).not.toHaveBeenCalled();

		await hear([following({ state: "live" })]);
		expect(release).toHaveBeenCalledOnce();

		await hear([following({ state: "syncing" })]);
		expect(Scene.loading.hold).toHaveBeenCalledTimes(2);
		await hear([]);
		expect(release).toHaveBeenCalledTimes(2);
	});

	it("does not hold a hosted map or a map that is not open", async () => {
		Store.patch({ mapId: "m1" });
		await hear([session({ link: { state: "connecting" } }), following({ state: "syncing" })]);
		expect(Scene.loading.hold).not.toHaveBeenCalled();
	});

	it("lets go when the map closes", async () => {
		Store.patch({ mapId: "copy" });
		await hear([following({ state: "syncing" })]);
		act(() => Store.patch({ mapId: null }));
		expect(release).toHaveBeenCalledOnce();
	});
});

describe("collab connection notices", () => {
	beforeEach(async () => {
		await useMaps([mapRow("copy", "Ann's map", ann)]);
	});

	const ended = (reason: string) => following({ state: "ended", reason });

	it("shows an unchosen ending as a dialog, not a toast", async () => {
		await hear([following({ state: "live" })]);
		await hear([ended("the host stopped sharing the map with you")]);
		expect(document.body.textContent).toContain("Disconnected from ann's map");
		expect(document.body.textContent).toContain("the host stopped sharing the map with you");
		expect(toast).not.toHaveBeenCalled();
	});

	it("rejoins the host's map", async () => {
		vi.mocked(cmd.collabJoin).mockResolvedValue({ outcome: "following", map: "copy" });
		await hear([following({ state: "live" })]);
		await hear([ended("lost")]);
		await click(button("Rejoin"));
		expect(cmd.collabJoin).toHaveBeenCalledWith({ host: "ann", map: "a1" }, false);
		await hear([following({ state: "connecting" })]);
		expect(button("Rejoin")).toBeUndefined();
	});

	it("keeps the copy by leaving the session", async () => {
		await hear([following({ state: "live" })]);
		await hear([ended("lost")]);
		await click(button("Keep my copy"));
		expect(cmd.collabLeave).toHaveBeenCalledWith("copy");
		await hear([]);
		expect(document.body.textContent).not.toContain("Disconnected");
	});

	it("rejoins a guest with the invite code it joined with", async () => {
		await useMaps([
			mapRow("copy", "Ann's map", { ...ann, login: "guest--abc123", invite: "k7m2p9qa" }),
		]);
		vi.mocked(cmd.collabJoin).mockResolvedValue({ outcome: "following", map: "copy" });
		await hear([following({ state: "live" })]);
		await hear([ended("lost")]);
		await click(button("Rejoin"));
		expect(cmd.collabJoin).toHaveBeenCalledWith({ code: "k7m2p9qa" }, false);
	});

	it("stays quiet when the user leaves or stops hosting", async () => {
		await hear([session({})]);
		vi.mocked(cmd.collabLeave).mockImplementationOnce(async () => {
			await hear([]);
			return null;
		});
		await act(() => Sessions.leave("m1"));
		expect(document.body.textContent).not.toContain("Hosting stopped");

		await hear([session({})]);
		await hear([session({ link: { state: "ended", reason: "lost" } })]);
		expect(document.body.textContent).toContain("Hosting stopped");
		expect(button("Host again")).toBeDefined();
	});

	it("shows only in the window for that map", async () => {
		Object.assign(appWindow, { type: "editor", mapId: "other" });
		await hear([following({ state: "live" })]);
		await hear([ended("lost")]);
		expect(document.body.textContent).not.toContain("Disconnected");
	});

	it("tells a joiner once per drop that edits are paused", async () => {
		await hear([following({ state: "live" })]);
		await hear([following({ state: "reconnecting" })]);
		await hear([following({ state: "connecting" })]);
		await hear([following({ state: "reconnecting" })]);
		expect(toast).toHaveBeenCalledOnce();
		expect(vi.mocked(toast).mock.calls[0][0]).toContain("paused");

		await hear([following({ state: "live" })]);
		expect(toast).toHaveBeenCalledOnce();
		await hear([following({ state: "reconnecting" })]);
		expect(toast).toHaveBeenCalledTimes(2);

		await hear([session({})]);
		await hear([session({ link: { state: "reconnecting" } })]);
		expect(toast).toHaveBeenCalledTimes(2);
	});
});

describe("collab people", () => {
	const PALETTE_SIZE = 8;
	const logins = Array.from({ length: 200 }, (_, i) => `user${i}`);
	const key = (login: string, roster = [login]) =>
		toPeople(members(...roster))
			.find((p) => p.login === login)!
			.color.join();
	const collide = () => {
		for (const a of logins) {
			const b = logins.find((l) => l !== a && key(l) === key(a));
			if (b) return [a, b];
		}
		throw new Error("no colliding logins");
	};

	it("gives colliding logins in one session different colors", () => {
		const [a, b] = collide();
		expect(key(a)).toBe(key(b));
		expect(key(a, [a, b])).not.toBe(key(b, [a, b]));
		expect(key(a, [a, b])).toBe(key(a));
	});

	it("colors a roster the same whatever order it is asked in", () => {
		const roster = logins.slice(0, 6);
		const forward = roster.map((l) => key(l, roster));
		const backward = roster.toReversed().map((l) => key(l, roster));
		expect(backward.toReversed()).toEqual(forward);
		expect(new Set(forward).size).toBe(roster.length);
	});

	it("keeps everyone's color when someone joins later, repeating only past the palette", () => {
		const [a, b] = collide();
		const before = [a, b].map((l) => key(l, [a, b]));
		const joined = [a, b, logins.find((l) => l !== a && l !== b && key(l) === key(a))!];
		expect([a, b].map((l) => key(l, joined))).toEqual(before);
		expect(new Set(joined.map((l) => key(l, joined))).size).toBe(3);

		const crowd = logins.slice(0, PALETTE_SIZE);
		expect(new Set(crowd.map((l) => key(l, crowd))).size).toBe(PALETTE_SIZE);
	});

	it("rings the people in a session's chips in their session colors", async () => {
		const [a, b] = collide();
		Store.patch({ mapId: "m1" });
		await hear([session({ host: a, roster: members(a, b) })]);
		await openDialog();
		const rings = [...document.querySelectorAll<HTMLElement>(".collab__chip .avatar")].map((el) =>
			el.style.getPropertyValue("--avatar-ring"),
		);
		expect(rings).toHaveLength(2);
		expect(rings[0]).not.toBe(rings[1]);
	});

	it("shows a guest by their code and a plain avatar", async () => {
		expect(toPeople(members("guest--a1b2c3", "ann")).map((p) => p.name)).toEqual([
			"Guest a1b2c3",
			"ann",
		]);

		Store.patch({ mapId: "m1" });
		await hear([session({ roster: members("me", "guest--a1b2c3") })]);
		await openDialog();
		const chips = [...document.querySelectorAll(".collab__chip")];
		const guest = chips.find((c) => c.textContent?.includes("Guest a1b2c3"))!;
		expect(guest.querySelector("img")).toBeNull();
		expect(guest.querySelector(".avatar svg")).not.toBeNull();
		const host = chips.find((c) => c.textContent?.startsWith("me"))!;
		expect(host.querySelector("img")?.getAttribute("src")).toContain("github");
	});

	it("marks the signed-in user as you", async () => {
		Store.patch({ mapId: "m1" });
		await hear([session({ roster: members("me", "bob") })]);
		await openDialog();
		const chips = [...document.querySelectorAll(".collab__chip")];
		expect(chips.map((c) => c.textContent)).toEqual(["meYou", "bob"]);
		expect(chips.map((c) => !!c.querySelector('[aria-label="Host"]'))).toEqual([true, false]);
	});

	it("marks a guest's own login as you", async () => {
		await useMaps([mapRow("copy", "Ann's map", { ...ann, login: "guest--abc123" })]);
		Store.patch({ mapId: "copy" });
		await hear([
			following(
				{ state: "live" },
				{ you: "guest--abc123", roster: members("ann", "guest--abc123") },
			),
		]);
		await openDialog();
		const mine = [...document.querySelectorAll(".collab__chip")].find((c) =>
			c.textContent?.includes("You"),
		);
		expect(mine?.textContent).toContain("Guest abc123");
	});
});

describe("collab shares", () => {
	it("shows the people a map is shared with and who is here as one set", async () => {
		await useMaps([mapRow("m1", "Mine")]);
		vi.mocked(cmd.collabShares).mockResolvedValue({
			mine: [{ map: "m1", name: "Mine", logins: ["bob", "cat"] }],
			withMe: [],
		});
		await hear([session({ roster: members("me", "cat", "dan") })]);
		await openDialog();

		const chips = [...document.querySelectorAll(".collab__share .collab__chip")].map((chip) => [
			chip.textContent,
			chip.classList.contains("collab__chip--here"),
		]);
		expect(chips).toEqual([
			["bob", false],
			["cat", true],
			["dan", true],
		]);

		await click(labelled("Remove cat"));
		expect(cmd.collabShare).toHaveBeenCalledWith("m1", ["bob"]);
	});

	it("offers removing only the people a map is shared with, not its guests", async () => {
		await useMaps([mapRow("m1", "Mine")]);
		vi.mocked(cmd.collabShares).mockResolvedValue({
			mine: [{ map: "m1", name: "Mine", logins: [], invite: "XYZ789" }],
			withMe: [],
		});
		await hear([session({ roster: members("me", "guest--abc") })]);
		await openDialog();

		expect(document.querySelector(".collab__share .collab__chip")?.textContent).toBe("Guest abc");
		expect(labelled("Remove Guest abc")).toBeNull();
	});

	it("turns a guest invite on and off and copies its code", async () => {
		const writeText = vi.fn(async () => {});
		Object.assign(navigator, { clipboard: { writeText } });
		await useMaps([mapRow("m1", "Mine")]);
		const share = { map: "m1", name: "Mine", logins: ["bob"], invite: null as string | null };
		vi.mocked(cmd.collabShares).mockImplementation(async () => ({ mine: [share], withMe: [] }));
		await openDialog();

		share.invite = "XYZ789";
		await click(labelled("Turn on a guest invite"));
		expect(cmd.collabInvite).toHaveBeenCalledWith("m1", true);
		expect(document.querySelector(".collab__code")?.textContent).toBe("XYZ789");

		await click(labelled("Copy the invite code"));
		expect(writeText).toHaveBeenCalledWith("XYZ789");
		expect(toast).toHaveBeenCalledWith("Copied");

		share.invite = null;
		await click(labelled("Turn off the invite and remove its guests"));
		expect(cmd.collabInvite).toHaveBeenLastCalledWith("m1", false);
		expect(document.querySelector(".collab__code")).toBeNull();
	});

	it("finds a map to share by searching, leaving out collab copies", async () => {
		await useMaps([
			mapRow("m1", "Mine one"),
			mapRow("m2", "Mine two"),
			mapRow("copy", "Mine copy", ann),
		]);
		await openDialog();
		await click(tab("Share"));
		typeInto(field("Share a map..."), "mine");
		const found = [...document.querySelectorAll(".search-result")].map((r) => r.textContent);
		expect(found).toEqual(["Mine one", "Mine two"]);

		await click([...document.querySelectorAll<HTMLButtonElement>(".search-result")][1]);
		typeInto(field("GitHub username"), "bob");
		await click(button("Share"));
		expect(cmd.collabShare).toHaveBeenCalledWith("m2", ["bob"]);
	});

	it("counts unsharing a hosted map as the user's choice", async () => {
		await useMaps([mapRow("m1", "Mine")]);
		vi.mocked(cmd.collabShares).mockResolvedValue({
			mine: [{ map: "m1", name: "Mine", logins: ["bob"] }],
			withMe: [],
		});
		await hear([session({ roster: members("me") })]);
		vi.mocked(cmd.collabShare).mockImplementationOnce(async () => {
			await hear([]);
			return null;
		});
		await openDialog();
		await click(labelled("Remove bob"));
		expect(cmd.collabShare).toHaveBeenCalledWith("m1", []);
		expect(document.body.textContent).not.toContain("Hosting stopped");
	});

	it("badges collab copies with no session", async () => {
		await useMaps([mapRow("copy", "Ann's map", ann), mapRow("m1", "Mine")]);
		expect(
			Maps.badges()
				.get("copy")
				?.map((b) => b.title),
		).toEqual(["Copy of ann's map"]);
		expect(Maps.badges().get("m1")).toBeUndefined();
		await hear([following({ state: "live" })]);
		expect(
			Maps.badges()
				.get("copy")
				?.map((b) => b.title),
		).toEqual(["Following ann's map"]);
	});
});

describe("collab header", () => {
	const header = () => document.querySelector(".collab-status");

	beforeEach(async () => {
		await useMaps([
			mapRow("copy", "Ann's map", ann),
			mapRow("guest", "Ann's map", { ...ann, login: "guest--abc123" }),
			mapRow("m1", "Mine"),
		]);
	});

	it("shows the role and state of the open map's session", async () => {
		await mountAsync(<CollabHeader />);
		act(() => Store.patch({ mapId: "m1" }));
		expect(header()).toBeNull();

		await hear([session({ roster: members("me", "bob") })]);
		expect(header()?.textContent).toContain("Hosting · live");
		expect(header()?.querySelectorAll(".avatar")).toHaveLength(2);

		act(() => Store.patch({ mapId: "copy" }));
		await hear([following({ state: "syncing" })]);
		expect(header()?.textContent).toContain("Following ann · receiving");
		await hear([following({ state: "reconnecting" })]);
		expect(header()?.textContent).toContain("Following ann · reconnecting");

		act(() => Store.patch({ mapId: "guest" }));
		await hear([
			following(
				{ state: "live" },
				{ map: "guest", you: "guest--abc123", roster: members("ann", "guest--abc123") },
			),
		]);
		expect(header()?.textContent).toContain("Guest of ann · live");
	});

	it("shows where a copy came from once its session is over", async () => {
		await mountAsync(<CollabHeader />);
		act(() => Store.patch({ mapId: "copy" }));
		expect(header()?.textContent).toBe("Copy of ann's map");
		await hear([following({ state: "ended", reason: "lost" })]);
		expect(header()?.textContent).toBe("Copy of ann's map");
	});

	it("opens the collab dialog", async () => {
		const opened = vi.fn();
		function Probe() {
			useDialog("plugin-modal", opened);
			return <CollabHeader />;
		}
		await mountAsync(<Probe />);
		act(() => Store.patch({ mapId: "copy" }));
		await click(header() as HTMLElement);
		expect(opened).toHaveBeenCalledWith("collab");

		await hear([following({ state: "live" }, { roster: members("ann", "me") })]);
		await click(header()?.querySelector(".collab-status__open"));
		expect(opened).toHaveBeenCalledTimes(2);
	});
});

describe("collab presence", () => {
	let unmount: (() => void) | null = null;
	let frames: FrameRequestCallback[] = [];
	type Drawn = { person: { login: string } };
	type Props = {
		id: string;
		data: Drawn[];
		getPosition: (d: Drawn) => [number, number];
		getPath: (d: Drawn) => [number, number][];
		getAngle?: (d: Drawn) => number;
		getColor: (d: Drawn) => number[];
		getRadius: (d: Drawn) => number;
		filled: boolean;
	};
	const layer = (id: string) =>
		(overlay.setProps.mock.lastCall![0].layers as { props: Props }[]).find(
			(l) => l.props.id === id,
		)!.props;
	const layerData = (id: string) => layer(id).data.map((d) => d.person.login);
	const cursorAt = (login: string) => {
		const { data, getPosition } = layer("collab-cursors");
		const [lng, lat] = getPosition(data.find((d) => d.person.login === login)!);
		return { lat, lng };
	};
	const viewOf = (login: string) => {
		const { data, getPath } = layer("collab-viewports");
		const [[west, south], , [east, north]] = getPath(data.find((d) => d.person.login === login)!);
		return { west, south, east, north };
	};
	const tick = (ms = 0) => {
		vi.advanceTimersByTime(ms);
		const due = frames;
		frames = [];
		for (const fn of due) fn(performance.now());
	};
	const run = (ms: number, each?: () => void) => {
		for (let t = 0; t < ms; t += 16) {
			tick(Math.min(16, ms - t));
			each?.();
		}
	};
	const present = (people: { login: string; spot: Partial<Spot> }[], map = "copy") => {
		for (const { login, spot } of people)
			act(() => heardPresence?.({ payload: { map, login, data: spot } }));
		tick();
	};
	const pointAt = (lng: number) => ({ cursor: { lat: 0, lng }, viewport: null });

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
		vi.stubGlobal("cancelAnimationFrame", () => {});
		Store.patch({ mapId: "copy" });
		unmount = Presence.mount();
		await act(async () => {});
	});

	afterEach(() => {
		unmount?.();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const sent = () => vi.mocked(cmd.collabPresent).mock.lastCall![1] as Spot;
	const bounds = { west: 1, south: 2, east: 3, north: 4 };
	const presenceAt = (cursor: Spot["cursor"]) => ({
		cursor,
		viewport: bounds,
		ping: null,
	});

	const move = (lat: number, lng: number) => {
		mapEvent("mousemove", { lat, lng });
		tick();
	};

	it("sends nothing until the open map's session is live", async () => {
		move(1, 1);
		vi.advanceTimersByTime(500);
		expect(cmd.collabPresent).not.toHaveBeenCalled();

		await hear([following({ state: "live" })]);
		expect(cmd.collabPresent).toHaveBeenCalledWith("copy", presenceAt({ lat: 1, lng: 1 }));
	});

	it("pings where this user clicks the map, once the session is live", async () => {
		const clickAt = (lat: number, lng: number) => act(() => mapEvent("click", { lat, lng }));
		const sentPing = () =>
			(vi.mocked(cmd.collabPresent).mock.lastCall?.[1] as Spot | undefined)?.ping;
		clickAt(20, 10);
		vi.advanceTimersByTime(100);
		expect(sentPing()).toBeUndefined();

		await hear([following({ state: "live" })]);
		clickAt(21, 11);
		vi.advanceTimersByTime(40);
		expect(sentPing()).toEqual({ lat: 21, lng: 11 });

		move(1, 1);
		vi.advanceTimersByTime(40);
		expect(sentPing()).toBeNull();

		clickAt(5, 5);
		vi.advanceTimersByTime(40);
		expect(sentPing()).toEqual({ lat: 5, lng: 5 });
	});

	it("draws each point as it arrives when the user asks for less motion", async () => {
		unmount?.();
		await act(async () => {});
		const reduced = vi.spyOn(window, "matchMedia");
		reduced.mockReturnValue({ matches: true } as MediaQueryList);
		unmount = Presence.mount();
		reduced.mockRestore();
		await act(async () => {});
		await hear([following({ state: "live" })]);
		const near = { west: 0, south: 0, east: 10, north: 10 };
		const far = { west: 20, south: 20, east: 30, north: 30 };
		present([{ login: "ann", spot: { ...pointAt(0), viewport: near } }]);
		tick(40);
		present([{ login: "ann", spot: { ...pointAt(10), viewport: far } }]);
		expect(cursorAt("ann").lng).toBeCloseTo(10);
		expect(viewOf("ann")).toEqual(far);
		expect(frames).toHaveLength(0);

		present([{ login: "ann", spot: { ...pointAt(10), ping: { lat: 0, lng: 0 } } }]);
		const pings = layer("collab-pings");
		expect(pings.filled).toBe(true);
		const radius = pings.getRadius(pings.data[0]);
		run(300);
		expect(layer("collab-pings").getRadius(pings.data[0])).toBe(radius);
		run(320);
		expect(layerData("collab-pings")).toEqual([]);
	});

	describe("live", () => {
		beforeEach(async () => {
			await hear([following({ state: "live" })]);
		});

		it("sends the cursor at most 25 times a second, ending on the latest", async () => {
			vi.mocked(cmd.collabPresent).mockClear();
			vi.advanceTimersByTime(200);

			for (let i = 0; i < 20; i++) move(i, i);
			expect(cmd.collabPresent).toHaveBeenCalledOnce();
			vi.advanceTimersByTime(39);
			expect(cmd.collabPresent).toHaveBeenCalledOnce();
			vi.advanceTimersByTime(1);
			expect(cmd.collabPresent).toHaveBeenCalledTimes(2);
			expect(sent().cursor).toEqual({ lat: 19, lng: 19 });
			vi.advanceTimersByTime(1000);
			expect(cmd.collabPresent).toHaveBeenCalledTimes(2);

			mapEvent("mouseout");
			vi.advanceTimersByTime(40);
			expect(sent().cursor).toBeNull();
		});

		it("draws only the open map's people, and clears them when the session ends", async () => {
			const spot = {
				cursor: { lat: 5, lng: 6 },
				viewport: { west: 0, south: 0, east: 1, north: 1 },
			};
			present([{ login: "bob", spot }], "other");
			expect(fakeHost.createDeckOverlay).not.toHaveBeenCalled();

			present([
				{ login: "ann", spot },
				{ login: "guest--abc123", spot: { cursor: null, viewport: spot.viewport } },
			]);
			expect(fakeHost.createDeckOverlay).toHaveBeenCalledOnce();
			expect(layerData("collab-cursors")).toEqual(["ann"]);
			expect(layerData("collab-viewports")).toEqual(["ann", "guest--abc123"]);

			await hear([following({ state: "live" }, { roster: members("ann") })]);
			tick();
			expect(layerData("collab-viewports")).toEqual(["ann"]);

			await hear([following({ state: "ended", reason: "lost" })]);
			tick();
			expect(overlay.finalize).toHaveBeenCalledOnce();
		});

		it("draws only the marks this user shows, sending the same either way", async () => {
			const spot = {
				cursor: { lat: 5, lng: 6 },
				viewport: { west: 0, south: 0, east: 1, north: 1 },
			};
			present([{ login: "ann", spot }]);

			act(() => setLocal(Presence.shown, { cursors: false, viewports: true, pings: true }));
			tick();
			expect(layerData("collab-cursors")).toEqual([]);
			expect(layerData("collab-viewports")).toEqual(["ann"]);
			move(5, 6);
			expect(layerData("collab-names")).toEqual([]);

			act(() => setLocal(Presence.shown, { cursors: true, viewports: false, pings: true }));
			tick();
			expect(layerData("collab-cursors")).toEqual(["ann"]);
			expect(layerData("collab-viewports")).toEqual([]);

			vi.advanceTimersByTime(200);
			expect(sent()).toEqual(presenceAt({ lat: 5, lng: 6 }));
		});

		it("names a person only while the mouse is near their pin", async () => {
			present([{ login: "ann", spot: { cursor: { lat: 5, lng: 6 }, viewport: null } }]);
			expect(layerData("collab-cursors")).toEqual(["ann"]);
			expect(layerData("collab-names")).toEqual([]);

			move(5.0001, 6.0001);
			expect(layerData("collab-names")).toEqual(["ann"]);
			move(5, 6.1);
			expect(layerData("collab-names")).toEqual([]);
			move(5, 6);
			mapEvent("mouseout");
			tick();
			expect(layerData("collab-names")).toEqual([]);
		});

		it("draws a cursor a tenth of a second behind on a spring that overshoots a fast move a little, and eases off a held point", async () => {
			present([{ login: "ann", spot: pointAt(0) }]);
			tick(600);
			present([{ login: "bob", spot: pointAt(0) }]);
			tick(40);
			present([
				{ login: "ann", spot: pointAt(10) },
				{ login: "bob", spot: pointAt(10) },
			]);
			run(60);
			expect(cursorAt("ann").lng).toBeCloseTo(0);
			expect(cursorAt("bob").lng).toBeCloseTo(0);
			run(20);
			expect(cursorAt("bob").lng).toBeGreaterThan(0);
			const lngs: number[] = [];
			run(1500, () => lngs.push(cursorAt("bob").lng));
			expect(Math.max(...lngs)).toBeGreaterThan(10);
			expect(Math.max(...lngs)).toBeLessThan(10.5);
			expect(cursorAt("ann").lng).toBeCloseTo(10);
			expect(cursorAt("bob").lng).toBeCloseTo(10);
			expect(layer("collab-cursors").getAngle).toBeUndefined();
			expect(frames).toHaveLength(0);
		});

		it("snaps a cursor straight to its first point and after a long silence", async () => {
			present([{ login: "ann", spot: pointAt(20) }]);
			expect(cursorAt("ann").lng).toBeCloseTo(20);
			tick(2000);
			present([{ login: "ann", spot: pointAt(-30) }]);
			expect(cursorAt("ann").lng).toBeCloseTo(-30);
		});

		it("glides a viewport to its new bounds over a fifth of a second", async () => {
			const near = { west: 0, south: 0, east: 10, north: 10 };
			const far = { west: 20, south: 20, east: 30, north: 30 };
			present([{ login: "ann", spot: { cursor: null, viewport: near } }]);
			expect(viewOf("ann")).toEqual(near);

			present([{ login: "ann", spot: { cursor: null, viewport: far } }]);
			expect(viewOf("ann")).toEqual(near);
			tick(100);
			const midway = viewOf("ann").west;
			expect(midway).toBeGreaterThan(10);
			expect(midway).toBeLessThan(20);
			present([{ login: "ann", spot: { cursor: null, viewport: far } }]);
			tick(100);
			expect(viewOf("ann")).toEqual(far);
			tick(16);
			expect(frames).toHaveLength(0);
		});

		it("glides a viewport across the antimeridian the short way", async () => {
			const west = { west: 170, south: 0, east: 178, north: 10 };
			const across = { west: 176, south: 0, east: -176, north: 10 };
			present([{ login: "ann", spot: { cursor: null, viewport: west } }]);
			present([{ login: "ann", spot: { cursor: null, viewport: across } }]);
			run(200);
			expect(viewOf("ann")).toEqual({ west: 176, south: 0, east: 184, north: 10 });
		});

		it("crosses the antimeridian the short way", async () => {
			present([{ login: "ann", spot: pointAt(178) }]);
			tick(40);
			present([{ login: "ann", spot: pointAt(-178) }]);
			let nearest = 180;
			run(600, () => (nearest = Math.min(nearest, Math.abs(cursorAt("ann").lng))));
			expect(nearest).toBeGreaterThan(177.9);
			expect(cursorAt("ann").lng).toBeCloseTo(-178);
		});

		it("fades a cursor that has sat still for ten seconds, and brings it back on its next move", async () => {
			const alpha = () => {
				const { data, getColor } = layer("collab-cursors");
				return getColor(data[0])[3];
			};
			present([{ login: "ann", spot: pointAt(0) }]);
			expect(alpha()).toBe(255);
			run(5000);
			present([{ login: "ann", spot: pointAt(0) }]);
			run(4900);
			expect(alpha()).toBe(255);
			run(2132);
			expect(alpha()).toBeLessThan(255);
			expect(frames).toHaveLength(0);

			present([{ login: "ann", spot: pointAt(1) }]);
			run(2000);
			expect(alpha()).toBe(255);
		});

		it("moves everything it sends and draws to the map that replaces this one", async () => {
			const theirs = { west: 0, south: 0, east: 10, north: 10 };
			const vectorBounds = { west: 5, south: 6, east: 7, north: 8 };
			const vector = hostOf(vectorBounds);
			present([{ login: "ann", spot: { cursor: { lat: 1, lng: 1 }, viewport: theirs } }]);
			expect(fakeHost.createDeckOverlay).toHaveBeenCalledOnce();

			act(() => {
				MapHost.set(null);
				MapHost.set(vector as unknown as MapHost);
			});
			try {
				expect(overlay.finalize).toHaveBeenCalledOnce();
				vi.advanceTimersByTime(40);
				expect(sent().viewport).toEqual(vectorBounds);

				mapEvent("mousemove", { lat: 2, lng: 2 });
				vector.fire("mousemove", { lat: 3, lng: 3 });
				vi.advanceTimersByTime(40);
				expect(sent().cursor).toEqual({ lat: 3, lng: 3 });

				present([{ login: "ann", spot: { cursor: { lat: 1, lng: 2 }, viewport: theirs } }]);
				expect(vector.createDeckOverlay).toHaveBeenCalledOnce();
				expect(vector.overlay.setProps).toHaveBeenCalled();
			} finally {
				MapHost.set(fakeHost as unknown as MapHost);
			}
		});

		it("ripples once where someone else pings", async () => {
			present([{ login: "ann", spot: pointAt(0) }]);
			expect(layerData("collab-pings")).toEqual([]);

			present([{ login: "ann", spot: { ...pointAt(0), ping: { lat: 1, lng: 2 } } }]);
			expect(layerData("collab-pings")).toEqual(["ann"]);
			const { data, getRadius } = layer("collab-pings");
			const start = getRadius(data[0]);
			run(300);
			expect(getRadius(data[0])).toBeGreaterThan(start);
			present([{ login: "ann", spot: pointAt(0) }]);
			run(320);
			expect(layerData("collab-pings")).toEqual([]);
			expect(frames).toHaveLength(0);
		});

		it("draws no ripples while this user hides clicks, keeping cursors", async () => {
			act(() => setLocal(Presence.shown, { cursors: true, viewports: true, pings: false }));
			present([{ login: "ann", spot: { ...pointAt(0), ping: { lat: 1, lng: 2 } } }]);
			expect(layerData("collab-pings")).toEqual([]);
			expect(layerData("collab-cursors")).toEqual(["ann"]);

			act(() => setLocal(Presence.shown, { cursors: true, viewports: true, pings: true }));
			tick();
			expect(layerData("collab-pings")).toEqual(["ann"]);
		});
	});
});

describe("collab session box", () => {
	const box = () => sectionTitled("This map")!;
	const actions = () =>
		[...box().querySelectorAll<HTMLButtonElement>("button:not([role=switch])")].map(
			(b) => b.textContent,
		);

	it("leaves the session's state to the header, and offers a host one way to stop", async () => {
		Store.patch({ mapId: "m1" });
		await hear([session({ roster: members("me", "bob") })]);
		await openDialog();
		expect(box().textContent).not.toMatch(/hosting|live/i);
		expect(actions()).toEqual(["Stop"]);
		await click(button("Stop"));
		expect(cmd.collabLeave).toHaveBeenCalledWith("m1");
	});

	it("crowns the host among a joiner's people, and offers leaving", async () => {
		await useMaps([mapRow("copy", "Ann's map", ann)]);
		Store.patch({ mapId: "copy" });
		await hear([following({ state: "live" }, { roster: members("ann", "me") })]);
		await openDialog();
		const crowned = box().querySelector('.collab__chip:has([aria-label="Host"])');
		expect(crowned?.textContent).toBe("ann");
		expect(actions()).toEqual(["Leave"]);
	});

	it("offers dismissing a session that is over", async () => {
		Store.patch({ mapId: "m1" });
		await hear([session({ link: { state: "ended", reason: "lost" } })]);
		await openDialog();
		expect(actions()).toEqual(["Dismiss"]);
	});
});

describe("collab presence switches", () => {
	it("hides everyone's cursors, viewports or clicks for this user only, remembered on this device", async () => {
		Store.patch({ mapId: "m1" });
		await hear([session({ roster: members("me", "bob") })]);
		await openDialog();
		const cursors = labelled("Show cursors")!;
		expect(cursors.getAttribute("aria-checked")).toBe("true");
		await click(cursors);
		expect(cursors.getAttribute("aria-checked")).toBe("false");
		expect(labelled("Show viewports")?.getAttribute("aria-checked")).toBe("true");
		const clicks = labelled("Show clicks")!;
		expect(clicks.getAttribute("aria-checked")).toBe("true");
		await click(clicks);
		expect(JSON.parse(localStorage.getItem("collabShown")!)).toEqual({
			cursors: false,
			viewports: true,
			pings: false,
		});
	});

	it("offers no switches once the session is over", async () => {
		Store.patch({ mapId: "m1" });
		await hear([session({ link: { state: "ended", reason: "lost" } })]);
		await openDialog();
		expect(labelled("Show cursors")).toBeNull();
	});
});

describe("collab dialog tabs", () => {
	it("opens on Join with nothing shared, and keeps both ways to join apart", async () => {
		const shared = { host: "ann", map: "a1", name: "Ann's map", live: false };
		vi.mocked(cmd.collabShares).mockResolvedValue({ mine: [], withMe: [shared] });
		await openDialog();
		expect(selectedTab()).toBe("Join");
		const byAccount = sectionTitled("Shared with your account")!;
		const byCode = sectionTitled("Join with an invite code")!;
		expect(byAccount.textContent).toContain("Ann's map");
		expect(byAccount.querySelector("input")).toBeNull();
		expect(byCode.querySelector('input[placeholder="Invite code"]')).not.toBeNull();
		expect(document.body.textContent).not.toContain("My shares");
	});

	it("opens on Share when the user shares a map", async () => {
		await useMaps([mapRow("m1", "Mine")]);
		vi.mocked(cmd.collabShares).mockResolvedValue({
			mine: [{ map: "m1", name: "Mine", logins: ["bob"] }],
			withMe: [],
		});
		await openDialog();
		expect(selectedTab()).toBe("Share");
		expect(sectionTitled("My shares")).toBeDefined();
		expect(sectionTitled("Shared with your account")).toBeUndefined();
	});

	it("opens on Share while hosting the open map, with its session above the tabs", async () => {
		Store.patch({ mapId: "m1" });
		await hear([session({ roster: members("me") })]);
		await openDialog();
		expect(selectedTab()).toBe("Share");
		const box = sectionTitled("This map")!;
		const tabs = document.querySelector('[role="tablist"]')!;
		expect(box.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("remembers the chosen tab", async () => {
		const first = await openDialog();
		expect(selectedTab()).toBe("Join");
		await click(tab("Share"));
		first.unmount();
		await openDialog();
		expect(selectedTab()).toBe("Share");
	});
});

describe("collab signed out", () => {
	beforeEach(async () => {
		const { Account } = await import("@/lib/account");
		await act(() => Account.signOut());
	});

	it("offers joining with a code beside signing in", async () => {
		await openDialog();
		expect(sectionTitled("Shared with your account")?.textContent).toContain("Sign in with GitHub");
		expect(
			sectionTitled("Join with an invite code")?.querySelector('input[placeholder="Invite code"]'),
		).not.toBeNull();
		typeInto(field("Invite code"), "ABC123");
		vi.mocked(cmd.collabJoin).mockResolvedValue({ outcome: "following", map: "copy" });
		await click(button("Join with code"));
		expect(cmd.collabJoin).toHaveBeenCalledWith({ code: "ABC123" }, false);
	});

	it("shows only signing in on the Share tab", async () => {
		await openDialog();
		await click(tab("Share"));
		expect(button("Sign in with GitHub")).toBeDefined();
		expect(document.querySelector("input")).toBeNull();
		expect(sectionTitled("My shares")).toBeUndefined();
	});
});
