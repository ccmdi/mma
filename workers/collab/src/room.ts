import { DurableObject } from "cloudflare:workers";

import { bad } from "../../shared/http";
import type { Heard, Said } from "./wire.gen";

export const REPLACED = 4000;
export const MAX_MESSAGE = 64 * 1024;

type Seat =
	| { role: "host"; gone?: true }
	| { role: "join"; joinId: string; login: string; guest: boolean; gone?: true };
type JoinSeat = Extract<Seat, { role: "join" }>;

function send(ws: WebSocket, message: Heard): void {
	try {
		ws.send(JSON.stringify(message));
	} catch {}
}

/** The seat at `ws`, unless it is gone. */
function present(ws: WebSocket): Seat | undefined {
	const at = ws.deserializeAttachment() as Seat;
	return at.gone ? undefined : at;
}

/** Mark the seat at `ws` gone, handing back what it was unless it already was. */
function vacate(ws: WebSocket): Seat | undefined {
	const left = present(ws);
	if (!left) return undefined;
	try {
		ws.serializeAttachment({ ...left, gone: true });
	} catch {}
	return left;
}

function retire(ws: WebSocket): void {
	vacate(ws);
	try {
		ws.close(REPLACED, "replaced");
	} catch {}
}

export class Room extends DurableObject<unknown> {
	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	/** Whether the host is in the room. */
	live(): boolean {
		return this.host() !== undefined;
	}

	private host(except?: WebSocket): WebSocket | undefined {
		return this.ctx.getWebSockets("host").find((ws) => ws !== except && present(ws));
	}

	private joiners(except?: WebSocket): [WebSocket, JoinSeat][] {
		return this.ctx
			.getWebSockets()
			.filter((ws) => ws !== except)
			.map((ws): [WebSocket, Seat | undefined] => [ws, present(ws)])
			.filter((entry): entry is [WebSocket, JoinSeat] => entry[1]?.role === "join");
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		const login = request.headers.get("X-Mma-Login") ?? "";
		const guest = !!request.headers.get("X-Mma-Guest");
		const [client, server] = Object.values(new WebSocketPair());

		if (pathname === "/host") {
			for (const old of this.ctx.getWebSockets("host")) retire(old);
			this.ctx.acceptWebSocket(server, ["host"]);
			server.serializeAttachment({ role: "host" } satisfies Seat);
			for (const [ws, join] of this.joiners()) {
				send(server, { type: "joined", peer: join.joinId, login: join.login });
				send(ws, { type: "host", live: true });
			}
		} else if (pathname === "/join") {
			const host = this.host();
			for (const [old, join] of this.joiners()) {
				if (join.login === login) retire(old);
			}
			const joinId = crypto.randomUUID();
			this.ctx.acceptWebSocket(server, [`join:${joinId}`]);
			server.serializeAttachment({ role: "join", joinId, login, guest } satisfies Seat);
			send(server, { type: "host", live: host !== undefined });
			if (host) send(host, { type: "joined", peer: joinId, login });
		} else {
			return bad("not found", 404);
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string" || message.length > MAX_MESSAGE) return;
		const from = present(ws);
		if (!from) return;
		let frame: Partial<Said>;
		try {
			frame = JSON.parse(message);
		} catch {
			return;
		}
		if (frame?.type !== "signal" || frame.data === undefined) return;

		if (from.role === "host") {
			if (typeof frame.to !== "string") return;
			const target = this.ctx.getWebSockets(`join:${frame.to}`).find(present);
			if (target) send(target, { type: "signal", data: frame.data });
		} else {
			const host = this.host();
			if (host) {
				const { joinId, login, guest } = from;
				send(host, { type: "signal", from: joinId, login, guest, data: frame.data });
			}
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.leave(ws);
		try {
			ws.close();
		} catch {}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.leave(ws);
	}

	private leave(ws: WebSocket): void {
		const left = vacate(ws);
		if (left?.role === "host" && !this.host(ws)) {
			for (const [join] of this.joiners(ws)) send(join, { type: "host", live: false });
		}
	}
}
