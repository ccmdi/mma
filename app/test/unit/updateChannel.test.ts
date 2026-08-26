import { describe, it, expect } from "vitest";
import { cmpVersion, isPrereleaseVersion, splitVersion } from "@/lib/util/util";
import { pickRelease, toRelease, type ApiRelease, type Release } from "@/lib/util/updateCheck";

function rel(version: string, prerelease = false, manifest = true): Release {
	return {
		tag: `v${version}`,
		version,
		body: "",
		prerelease,
		publishedAt: "",
		manifestUrl: manifest ? `https://example.invalid/${version}/latest.json` : null,
	};
}

function api(tag: string, prerelease: boolean): ApiRelease {
	return {
		tag_name: tag,
		body: "notes",
		draft: false,
		prerelease,
		published_at: "2026-08-21T00:00:00Z",
		assets: [{ name: "latest.json", browser_download_url: "https://example.invalid/latest.json" }],
	};
}

/** Newest first, the order `fetchReleases` hands to `pickRelease`. */
function feed(...releases: Release[]): Release[] {
	return [...releases].sort((a, b) => cmpVersion(b.version, a.version));
}

describe("cmpVersion", () => {
	it("orders by numeric component", () => {
		expect(cmpVersion("0.9.2", "0.9.1")).toBeGreaterThan(0);
		expect(cmpVersion("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(cmpVersion("1.0", "1.0.0")).toBe(0);
	});

	it("sorts a pre-release below the release it precedes", () => {
		expect(cmpVersion("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(cmpVersion("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
		expect(cmpVersion("1.0.0-rc.1", "0.9.9")).toBeGreaterThan(0);
	});

	it("orders pre-release identifiers numerically, then lexically", () => {
		expect(cmpVersion("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
		expect(cmpVersion("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
		expect(cmpVersion("1.0.0-rc.1", "1.0.0-rc")).toBeGreaterThan(0);
		expect(cmpVersion("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
	});

	it("ignores a leading v and build metadata", () => {
		expect(cmpVersion("v0.9.2", "0.9.2")).toBe(0);
		expect(cmpVersion("0.9.2+build.7", "0.9.2")).toBe(0);
		expect(splitVersion("v0.7.0-rc.2+build")).toEqual(["0.7.0", "rc.2"]);
		expect(isPrereleaseVersion("0.9.2")).toBe(false);
		expect(isPrereleaseVersion("0.9.2-rc.1")).toBe(true);
	});
});

describe("pickRelease", () => {
	const releases = feed(rel("0.9.0", true), rel("0.9.1", true), rel("0.9.2"), rel("0.8.3"));

	it("offers the newest stable when pre-releases are off", () => {
		expect(pickRelease(releases, "0.8.3", false)?.version).toBe("0.9.2");
	});

	it("offers a newer pre-release only when they are on", () => {
		const ahead = feed(rel("0.9.2"), rel("0.9.3", true));
		expect(pickRelease(ahead, "0.9.2", false)).toBeNull();
		expect(pickRelease(ahead, "0.9.2", true)?.version).toBe("0.9.3");
	});

	it("never offers a downgrade to someone ahead of stable", () => {
		const ahead = feed(rel("0.9.2"), rel("0.9.3", true));
		expect(pickRelease(ahead, "0.9.3", false)).toBeNull();
		expect(pickRelease(ahead, "0.9.3", true)).toBeNull();
	});

	it("skips a semver-tagged pre-release the GitHub flag missed", () => {
		const tagged = feed(toRelease(api("v1.0.0-rc.1", false)));
		expect(pickRelease(tagged, "0.9.2", false)).toBeNull();
		expect(pickRelease(tagged, "0.9.2", true)?.version).toBe("1.0.0-rc.1");
	});

	it("maps a release, deriving the pre-release flag from either source", () => {
		expect(toRelease(api("v0.9.2", false))).toMatchObject({ version: "0.9.2", prerelease: false });
		expect(toRelease(api("v0.9.1", true)).prerelease).toBe(true);
		expect(toRelease(api("v1.0.0-rc.1", false)).prerelease).toBe(true);
	});

	it("skips a release with no updater manifest", () => {
		const partial = feed(rel("0.9.2"), rel("0.9.3", false, false));
		expect(pickRelease(partial, "0.9.2", true)).toBeNull();
	});
});
