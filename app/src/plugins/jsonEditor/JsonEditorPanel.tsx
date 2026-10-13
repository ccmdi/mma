import { useState, useRef } from "react";
import { Edit } from "@/store/edit";
import type { Tag } from "@/types";
import type { Location } from "@/bindings.gen";
import { locDate } from "@/lib/util/format";
import { errText } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";
import "./jsonEditor.css";

function tagIdsToNames(tagIds: number[], tags: Record<string, Tag>): string[] {
	return tagIds.map((id) => tags[id]?.name ?? String(id));
}

function serializeActive(active: Location): string {
	const { id: _id, createdAt: _createdAt, modifiedAt: _modifiedAt, ...editable } = active;
	const map = MMA.Store.get().map;
	const display = map
		? { ...editable, tags: tagIdsToNames(editable.tags, MMA.Tag.all()) }
		: editable;
	return JSON.stringify(display, null, 2);
}

async function resolveTagNames(names: string[]): Promise<number[]> {
	return (
		await Edit.values(
			"tags",
			names.map((name) => ({ set: { id: 0, name } })),
		)
	).mutation.keys;
}

export function JsonEditorPanel() {
	const active = MMA.Editor.get().open?.location;
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
			// `extra` merges key by key, so a key the text dropped must be cleared with null.
			const cleared = Object.fromEntries(Object.keys(active.extra ?? {}).map((k) => [k, null]));
			const extra = parsed.extra ? { ...cleared, ...parsed.extra } : undefined;
			void MMA.Location.update([{ ...parsed, ...(extra && { extra }), id: active.id }]);
			setSaved(true);
		} catch (e: unknown) {
			setError(errText(e));
			setSaved(false);
		}
	};

	return (
		<div className="json-editor">
			<div className="json-editor__meta mono">
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
				className="text-input json-editor__text"
			/>
			{error && <div className="json-editor__error">{error}</div>}
			<div className="json-editor__actions">
				<Button onClick={() => void handleSave()}>{t("Apply")}</Button>
				{saved && <span className="json-editor__saved">{t("Saved")}</span>}
			</div>
		</div>
	);
}
