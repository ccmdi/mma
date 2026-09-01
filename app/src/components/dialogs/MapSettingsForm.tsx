import { useEffect, useId, useMemo, useState } from "react";
import { mdiRestore, mdiClose } from "@mdi/js";
import { DEFAULT_DUPLICATE_SCORE } from "@/bindings.consts";
import type { MapMeta } from "@/bindings.gen";
import { patchMapMeta } from "@/store/useMapStore";
import { deleteMap } from "@/store/mapList";
import { cmd } from "@/lib/commands";
import { useSetting, setSetting, getSettings } from "@/store/settings";
import { labelColor, rgbToHex, hexToRgb } from "@/lib/util/color";
import { useCloseDialog } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/primitives/Icon";
import { ColorPicker } from "@/components/primitives/ColorPicker";
import { TextInput } from "@/components/primitives/TextInput";
import { ScoreBoundsEditor } from "./ScoreBoundsEditor";
import { t } from "@/lib/i18n";

/** Where the form is being shown. Both edit the same map; the list only cares about the
 *  map as a catalogue entry, the editor also tunes how the open map behaves. */
export type MapFormContext = "list" | "editor";

interface SectionProps {
	/** The map with its unsaved edits already applied. */
	draft: MapMeta;
	edit: (patch: Partial<MapMeta>) => void;
	/** Hold Save while this section's input is unusable. */
	block: (blocked: boolean) => void;
}

interface Section {
	id: string;
	/** Contexts this section appears in. Adding a section is one entry here; neither
	 *  call site knows what the form contains. */
	in: MapFormContext[];
	Body: (props: SectionProps) => React.ReactNode;
}

function NameSection({ draft, edit, block }: SectionProps) {
	const id = useId();
	useEffect(() => block(draft.name.trim().length === 0), [draft.name, block]);
	return (
		<p className="edit-map-modal__name">
			<label htmlFor={id}>{t("Map name:")}</label>
			<TextInput
				id={id}
				type="text"
				value={draft.name}
				onChange={(e) => edit({ name: e.target.value })}
				minLength={1}
				maxLength={100}
				autoFocus
			/>
		</p>
	);
}

function DescriptionSection({ draft, edit }: SectionProps) {
	const id = useId();
	return (
		<p className="edit-map-modal__name">
			<label htmlFor={id}>{t("Description:")}</label>
			<textarea
				id={id}
				className="text-input edit-map-modal__description"
				value={draft.description}
				onChange={(e) => edit({ description: e.target.value })}
				rows={3}
				maxLength={1000}
			/>
		</p>
	);
}

function LabelsSection({ draft, edit }: SectionProps) {
	const labelColors = useSetting("labelColors");
	const [input, setInput] = useState("");
	const labels = draft.labels;

	const setLabelColor = (label: string, hex: string) =>
		setSetting("labelColors", { ...getSettings().labelColors, [label.toLowerCase()]: hex });

	const add = () => {
		const val = input.trim().toLowerCase();
		if (val && !labels.includes(val)) edit({ labels: [...labels, val] });
		setInput("");
	};

	return (
		<div className="map-edit-labels">
			<div className="map-edit-labels__label">{t("Labels")}</div>
			<div className="map-edit-labels__list">
				{labels.map((l) => (
					<span key={l} className="map-label map-label--editable">
						<ColorPicker
							color={hexToRgb(labelColor(l, labelColors))}
							onChange={(rgb) => setLabelColor(l, rgbToHex(rgb))}
							ariaLabel={t("Color for {label}", { label: l })}
						/>
						{l}
						<button
							type="button"
							className="map-label__remove"
							onClick={() => edit({ labels: labels.filter((x) => x !== l) })}
						>
							<Icon path={mdiClose} size={12} />
						</button>
					</span>
				))}
				<input
					type="text"
					className="map-edit-labels__input"
					placeholder={t("Add label...")}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
						if (e.key === "Backspace" && !input && labels.length > 0) {
							edit({ labels: labels.slice(0, -1) });
						}
					}}
				/>
			</div>
		</div>
	);
}

function DuplicatesSection({ draft, edit, block }: SectionProps) {
	const id = useId();
	const score = draft.settings.duplicateScore ?? "";
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (score.trim() === "") {
			setError(null);
			return;
		}
		let live = true;
		void cmd.fieldExprError(score).then((err) => {
			if (live) setError(err);
		});
		return () => {
			live = false;
		};
	}, [score]);
	useEffect(() => block(error != null), [error, block]);

	const setScore = (v: string) =>
		edit({ settings: { ...draft.settings, duplicateScore: v.trim() || null } });

	return (
		<>
			<p className="edit-map-modal__name">
				<label htmlFor={id}>{t("Duplicate preference:")}</label>
				<span className="edit-map-modal__expr">
					<TextInput
						id={id}
						type="text"
						className="mono"
						value={score}
						onChange={(e) => setScore(e.target.value)}
						placeholder={DEFAULT_DUPLICATE_SCORE}
						spellCheck={false}
					/>
					<button
						type="button"
						className="icon-button"
						onClick={() => setScore("")}
						disabled={score === ""}
						title={t("Reset to default")}
						aria-label={t("Reset to default")}
					>
						<Icon path={mdiRestore} />
					</button>
				</span>
			</p>
			<p className="edit-map-modal__hint">
				{error
					? t("Invalid expression: {error}", { error })
					: t(
							"Scores every duplicate; the highest is the one kept when duplicates are merged or pruned. Merging keeps all tags either way, and ties go to the oldest.",
						)}
			</p>
		</>
	);
}

function ScoringSection({ draft, edit }: SectionProps) {
	return (
		<ScoreBoundsEditor
			value={draft.scoreBounds}
			onChange={(scoreBounds) => edit({ scoreBounds })}
		/>
	);
}

const SECTIONS: Section[] = [
	{ id: "name", in: ["list", "editor"], Body: NameSection },
	{ id: "description", in: ["list", "editor"], Body: DescriptionSection },
	{ id: "labels", in: ["list", "editor"], Body: LabelsSection },
	{ id: "duplicates", in: ["editor"], Body: DuplicatesSection },
	{ id: "scoring", in: ["editor"], Body: ScoringSection },
];

function DeleteMapSection({ mapId, name }: { mapId: string; name: string }) {
	const [confirming, setConfirming] = useState(false);

	if (!confirming) {
		return (
			<Button variant="destructive" onClick={() => setConfirming(true)}>
				{t("Delete map")}
			</Button>
		);
	}

	return (
		<div className="edit-map-modal__delete">
			<span>
				{t("Delete “{name}”? This permanently removes the map and its history.", {
					name: name || t("(unnamed)"),
				})}
			</span>
			<Button onClick={() => setConfirming(false)}>{t("Cancel")}</Button>
			<Button variant="destructive" onClick={() => void deleteMap(mapId)}>
				{t("Delete map")}
			</Button>
		</div>
	);
}

/** Edits one map's metadata. The same form in both windows; `context` decides which
 *  sections it is made of. */
export function MapSettingsForm({ map, context }: { map: MapMeta; context: MapFormContext }) {
	const close = useCloseDialog();
	const [patch, setPatch] = useState<Partial<MapMeta>>({});
	const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());

	const draft: MapMeta = { ...map, ...patch };
	const sections = SECTIONS.filter((s) => s.in.includes(context));

	// Stable per-section callbacks: sections put them in effect deps.
	const handlers = useMemo(
		() =>
			new Map(
				SECTIONS.map((s) => [
					s.id,
					{
						edit: (p: Partial<MapMeta>) => setPatch((prev) => ({ ...prev, ...p })),
						block: (v: boolean) =>
							setBlocked((prev) => {
								if (prev.has(s.id) === v) return prev;
								const next = new Set(prev);
								if (v) next.add(s.id);
								else next.delete(s.id);
								return next;
							}),
					},
				]),
			),
		[],
	);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void patchMapMeta(map.id, patch);
				close();
			}}
		>
			{sections.map(({ id, Body }) => (
				<Body key={id} draft={draft} {...handlers.get(id)!} />
			))}
			<div className="edit-map-modal__actions">
				{context === "editor" && <DeleteMapSection mapId={map.id} name={map.name} />}
				<Button variant="primary" type="submit" disabled={blocked.size > 0}>
					{t("Save")}
				</Button>
			</div>
		</form>
	);
}
