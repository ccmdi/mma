import { Directory } from "../src/directory";
import { Room } from "../src/room";
import worker, { type Env } from "../src/index";
import { mintToken } from "../src/auth";

export const SECRET = "test-secret";

class FakeSocket {
	readyState = 1;
	attachment: unknown = null;
	peer!: FakeSocket;
	received: Record<string, unknown>[] = [];
	closed: { code?: number; reason?: string } | null = null;

	send(text: string) {
		if (this.readyState !== 1) throw new Error("socket is closed");
		this.peer.received.push(JSON.parse(text));
	}

	close(code?: number, reason?: string) {
		if (this.readyState !== 1) return;
		this.readyState = 2;
		this.peer.closed = { code, reason };
	}

	serializeAttachment(value: unknown) {
		this.attachment = structuredClone(value);
	}

	deserializeAttachment() {
		return structuredClone(this.attachment);
	}
}

class FakePair {
	0: FakeSocket;
	1: FakeSocket;
	constructor() {
		this[0] = new FakeSocket();
		this[1] = new FakeSocket();
		this[0].peer = this[1];
		this[1].peer = this[0];
	}
}

const NodeResponse = globalThis.Response;

class WorkerResponse extends NodeResponse {
	constructor(body?: BodyInit | null, init?: ResponseInit) {
		super(body, init?.status === 101 ? { ...init, status: 200 } : init);
		Object.defineProperty(this, "status", { value: init?.status ?? 200 });
		Object.defineProperty(this, "webSocket", { value: init?.webSocket ?? null });
	}
}

class FakeAutoResponse {
	constructor(
		readonly request: string,
		readonly response: string,
	) {}
}

Object.assign(globalThis, {
	WebSocketPair: FakePair,
	WebSocketRequestResponsePair: FakeAutoResponse,
	Response: WorkerResponse,
});

class FakeSyncKv {
	entries = new Map<string, unknown>();

	get(key: string) {
		return structuredClone(this.entries.get(key));
	}

	put(key: string, value: unknown) {
		this.entries.set(key, structuredClone(value));
	}

	delete(key: string) {
		return this.entries.delete(key);
	}

	*list({ prefix = "" }: { prefix?: string } = {}) {
		for (const key of [...this.entries.keys()].sort()) {
			if (key.startsWith(prefix)) yield [key, this.get(key)] as [string, unknown];
		}
	}
}

class FakeState {
	sockets: { ws: FakeSocket; tags: string[] }[] = [];
	autoResponse: FakeAutoResponse | null = null;
	storage = { kv: new FakeSyncKv() };

	acceptWebSocket(ws: FakeSocket, tags: string[] = []) {
		this.sockets.push({ ws, tags });
	}

	getWebSockets(tag?: string) {
		return this.sockets
			.filter((s) => s.ws.readyState < 3 && (tag === undefined || s.tags.includes(tag)))
			.map((s) => s.ws);
	}

	setWebSocketAutoResponse(pair: FakeAutoResponse) {
		this.autoResponse = pair;
	}
}

export function fakeKv() {
	const store = new Map<string, string>();
	const ttls = new Map<string, number>();
	const kv = {
		store,
		ttls,
		writes: 0,
		async get(key: string, type?: "json") {
			const raw = store.get(key) ?? null;
			await new Promise((resolve) => setTimeout(resolve));
			return raw !== null && type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string, options?: { expirationTtl?: number }) {
			kv.writes++;
			store.set(key, value);
			if (options?.expirationTtl) ttls.set(key, options.expirationTtl);
			else ttls.delete(key);
		},
		async delete(key: string) {
			kv.writes++;
			store.delete(key);
			ttls.delete(key);
		},
		async list(): Promise<never> {
			throw new Error("the share directory never lists");
		},
	};
	return kv;
}

export function fakeEnv(limit = 60) {
	const kv = fakeKv();
	const rooms = new Map<string, { room: Room; state: FakeState }>();
	const counts = new Map<string, number>();
	const directoryState = new FakeState();
	const directory = new Directory(directoryState as unknown as DurableObjectState, {});
	const roomFor = (name: string) => {
		let entry = rooms.get(name);
		if (!entry) {
			const state = new FakeState();
			entry = { room: new Room(state as unknown as DurableObjectState, {}), state };
			rooms.set(name, entry);
		}
		return entry;
	};
	const env = {
		WORKER_SECRET: SECRET,
		SHARES: kv,
		ROOMS: {
			idFromName: (name: string) => name,
			get: (name: string) => ({
				fetch: (input: RequestInfo, init?: RequestInit) =>
					roomFor(name).room.fetch(new Request(input, init)),
				live: async () => roomFor(name).room.live(),
			}),
		},
		DIRECTORY: {
			idFromName: (name: string) => name,
			get: () => ({
				share: async (host: string, map: string) => directory.share(host, map),
				save: async (...args: Parameters<Directory["save"]>) => directory.save(...args),
				listed: async (login: string) => directory.listed(login),
			}),
		},
		RATE: {
			async limit({ key }: { key: string }) {
				const count = (counts.get(key) ?? 0) + 1;
				counts.set(key, count);
				return { success: count <= limit };
			},
		},
	};
	return { env: env as unknown as Env, kv, roomFor, directory: directoryState.storage.kv.entries };
}

export type Harness = ReturnType<typeof fakeEnv>;

export async function tokenFor(login: string): Promise<string> {
	return (await mintToken(SECRET, login)).token;
}

export async function call(
	h: Harness,
	login: string | null,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	const auth: Record<string, string> = login
		? { Authorization: `Bearer ${await tokenFor(login)}` }
		: {};
	return worker.fetch(
		new Request(`https://collab.test${path}`, {
			method,
			headers: { ...auth, ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		h.env,
	);
}

export interface Client {
	received: Record<string, unknown>[];
	closed: { code?: number; reason?: string } | null;
	send(message: unknown): Promise<void>;
	close(): Promise<void>;
}

export async function connect(
	h: Harness,
	login: string,
	host: string,
	map: string,
	role: "host" | "join",
): Promise<Client> {
	const res = await call(h, login, "GET", `/room/${host}/${map}?role=${role}`, undefined, {
		Upgrade: "websocket",
	});
	if (res.status !== 101) throw new Error(`refused ${res.status}: ${await res.text()}`);
	const client = (res as unknown as { webSocket: FakeSocket }).webSocket;
	const server = client.peer;
	const { room, state } = h.roomFor(`${host}:${map}`);
	return {
		received: client.received,
		get closed() {
			return client.closed;
		},
		send: (message) =>
			room.webSocketMessage(
				server as unknown as WebSocket,
				typeof message === "string" ? message : JSON.stringify(message),
			),
		async close() {
			client.readyState = 3;
			server.readyState = 2;
			await room.webSocketClose(server as unknown as WebSocket);
			server.readyState = 3;
			state.sockets = state.sockets.filter((s) => s.ws !== server);
		},
	};
}
