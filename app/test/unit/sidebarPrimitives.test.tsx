// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "@/components/primitives/EmptyState";
import { SegmentedControl, Section, Sidebar } from "@/components/primitives/Sidebar";

describe("SegmentedControl", () => {
	it("marks exactly the selected option active", () => {
		const html = renderToStaticMarkup(
			<SegmentedControl
				value="b"
				onChange={() => {}}
				options={[
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				]}
			/>,
		);
		const active = html.match(/segmented__option is-active/g) ?? [];
		expect(active.length).toBe(1);
		expect(html).toMatch(/is-active[^>]*>B</);
	});

	it("renders disabled options", () => {
		const html = renderToStaticMarkup(
			<SegmentedControl
				value="a"
				onChange={() => {}}
				options={[
					{ value: "a", label: "A" },
					{ value: "b", label: "B", disabled: true },
				]}
			/>,
		);
		expect(html).toContain("disabled");
	});
});

describe("Sidebar", () => {
	it("pins the footer outside the scrolling body", () => {
		const html = renderToStaticMarkup(
			<Sidebar title="T" footer={<button>Go</button>}>
				<p>Body</p>
			</Sidebar>,
		);
		const root = new DOMParser().parseFromString(html, "text/html");
		const footer = root.querySelector(".plugin-sidebar__footer")!;
		expect(footer.textContent).toBe("Go");
		expect(footer.closest(".plugin-sidebar__body")).toBeNull();
	});

	it("renders no footer when none is given", () => {
		const html = renderToStaticMarkup(<Sidebar title="T">x</Sidebar>);
		expect(html).not.toContain("plugin-sidebar__footer");
	});
});

describe("Section", () => {
	it("renders title and body when open by default", () => {
		const html = renderToStaticMarkup(<Section title="My Section">inner-content</Section>);
		expect(html).toContain("My Section");
		expect(html).toContain("inner-content");
		expect(html).toContain("plugin-section__body");
	});

	it("hides the body when defaultOpen is false", () => {
		const html = renderToStaticMarkup(
			<Section title="T" defaultOpen={false}>
				hidden-body
			</Section>,
		);
		expect(html).not.toContain("hidden-body");
	});

	it("always shows the body when not collapsible", () => {
		const html = renderToStaticMarkup(
			<Section title="T" collapsible={false} defaultOpen={false}>
				always
			</Section>,
		);
		expect(html).toContain("always");
		expect(html).not.toContain("plugin-section__chevron");
	});
});

describe("EmptyState", () => {
	it("renders its message", () => {
		const html = renderToStaticMarkup(<EmptyState>nothing here</EmptyState>);
		expect(html).toContain("nothing here");
		expect(html).toContain("empty-state");
	});
});
