/** Unpadded base64url, both ways. */
export const Base64url = {
	/** `bytes` as unpadded base64url. */
	encode(bytes: ArrayBuffer | Uint8Array): string {
		const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		let raw = "";
		for (const b of view) raw += String.fromCharCode(b);
		return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	},

	/** The bytes `text` encodes, or null when it is not base64url. */
	decode(text: string): Uint8Array | null {
		if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
		const padded =
			text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
		try {
			const raw = atob(padded);
			const out = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
			return out;
		} catch {
			return null;
		}
	},
};
