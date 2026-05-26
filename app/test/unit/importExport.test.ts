import { describe, it, expect } from "vitest";
import { parseMapsUrl } from "@/lib/data/importExport";

describe("parseMapsUrl", () => {
	it("returns null for non-URL strings", async () => {
		expect(await parseMapsUrl("not a url")).toBeNull();
		expect(await parseMapsUrl("")).toBeNull();
		expect(await parseMapsUrl("   ")).toBeNull();
	});

	it("returns null for URLs from unsupported domains", async () => {
		expect(await parseMapsUrl("https://example.com/maps")).toBeNull();
		expect(await parseMapsUrl("https://openstreetmap.org/#map=14/51.5074/-0.1278")).toBeNull();
	});

	it("parses Google Maps pano viewpoint URL", async () => {
		const url =
			"https://www.google.com/maps?map_action=pano&viewpoint=48.8566,2.3522&heading=90&pitch=-5&pano=CAoSK0FGtest&fov=90";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(48.8566, 4);
		expect(result!.lng).toBeCloseTo(2.3522, 4);
		expect(result!.heading).toBe(90);
		expect(result!.pitch).toBe(-5);
		expect(result!.panoId).toBe("CAoSK0FGtest");
	});

	it("parses Google Maps pano URL without panoId", async () => {
		const url = "https://www.google.com/maps?map_action=pano&viewpoint=40.7128,-74.006";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(40.7128, 4);
		expect(result!.lng).toBeCloseTo(-74.006, 3);
		expect(result!.panoId).toBeNull();
	});

	it("returns null for pano URL missing viewpoint", async () => {
		const url = "https://www.google.com/maps?map_action=pano&heading=90";
		const result = await parseMapsUrl(url);
		expect(result).toBeNull();
	});

	it("parses Google Maps cbll layer=c URL", async () => {
		const url = "https://www.google.com/maps?layer=c&cbll=51.5074,-0.1278";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(51.5074, 4);
		expect(result!.lng).toBeCloseTo(-0.1278, 4);
		expect(result!.heading).toBe(0);
		expect(result!.panoId).toBeNull();
	});

	it("parses Arts & Culture URL", async () => {
		const url =
			"https://artsandculture.google.com/streetview?sv_pid=PANO123&sv_lat=35.6762&sv_lng=139.6503&sv_h=180&s_p=10&sv_z=2";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(35.6762, 4);
		expect(result!.lng).toBeCloseTo(139.6503, 4);
		expect(result!.heading).toBe(180);
		expect(result!.pitch).toBe(10);
		expect(result!.panoId).toBe("PANO123");
		expect(result!.zoom).toBe(2);
	});

	it("extracts extra[tags] from query params", async () => {
		const url =
			"https://www.google.com/maps?map_action=pano&viewpoint=10,20&extra[tags]=Mountains&extra[tags]=Coastal";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.tags).toEqual(["Mountains", "Coastal"]);
	});

	it("extracts extra[tags] from hash params", async () => {
		const url =
			"https://www.google.com/maps?map_action=pano&viewpoint=10,20#extra[tags]=FromHash";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.tags).toEqual(["FromHash"]);
	});

	it("returns empty tags when none present", async () => {
		const url = "https://www.google.com/maps?map_action=pano&viewpoint=10,20";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.tags).toEqual([]);
	});

	it("trims whitespace from input", async () => {
		const url = "  https://www.google.com/maps?map_action=pano&viewpoint=10,20  ";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBe(10);
	});

	it("defaults heading/pitch/zoom for pano URLs without them", async () => {
		const url = "https://www.google.com/maps?map_action=pano&viewpoint=10,20";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.heading).toBe(0);
		expect(result!.pitch).toBe(0);
	});
});
