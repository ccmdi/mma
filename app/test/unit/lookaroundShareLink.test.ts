import { describe, it, expect } from "vitest";
import {
	buildLookmapOpenUrl,
	buildLookmapShareUrl,
	encodeShareLinkPayload,
	googlePovToLookmapRadians,
} from "@/lib/sv/lookaround/shareLink";

describe("encodeShareLinkPayload", () => {
	it("round-trips float32 lat/lon/yaw/pitch as base64url", () => {
		const lat = 37.7749;
		const lon = -122.4194;
		const yaw = 1.2;
		const pitch = -0.1;
		const payload = encodeShareLinkPayload(lat, lon, yaw, pitch);
		expect(payload).not.toMatch(/[+/=]/);
		const bin = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const floats = new Float32Array(bytes.buffer);
		expect(floats[0]).toBeCloseTo(lat, 5);
		expect(floats[1]).toBeCloseTo(lon, 5);
		expect(floats[2]).toBeCloseTo(yaw, 5);
		expect(floats[3]).toBeCloseTo(pitch, 5);
	});
});

describe("lookmap URLs", () => {
	it("builds open hash with lat/lon and pov degrees", () => {
		expect(buildLookmapOpenUrl(48.1, 11.5, 90, -5)).toBe(
			"https://lookmap.skzk.dev/#c=18/48.1/11.5&p=48.1/11.5&a=90/-5",
		);
	});

	it("builds share hash with encoded payload", () => {
		const { yaw, pitch } = googlePovToLookmapRadians(180, 10);
		const url = buildLookmapShareUrl(48, 11, yaw, pitch);
		expect(url.startsWith("https://lookmap.skzk.dev/#s=")).toBe(true);
	});
});
