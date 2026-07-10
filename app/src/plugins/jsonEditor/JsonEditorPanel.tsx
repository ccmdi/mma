import { useState, useRef } from "react";
import type { Location, Tag } from "@/bindings.gen";
import { createTags } from "@/store/useMapStore";
import { locDate } from "@/lib/util/format";

function tagIdsToNames(tagIds: number[], tags: Record<string, Tag>): string[] {
	return tagIds.map((id) => tags[id]?.name ?? String(id));
}

function serializeActive(active: Location): string {
	const { id: _id, createdAt: _createdAt, modifiedAt: _modifiedAt, ...editable } = active;
	const map = MMA.getCurrentMap();
	const display = map
		? { ...editable, tags: tagIdsToNames(editable.tags, map.meta.tags) }
		: editable;
	return JSON.stringify(display, null, 2);
}

async function resolveTagNames(names: string[]): Promise<number[]> {
	if (names.length === 0) return [];
	const resolved = await createTags(names);
	return resolved.map((t) => t.id);
}

export function JsonEditorPanel() {
	const active = MMA.getActiveLocation();
	const prevIdRef = useRef(active?.id);
	const [text, setText] = useState(() => (active ? serializeActive(active) : ""));
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	if (active && active.id !== prevIdRef.current) {
		prevIdRef.current = active.id;
		setText(serializeActive(active));
		setError(null);
		setSaved(false);
	}

	if (!active) return null;

	const handleSave = async () => {
		try {
			const parsed = JSON.parse(text) as Partial<Location>;
			if (parsed.tags && Array.isArray(parsed.tags)) {
				parsed.tags = await resolveTagNames(parsed.tags as unknown as string[]);
			}
			setError(null);
			MMA.updateLocations([{ id: active.id, patch: parsed }]);
			setSaved(true);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : String(e));
			setSaved(false);
		}
	};

	return (
		<div style={{ fontSize: "12px" }}>
			<div style={{ fontSize: "11px", opacity: 0.5, marginBottom: 4 }}>
				id: {active.id}
				<br />
				created: {locDate(active.createdAt).toISOString()}
				{active.modifiedAt && (
					<>
						<br />
						modified: {locDate(active.modifiedAt).toISOString()}
					</>
				)}
			</div>
			<textarea
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					setSaved(false);
				}}
				spellCheck={false}
				style={{
					width: "100%",
					minHeight: "160px",
					fontFamily: "monospace",
					fontSize: "12px",
					background: "#fff",
					color: "#222",
					border: "1px solid #ccc",
					borderRadius: 3,
					padding: 8,
					resize: "vertical",
					boxSizing: "border-box",
				}}
			/>
			{error && <div style={{ color: "#e53e3e", fontSize: "11px", marginTop: 4 }}>{error}</div>}
			<div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
				<button className="button" onClick={handleSave}>
					Apply
				</button>
				{saved && <span style={{ color: "var(--constructive)", fontSize: "11px" }}>Saved</span>}
			</div>
		</div>
	);
}
