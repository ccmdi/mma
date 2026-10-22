import { bad, empty, json } from "../../shared/http";
import {
	type GuestClaim,
	TOKEN_TTL,
	type WorkerToken,
	guestLogin,
	mintToken,
	verifyToken,
} from "./auth";
import { Directory } from "./directory";
import { Room } from "./room";
import type { Invite, Pass, Share, Shared, Shares } from "./wire.gen";

export { Directory, Room };

export interface Env {
	WORKER_SECRET: string;
	SHARES: KVNamespace;
	ROOMS: DurableObjectNamespace<Room>;
	DIRECTORY: DurableObjectNamespace<Directory>;
	RATE: RateLimit;
	GITHUB_API?: string;
}

const MAX_LOGINS = 50;
const MAX_NAME = 200;
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/;
const MAP_ID = /^[\w.-]{1,64}$/;
const INVITE_TTL = 7 * 24 * 60 * 60;
const INVITE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const INVITE_CODE = /^[2-9a-hjkmnp-z]{8}$/;
const GUEST_KEY = /^[\w-]{16,128}$/;
const GUEST_ONLY = "a guest can only join the map it was invited to";

interface InviteRecord {
	host: string;
	map: string;
	exp: number;
}

function decoded(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return "";
	}
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

function bearer(request: Request): string {
	const auth = request.headers.get("Authorization") ?? "";
	return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

/** A record in the invite store: the key it is stored under, and how it reads. */
interface Stored<T> {
	key: string;
	read(kv: KVNamespace): Promise<T | null>;
}

const stored = <T>(key: string): Stored<T> => ({ key, read: (kv) => kv.get<T>(key, "json") });

/** The invite store's records, each under the key that names it. */
const Kv = {
	invite: (code: string) => stored<InviteRecord>(`invite:${code}`),
	inviteOf: (host: string, map: string): Stored<string> => {
		const key = `invite-of:${host}:${map}`;
		return { key, read: (kv) => kv.get(key) };
	},
};

function inviteCode(): string {
	let code = "";
	while (code.length < 8) {
		for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
			if (byte < 248 && code.length < 8) code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
		}
	}
	return code;
}

async function readInvite(kv: KVNamespace, code: string): Promise<InviteRecord | null> {
	const invite = await Kv.invite(code).read(kv);
	return invite && invite.exp > now() ? invite : null;
}

async function liveInvite(
	kv: KVNamespace,
	host: string,
	map: string,
): Promise<{ code: string; exp: number } | null> {
	const code = await Kv.inviteOf(host, map).read(kv);
	const invite = code ? await readInvite(kv, code) : null;
	return code && invite?.host === host && invite.map === map ? { code, exp: invite.exp } : null;
}

async function guestAdmitted(kv: KVNamespace, guest: GuestClaim): Promise<boolean> {
	const invite = await readInvite(kv, guest.code);
	return invite?.host === guest.host && invite.map === guest.map;
}

async function dropInvite(kv: KVNamespace, host: string, map: string): Promise<void> {
	const inviteOf = Kv.inviteOf(host, map);
	const code = await inviteOf.read(kv);
	if (!code) return;
	await kv.delete(Kv.invite(code).key);
	await kv.delete(inviteOf.key);
}

function directory(env: Env): DurableObjectStub<Directory> {
	return env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
}

function room(env: Env, host: string, map: string): DurableObjectStub<Room> {
	return env.ROOMS.get(env.ROOMS.idFromName(`${host}:${map}`));
}

async function handleSession(request: Request, env: Env): Promise<Response> {
	const token = bearer(request);
	if (!token) return bad("missing github token", 401);
	const res = await fetch(`${env.GITHUB_API ?? "https://api.github.com"}/user`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": "mma-collab",
			Accept: "application/vnd.github+json",
		},
	});
	if (!res.ok) return bad("github rejected the token", 401);
	const user = (await res.json()) as { login?: unknown };
	const login = typeof user.login === "string" ? user.login.toLowerCase() : "";
	if (!LOGIN.test(login)) return bad("github rejected the token", 401);
	const minted = await mintToken(env.WORKER_SECRET, login);
	return json({ token: minted.token, login, exp: minted.exp } satisfies Pass);
}

async function handleGuest(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { code?: unknown; key?: unknown } | null;
	if (!body || typeof body.code !== "string" || typeof body.key !== "string") {
		return bad("missing fields");
	}
	if (!GUEST_KEY.test(body.key)) return bad("bad key");
	const code = body.code.toLowerCase().replace(/[\s-]/g, "");
	const invite = INVITE_CODE.test(code) ? await readInvite(env.SHARES, code) : null;
	const share = invite && (await directory(env).share(invite.host, invite.map));
	if (!invite || !share) return bad("that invite code is not valid", 404);
	const { host, map } = invite;
	const ttl = Math.min(TOKEN_TTL, invite.exp - now());
	const { token, login, exp } = await mintToken(
		env.WORKER_SECRET,
		await guestLogin(env.WORKER_SECRET, code, body.key),
		{ host, map, code },
		ttl,
	);
	return json({ token, login, exp, invited: { host, map, name: share.name } } satisfies Pass);
}

async function handlePutShare(
	request: Request,
	env: Env,
	host: string,
	map: string,
): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		name?: unknown;
		logins?: unknown;
	} | null;
	if (!body || typeof body.name !== "string" || !Array.isArray(body.logins)) {
		return bad("missing fields");
	}
	if (!body.name.trim() || body.name.length > MAX_NAME) return bad("bad name");
	if (body.logins.length > MAX_LOGINS) return bad("too many logins");
	const logins = [
		...new Set(body.logins.map((l) => (typeof l === "string" ? l.toLowerCase() : ""))),
	];
	if (!logins.every((l) => LOGIN.test(l))) return bad("bad login");
	await directory(env).save(host, map, { name: body.name, logins });
	const invite = (await liveInvite(env.SHARES, host, map))?.code ?? null;
	return json({ map, name: body.name, logins, invite } satisfies Share);
}

async function handlePutInvite(env: Env, host: string, map: string): Promise<Response> {
	if (!(await directory(env).share(host, map))) {
		return bad("share the map before inviting guests", 404);
	}
	const live = await liveInvite(env.SHARES, host, map);
	if (live) return json(live satisfies Invite);
	const code = inviteCode();
	const exp = now() + INVITE_TTL;
	const record: InviteRecord = { host, map, exp };
	const options = { expirationTtl: INVITE_TTL };
	await env.SHARES.put(Kv.invite(code).key, JSON.stringify(record), options);
	await env.SHARES.put(Kv.inviteOf(host, map).key, code, options);
	return json({ code, exp } satisfies Invite);
}

async function handleListShares(env: Env, { login, guest }: WorkerToken): Promise<Response> {
	const mine: Share[] = [];
	const shared: Omit<Shared, "live">[] = [];
	if (guest) {
		const record =
			(await guestAdmitted(env.SHARES, guest)) &&
			(await directory(env).share(guest.host, guest.map));
		if (record) shared.push({ host: guest.host, map: guest.map, name: record.name });
	} else {
		const listed = await directory(env).listed(login);
		for (const { map, name, logins } of listed.mine) {
			const invite = (await liveInvite(env.SHARES, login, map))?.code ?? null;
			mine.push({ map, name, logins, invite });
		}
		for (const { host, map, name } of listed.withMe) shared.push({ host, map, name });
	}
	const withMe = await Promise.all(
		shared.map(async (s) => ({ ...s, live: await room(env, s.host, s.map).live() })),
	);
	return json({ mine, withMe } satisfies Shares);
}

async function handleRoom({ request, env, claims, host, map }: Call): Promise<Response> {
	const { login, guest } = claims;
	const role = new URL(request.url).searchParams.get("role");
	if (guest) {
		if (role !== "join" || host !== guest.host || map !== guest.map) return bad(GUEST_ONLY, 403);
		if (!(await guestAdmitted(env.SHARES, guest))) {
			return bad("the host turned this invite off", 403);
		}
	} else if (role === "host") {
		if (login !== host) return bad("not the host", 403);
	} else if (role === "join") {
		const share = await directory(env).share(host, map);
		if (!share) return bad("not shared", 404);
		if (!share.logins.includes(login)) return bad("not shared with you", 403);
	} else {
		return bad("bad role");
	}
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return bad("expected a websocket upgrade", 426);
	}
	return room(env, host, map).fetch(
		new Request(`https://room/${role}`, {
			headers: { Upgrade: "websocket", "X-Mma-Login": login, "X-Mma-Guest": guest ? "1" : "" },
		}),
	);
}

/** One request on its way to a handler: the caller's claims and the path's host and map. */
interface Call {
	request: Request;
	env: Env;
	claims: WorkerToken;
	host: string;
	map: string;
}

/** A method and path, who may call it, and what answers it: anyone, members only, or members
 *  and guests. */
type Route = { method: string; pattern: RegExp } & (
	| { auth: "open"; handler: (request: Request, env: Env) => Promise<Response> }
	| { auth: "member" | "guest"; handler: (call: Call) => Promise<Response> }
);

const ROUTES: Route[] = [
	{
		method: "POST",
		pattern: /^\/session$/,
		auth: "open",
		handler: handleSession,
	},
	{
		method: "POST",
		pattern: /^\/guest$/,
		auth: "open",
		handler: handleGuest,
	},
	{
		method: "GET",
		pattern: /^\/shares$/,
		auth: "guest",
		handler: ({ env, claims }) => handleListShares(env, claims),
	},
	{
		method: "PUT",
		pattern: /^\/shares\/(?<map>[^/]+)$/,
		auth: "member",
		handler: ({ request, env, claims, map }) => handlePutShare(request, env, claims.login, map),
	},
	{
		method: "DELETE",
		pattern: /^\/shares\/(?<map>[^/]+)$/,
		auth: "member",
		handler: ({ env, claims, map }) =>
			directory(env)
				.save(claims.login, map, null)
				.then(() => dropInvite(env.SHARES, claims.login, map))
				.then(empty),
	},
	{
		method: "PUT",
		pattern: /^\/invites\/(?<map>[^/]+)$/,
		auth: "member",
		handler: ({ env, claims, map }) => handlePutInvite(env, claims.login, map),
	},
	{
		method: "DELETE",
		pattern: /^\/invites\/(?<map>[^/]+)$/,
		auth: "member",
		handler: ({ env, claims, map }) => dropInvite(env.SHARES, claims.login, map).then(empty),
	},
	{
		method: "GET",
		pattern: /^\/room\/(?<host>[^/]+)\/(?<map>[^/]+)$/,
		auth: "guest",
		handler: handleRoom,
	},
];

async function route(request: Request, env: Env): Promise<Response> {
	const { pathname } = new URL(request.url);
	const found = ROUTES.map((route) => ({ route, match: route.pattern.exec(pathname) })).find(
		({ route, match }) => match && route.method === request.method,
	);

	const open = found?.route;
	if (open?.auth === "open") {
		const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
		if (!(await env.RATE.limit({ key: `ip:${ip}` })).success) return bad("rate limited", 429);
		return open.handler(request, env);
	}

	const claims = await verifyToken(env.WORKER_SECRET, bearer(request));
	if (!claims) return bad("unauthorized", 401);
	if (!(await env.RATE.limit({ key: `login:${claims.login}` })).success) {
		return bad("rate limited", 429);
	}
	if (claims.guest && found?.route.auth !== "guest") return bad(GUEST_ONLY, 403);
	if (!found || found.route.auth === "open") return bad("not found", 404);

	const params = found.match?.groups ?? {};
	const host = decoded(params.host ?? "").toLowerCase();
	const map = decoded(params.map ?? "");
	if (params.host !== undefined && !LOGIN.test(host)) return bad("bad host");
	if (params.map !== undefined && !MAP_ID.test(map)) return bad("bad map id");
	return found.route.handler({ request, env, claims, host, map });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		const response = await route(request, env).catch((e: unknown) => {
			console.error(`${request.method} ${pathname} failed`, e);
			return bad(String(e), 502);
		});
		if (response.status >= 400) console.warn(`${request.method} ${pathname} ${response.status}`);
		return response;
	},
};
