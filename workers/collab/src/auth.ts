import { Base64url } from "../../shared/base64url";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TOKEN_TTL = 24 * 60 * 60;

function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export interface GuestClaim {
	host: string;
	map: string;
	code: string;
}

export interface WorkerToken {
	login: string;
	exp: number;
	guest?: GuestClaim;
}

export interface MintedToken extends WorkerToken {
	token: string;
}

export async function mintToken(
	secret: string,
	login: string,
	guest?: GuestClaim,
	ttl = TOKEN_TTL,
): Promise<MintedToken> {
	const exp = Math.floor(Date.now() / 1000) + ttl;
	const minted: WorkerToken = guest ? { login, exp, guest } : { login, exp };
	const claims = encoder.encode(JSON.stringify(minted));
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), claims));
	return { token: `${Base64url.encode(claims)}.${Base64url.encode(signature)}`, ...minted };
}

/** The login the guest holding `key` is known by under invite `code`, the same every time it
 *  redeems the code. */
export async function guestLogin(secret: string, code: string, key: string): Promise<string> {
	const seal = encoder.encode(`guest:${code}:${key}`);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), seal));
	return `guest--${[...mac.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function isGuestClaim(value: unknown): value is GuestClaim {
	if (typeof value !== "object" || value === null) return false;
	const guest = value as Record<string, unknown>;
	return (
		typeof guest.host === "string" &&
		typeof guest.map === "string" &&
		typeof guest.code === "string"
	);
}

export async function verifyToken(secret: string, token: string): Promise<WorkerToken | null> {
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const claims = Base64url.decode(parts[0]);
	const signature = Base64url.decode(parts[1]);
	if (!claims || !signature) return null;
	if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, claims))) {
		return null;
	}

	let parsed: { login?: unknown; exp?: unknown; guest?: unknown };
	try {
		parsed = JSON.parse(decoder.decode(claims));
	} catch {
		return null;
	}
	if (typeof parsed.login !== "string" || typeof parsed.exp !== "number") return null;
	if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
	if (parsed.guest === undefined) return { login: parsed.login, exp: parsed.exp };
	if (!isGuestClaim(parsed.guest)) return null;
	const { host, map, code } = parsed.guest;
	return { login: parsed.login, exp: parsed.exp, guest: { host, map, code } };
}
