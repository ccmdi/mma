/** Verification primitives shared by the intake and reply routes.
 *
 *  The proof-of-work rule here must stay identical to the solver in
 *  `app/src-tauri/src/net/feedback.rs`; the two are a matched pair and there is no negotiation
 *  step between them. */

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** The image formats an attachment may be, identified by magic bytes rather than by what the
 *  client claims. A caller that could name its own content type could park anything at a
 *  github.com URL. */
export function imageType(bytes: ArrayBuffer): string | null {
	const b = new Uint8Array(bytes);
	const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	// RIFF....WEBP
	if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((v, i) => b[8 + i] === v)) {
		return "image/webp";
	}
	return null;
}

/** How long a minted challenge stays valid. */
export const CHALLENGE_TTL = 600;

/** Mint an expiring, self-authenticating challenge: `ts.rand.sig`. Stateless -- the signature
 *  is what proves the worker issued it, the timestamp is what expires it. */
export async function mintChallenge(secret: string): Promise<string> {
	const ts = Math.floor(Date.now() / 1000);
	const rand = hex(crypto.getRandomValues(new Uint8Array(8)).buffer);
	return `${ts}.${rand}.${await hmacHex(secret, `pow:${ts}.${rand}`)}`;
}

/** Whether `challenge` was minted by us and has not expired. */
export async function validChallenge(secret: string, challenge: string): Promise<boolean> {
	const m = /^(\d{1,12})\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(challenge);
	if (!m) return false;
	const age = Math.floor(Date.now() / 1000) - Number(m[1]);
	if (age < 0 || age > CHALLENGE_TTL) return false;
	return safeEqual(m[3], await hmacHex(secret, `pow:${m[1]}.${m[2]}`));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function leadingZeroBits(bytes: Uint8Array): number {
	let n = 0;
	for (const b of bytes) {
		if (b !== 0) return n + Math.clz32(b) - 24;
		n += 8;
	}
	return n;
}

/** `challenge` is a minted challenge joined to the hash of the submitted content, so a nonce
 *  is bound both to the exact content it was solved for and to a window the worker controls:
 *  once the minted half expires, the work is spent whether or not it was ever submitted. */
export async function verifyPow(challenge: string, nonce: number, bits: number): Promise<boolean> {
	if (!Number.isInteger(nonce) || nonce < 0) return false;
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge}:${nonce}`));
	return leadingZeroBits(new Uint8Array(digest)) >= bits;
}

/** Constant-time string compare, so a reply token cannot be recovered byte by byte. */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
