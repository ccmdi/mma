import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { NSelect } from "@/components/primitives/NSelect";
import { Checkbox } from "@/components/primitives/Checkbox";
import { renameMap, updateMapLabels } from "@/store/useMapStore";
import {
	useMapList,
	createMap,
	deleteMap,
	renameFolder,
	deleteFolder,
	moveMapToFolder,
	invalidateMapList,
} from "@/store/mapList";
import { openMapWindow } from "@/lib/window";
import { log, fireAndForget } from "@/lib/util/log";
import { cmpVersion } from "@/lib/util/util";
import { appVersion } from "@/lib/version";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openDialog as openAppDialog } from "@/store/dialogBus";
import { cmd } from "@/lib/commands";
import { mmaBufUrl, downloadBlob } from "@/lib/util/util";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Dialog, DialogContent, useCloseDialog } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import {
	mdiChevronDown,
	mdiChevronRight,
	mdiPencil,
	mdiFolder,
	mdiDelete,
	mdiPlus,
	mdiTextSearch,
	mdiFolderRemove,
	mdiDragVertical,
	mdiClose,
	mdiImport,
	mdiExport,
} from "@mdi/js";
import clsx from "clsx";
import type { SortMode } from "@/types";
import { events, type MapMeta } from "@/bindings.gen";
import { fmt, relativeTime, shortDateFmt } from "@/lib/util/format";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { useSetting, setSetting, getSettings, type MapListField } from "@/store/settings";
import { ColorPicker } from "@/components/primitives/ColorPicker";
import { labelColor, rgbToHex, hexToRgb, textColorFor } from "@/lib/util/color";
import { toast, progressToast } from "@/lib/util/toast";
import { parseMapQuery, mapMatchesQuery, toggleLabelInQuery } from "./mapQuery";
import { t, msg } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";
import { UnreadReplyDot } from "@/components/dialogs/SettingsPage";
import { TextInput } from "@/components/primitives/TextInput";

// --- What's new (latest release notes) ---

interface ChangelogSection {
	tag: string;
	heading: string;
	body: string;
}

// Split the changelog into per-version sections. A version starts at a `## vX...`
// heading; headings inside a body (e.g. `## What's new`) are left untouched.
function parseChangelog(md: string): ChangelogSection[] {
	const sections: ChangelogSection[] = [];
	let cur: ChangelogSection | null = null;
	for (const line of md.split(/\r?\n/)) {
		const m = /^##\s+(v\d\S*)\s*(.*)$/.exec(line);
		if (m) {
			if (cur) sections.push(cur);
			cur = { tag: m[1], heading: line.replace(/^##\s+/, "").trim(), body: "" };
		} else if (cur) {
			cur.body += line + "\n";
		}
	}
	if (cur) sections.push(cur);
	return sections;
}

// Inline markdown: **bold**, *italic*, `code`, [text](url).
function renderInline(text: string, kb: string): React.ReactNode[] {
	const nodes: React.ReactNode[] = [];
	const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
	let last = 0;
	let i = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (m.index > last) nodes.push(text.slice(last, m.index));
		const k = `${kb}-${i++}`;
		if (m[1]) nodes.push(<strong key={k}>{m[1]}</strong>);
		else if (m[2]) nodes.push(<em key={k}>{m[2]}</em>);
		else if (m[3]) nodes.push(<code key={k}>{m[3]}</code>);
		else
			nodes.push(
				<a key={k} href={m[5]} target="_blank" rel="noopener noreferrer">
					{m[4]}
				</a>,
			);
		last = re.lastIndex;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

// Block-level markdown for changelog bodies: headings, bullet lists, paragraphs.
function renderMarkdown(md: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	let list: React.ReactNode[] | null = null;
	let para: string[] = [];
	let key = 0;
	const flushPara = () => {
		if (para.length) {
			out.push(<p key={`b${key++}`}>{renderInline(para.join(" "), `b${key}`)}</p>);
			para = [];
		}
	};
	const flushList = () => {
		if (list) {
			out.push(<ul key={`b${key++}`}>{list}</ul>);
			list = null;
		}
	};
	for (const raw of md.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			out.push(<h4 key={`b${key++}`}>{renderInline(heading[1], `b${key}`)}</h4>);
		} else if (bullet) {
			flushPara();
			(list ??= []).push(<li key={`b${key++}`}>{renderInline(bullet[1], `b${key}`)}</li>);
		} else if (line === "") {
			flushPara();
			flushList();
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return out;
}

let changelogPromise: Promise<ChangelogSection[] | null> | null = null;

function fetchChangelog(): Promise<ChangelogSection[] | null> {
	if (!changelogPromise) {
		changelogPromise = fetch("https://raw.githubusercontent.com/ccmdi/mma/master/CHANGELOG.md")
			.then((r) => (r.ok ? r.text() : null))
			.then((md) => {
				if (!md) return null;
				const sections = parseChangelog(md);
				return sections.length ? sections : null;
			})
			.catch((e) => {
				log.warn("Failed to fetch changelog", e);
				return null;
			});
	}
	return changelogPromise;
}

// One character cell of the version readout. When its character changes it rolls
// the old one out and the new one in, like a safe dial. Digits roll by value
// (higher rolls up, lower rolls down); other characters default to rolling up.
function RollChar({ ch }: { ch: string }) {
	const prevRef = useRef(ch);
	const [state, setState] = useState<{ cur: string; out: string | null; dir: "up" | "down" }>({
		cur: ch,
		out: null,
		dir: "up",
	});

	useEffect(() => {
		const from = prevRef.current;
		if (ch === from) return;
		prevRef.current = ch;
		const dir =
			/\d/.test(ch) && /\d/.test(from) ? (Number(ch) > Number(from) ? "up" : "down") : "up";
		setState({ cur: ch, out: from, dir });
		const t = setTimeout(() => setState((s) => ({ ...s, out: null })), 280);
		return () => clearTimeout(t);
	}, [ch]);

	const rolling = state.out !== null;
	return (
		<span className="roll-cell">
			<span
				key={`in-${state.cur}`}
				className={clsx("roll-char", rolling && `roll-enter-${state.dir}`)}
			>
				{state.cur}
			</span>
			{rolling && (
				<span
					key={`out-${state.out}`}
					className={clsx("roll-char roll-char--out", `roll-exit-${state.dir}`)}
				>
					{state.out}
				</span>
			)}
		</span>
	);
}

function WhatsNew() {
	const [versions, setVersions] = useState<ChangelogSection[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [activeTag, setActiveTag] = useState<string | null>(null);
	const historyRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		fetchChangelog().then((v) => {
			if (!alive) return;
			if (v) setVersions(v);
			else setFailed(true);
		});
		return () => {
			alive = false;
		};
	}, []);

	// Track which release is at the top of the scroll viewport.
	const onScroll = () => {
		const container = historyRef.current;
		if (!container) return;
		const cTop = container.getBoundingClientRect().top;
		let current: string | null = null;
		for (const r of container.querySelectorAll<HTMLElement>(".updates__release")) {
			if (r.getBoundingClientRect().top - cTop <= 8) current = r.dataset.tag ?? null;
			else break;
		}
		setActiveTag(current);
	};

	if (failed) return null;

	const displayTag = activeTag ?? versions?.[0]?.tag ?? null;
	const installed = appVersion();
	const isUnreleased = (tag: string) =>
		installed ? cmpVersion(tag.replace(/^v/, ""), installed) > 0 : false;

	return (
		<li className="updates__item updates__item--new">
			<span className="updates__circle" />
			<time className="updates__time">
				{t("What's new")}
				{displayTag && (
					<>
						<span className="updates__version-sep">·</span>
						<span className="updates__version-roll">
							{[...displayTag].map((c, i) => (
								<RollChar key={i} ch={c} />
							))}
						</span>
					</>
				)}
			</time>
			<div className={clsx("updates__skeleton", versions && "updates__skeleton--hidden")}>
				<span />
				<span />
				<span />
			</div>
			<div className={clsx("updates__notes", versions && "updates__notes--open")}>
				<div>
					<div className="updates__history" ref={historyRef} onScroll={onScroll}>
						{versions?.map((v, vi) => (
							<div
								key={v.tag}
								className={clsx(
									"updates__release",
									isUnreleased(v.tag) && "updates__release--unreleased",
								)}
								data-tag={v.tag}
							>
								{vi > 0 && <time className="updates__release-tag">{v.heading}</time>}
								<div className="updates__release-body">{renderMarkdown(v.body)}</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</li>
	);
}

// --- Drag types ---

interface DragItem {
	id: string;
	folder: string | null;
	name: string;
}

// false = no target, null = root, string = folder name
type DropTarget = string | null | false;

function hitTestDropTarget(x: number, y: number): DropTarget {
	const els = document.elementsFromPoint(x, y);
	for (const el of els) {
		if (el instanceof HTMLElement && el.dataset.dropFolder !== undefined) {
			const raw = el.dataset.dropFolder;
			return raw === "" ? null : raw;
		}
	}
	return false;
}

// --- Subcomponents ---

function RenameForm({
	name,
	onRename,
}: {
	name: string;
	onRename?: (from: string, to: string) => void;
}) {
	const close = useCloseDialog();
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				const val = new FormData(e.currentTarget).get("name");
				if (typeof val === "string" && val.trim() !== "") {
					const to = val.trim();
					onRename?.(name, to);
					renameFolder(name, to).finally(close);
				}
			}}
		>
			<p>
				<TextInput
					type="text"
					name="name"
					defaultValue={name}
					minLength={1}
					maxLength={100}
					autoFocus
				/>
			</p>
			<div className="edit-map-modal__actions">
				<button type="submit" className="button button--primary">
					{t("Save")}
				</button>
			</div>
		</form>
	);
}

function MapEditForm({ id, name, labels }: { id: string; name: string; labels: string[] }) {
	const close = useCloseDialog();
	const labelColors = useSetting("labelColors");
	const [currentLabels, setCurrentLabels] = useState(labels);
	const [labelInput, setLabelInput] = useState("");

	const setLabelColor = (label: string, hex: string) =>
		setSetting("labelColors", { ...getSettings().labelColors, [label.toLowerCase()]: hex });

	const addLabel = () => {
		const val = labelInput.trim().toLowerCase();
		if (val && !currentLabels.includes(val)) {
			setCurrentLabels([...currentLabels, val]);
		}
		setLabelInput("");
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				const val = new FormData(e.currentTarget).get("name");
				if (typeof val === "string" && val.trim() !== "") {
					Promise.all([renameMap(id, val.trim()), updateMapLabels(id, currentLabels)]).finally(
						close,
					);
				}
			}}
		>
			<p>
				<TextInput
					type="text"
					name="name"
					defaultValue={name}
					minLength={1}
					maxLength={100}
					autoFocus
				/>
			</p>
			<div className="map-edit-labels">
				<div className="map-edit-labels__label">{t("Labels")}</div>
				<div className="map-edit-labels__list">
					{currentLabels.map((l) => {
						return (
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
									onClick={() => setCurrentLabels(currentLabels.filter((x) => x !== l))}
								>
									<Icon path={mdiClose} size={12} />
								</button>
							</span>
						);
					})}
					<input
						type="text"
						className="map-edit-labels__input"
						placeholder={t("Add label...")}
						value={labelInput}
						onChange={(e) => setLabelInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								addLabel();
							}
							if (e.key === "Backspace" && !labelInput && currentLabels.length > 0) {
								setCurrentLabels(currentLabels.slice(0, -1));
							}
						}}
					/>
				</div>
			</div>
			<div className="edit-map-modal__actions">
				<button type="submit" className="button button--primary">
					{t("Save")}
				</button>
			</div>
		</form>
	);
}

interface MapAction {
	type: "edit" | "delete";
	id: string;
	name: string;
	labels: string[];
}

const FIELD_RENDERERS: Record<MapListField, (meta: MapMeta) => React.ReactNode> = {
	locationCount: (meta) => (
		<>{t({ one: "{n} location", other: "{n} locations" }, { n: meta.locationCount })}</>
	),
	lastOpened: (meta) =>
		meta.lastOpenedAt ? <>{t("opened {when}", { when: relativeTime(meta.lastOpenedAt) })}</> : null,
	created: (meta) => <>{shortDateFmt.format(new Date(meta.createdAt))}</>,
};

const MapEntry = React.memo(function MapEntry({
	meta,
	isDragging,
	onDragStart,
	onAction,
	onLabelClick,
	fields,
}: {
	meta: MapMeta;
	isDragging: boolean;
	onDragStart: (item: DragItem, e: React.PointerEvent) => void;
	onAction: (action: MapAction) => void;
	onLabelClick: (label: string) => void;
	fields: MapListField[];
}) {
	const labelColors = useSetting("labelColors");
	const metaParts: React.ReactNode[] = [];
	for (const f of fields) {
		const node = FIELD_RENDERERS[f](meta);
		if (node) metaParts.push(<React.Fragment key={f}>{node}</React.Fragment>);
	}

	return (
		<li
			className={clsx("map-list__entry", isDragging && "is-dragging")}
			style={isDragging ? { opacity: 0.4 } : undefined}
			data-filter-name={meta.name.toLowerCase()}
			data-filter-labels={meta.labels.join("\n")}
		>
			<button
				className="map-list__drag-handle icon-button"
				style={{ color: "rgba(255, 255, 255, 0.7)" }}
				draggable={false}
				onPointerDown={(e) => {
					if (e.button !== 0) return;
					e.preventDefault();
					onDragStart({ id: meta.id, folder: meta.folder, name: meta.name || "(unnamed)" }, e);
				}}
			>
				<Icon path={mdiDragVertical} />
			</button>
			<a
				href="#"
				className="map-link"
				onClick={(e) => {
					e.preventDefault();
					openMapWindow(meta.id, meta.name);
				}}
			>
				{meta.name || t("(unnamed)")}
			</a>
			{metaParts.length > 0 && (
				<span className="map-list__meta">
					{metaParts.map((part, i) => (
						<React.Fragment key={i}>
							{i > 0 && " · "}
							{part}
						</React.Fragment>
					))}
				</span>
			)}
			{meta.labels.map((l) => {
				const hex = labelColor(l, labelColors);
				return (
					<span
						key={l}
						className="map-label map-label--inline"
						style={{ backgroundColor: hex, color: textColorFor(hex), cursor: "pointer" }}
						title={t("Filter by this label")}
						onClick={() => onLabelClick(l)}
					>
						{l}
					</span>
				);
			})}
			<button
				className="map-list__edit icon-button"
				aria-label={t("Edit map")}
				onClick={() =>
					onAction({ type: "edit", id: meta.id, name: meta.name, labels: meta.labels })
				}
			>
				<Icon path={mdiPencil} />
			</button>
			<button
				className="map-list__edit icon-button"
				aria-label={t("Delete map")}
				onClick={() => onAction({ type: "delete", id: meta.id, name: meta.name, labels: [] })}
			>
				<Icon path={mdiDelete} />
			</button>
		</li>
	);
});

interface FolderAction {
	type: "rename-folder" | "delete-folder";
	name: string;
	mapCount: number;
}

const FolderEntry = React.memo(function FolderEntry({
	name,
	maps,
	dragId,
	onDragStart,
	onMapAction,
	onFolderAction,
	onLabelClick,
	fields,
	searching,
}: {
	name: string;
	maps: MapMeta[];
	dragId: string | null;
	onDragStart: (item: DragItem, e: React.PointerEvent) => void;
	onMapAction: (action: MapAction) => void;
	onFolderAction: (action: FolderAction) => void;
	onLabelClick: (label: string) => void;
	fields: MapListField[];
	searching: boolean;
}) {
	const triggerId = `folder:${name}-trig`;
	const [collapsed, setCollapsed] = useLocalStorage<string[]>("collapsedFolders", []);
	// A search reaches into closed folders: the entries have to be mounted for the filter to
	// find them, and a folder with no match is hidden wholesale below.
	const open = searching || !collapsed.includes(name);
	const setOpen = (v: boolean) => {
		if (searching) return;
		setCollapsed((prev) => (v ? prev.filter((f) => f !== name) : [...prev, name]));
	};
	const count = useMemo(() => maps.reduce((a, m) => a + m.locationCount, 0), [maps]);

	return (
		<Collapsible.Root asChild open={open} onOpenChange={setOpen}>
			<li className="map-folder" data-drop-folder={name} data-filter-folder>
				<div className="map-folder__head">
					<Collapsible.Trigger
						id={triggerId}
						className="icon-button"
						style={{ display: "inline-block" }}
						aria-label={t("Open or close folder")}
					>
						<Icon path={open ? mdiChevronDown : mdiChevronRight} />
					</Collapsible.Trigger>
					<label htmlFor={triggerId}>
						<strong>{name}</strong>
						<span className="map-list__folder-count">
							{" "}
							·{" "}
							{t("{maps} maps · {locations} locations", {
								maps: fmt.format(maps.length),
								locations: fmt.format(count),
							})}
						</span>
					</label>
					<button
						className="map-list__edit icon-button"
						aria-label={t("Rename folder")}
						onClick={() => onFolderAction({ type: "rename-folder", name, mapCount: maps.length })}
					>
						<Icon path={mdiPencil} />
					</button>
					<button
						className="map-list__edit icon-button"
						aria-label={t("Delete folder")}
						onClick={() => onFolderAction({ type: "delete-folder", name, mapCount: maps.length })}
					>
						<Icon path={mdiFolderRemove} />
					</button>
				</div>
				<Collapsible.Content asChild>
					<ul className="map-sublist">
						{maps.map((m) => (
							<MapEntry
								key={m.id}
								meta={m}
								isDragging={dragId === m.id}
								onDragStart={onDragStart}
								onAction={onMapAction}
								onLabelClick={onLabelClick}
								fields={fields}
							/>
						))}
					</ul>
				</Collapsible.Content>
			</li>
		</Collapsible.Root>
	);
});

// --- Bulk import/export ---

interface ImportEntry {
	name: string;
	folder: string | null;
	locationCount: number;
	tagCount: number;
	isDuplicate: boolean;
	selected: boolean;
	srcPath: string;
	localIndex: number;
}

interface ImportPreview {
	entries: ImportEntry[];
	warnings: string[];
}

async function applyFolderFiles(paths: string[], maps: MapMeta[]) {
	const byName = new Map(maps.map((m) => [m.name, m]));
	let applied = 0;
	let skipped = 0;

	for (const path of paths) {
		let mapping: Record<string, string>;
		try {
			mapping = JSON.parse(await cmd.readFile(path));
		} catch (e) {
			log.error("[folder import] failed to read", path, e);
			continue;
		}
		for (const [mapName, folder] of Object.entries(mapping)) {
			const map = byName.get(mapName);
			if (!map) {
				skipped++;
				continue;
			}
			if (map.folder === folder) continue;
			await moveMapToFolder(map.id, folder);
			applied++;
		}
	}

	const parts = [];
	if (applied > 0)
		parts.push(
			t(
				{ one: "{n} map assigned to folders", other: "{n} maps assigned to folders" },
				{ n: applied },
			),
		);
	if (skipped > 0) parts.push(t("{n} not found locally", { n: skipped }));
	if (parts.length > 0) toast(parts.join(", "));
}

function ImportPreviewModal({
	preview,
	onConfirm,
	onClose,
}: {
	preview: ImportPreview;
	onConfirm: (selectedIndices: number[]) => void;
	onClose: () => void;
}) {
	const [entries, setEntries] = useState(preview.entries);
	const selectedCount = entries.filter((e) => e.selected).length;
	const totalLocs = entries.reduce((a, e) => a + (e.selected ? e.locationCount : 0), 0);

	const toggle = (i: number) => {
		setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, selected: !e.selected } : e)));
	};

	const selectAll = () => setEntries((prev) => prev.map((e) => ({ ...e, selected: true })));
	const selectNone = () => setEntries((prev) => prev.map((e) => ({ ...e, selected: false })));
	const selectNew = () =>
		setEntries((prev) => prev.map((e) => ({ ...e, selected: !e.isDuplicate })));

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title={t("Import Maps")} className="import-preview-modal">
				<div className="import-preview__actions">
					<button className="button" onClick={selectAll}>
						{t("All")}
					</button>
					<button className="button" onClick={selectNone}>
						{t("None")}
					</button>
					<button className="button" onClick={selectNew}>
						{t("New only")}
					</button>
					<span className="import-preview__summary">
						{t("{selected} of {total} selected ({locations} locations)", {
							selected: selectedCount,
							total: entries.length,
							locations: fmt.format(totalLocs),
						})}
					</span>
				</div>

				<ul className="import-preview__list">
					{entries.map((entry, i) => (
						<li
							key={i}
							className={clsx(
								"import-preview__item",
								entry.isDuplicate && "import-preview__item--dup",
							)}
							onClick={() => toggle(i)}
						>
							<Checkbox checked={entry.selected} readOnly />
							<span className="import-preview__name">{entry.name}</span>
							<span className="import-preview__meta">
								{t({ one: "{n} loc", other: "{n} loc" }, { n: entry.locationCount })}
								{entry.tagCount > 0 &&
									t({ one: ", {n} tag", other: ", {n} tags" }, { n: entry.tagCount })}
								{entry.folder && ` [${entry.folder}]`}
							</span>
							{entry.isDuplicate && <span className="import-preview__badge">{t("duplicate")}</span>}
						</li>
					))}
				</ul>

				{preview.warnings.length > 0 && (
					<details className="import-preview__warnings">
						<summary>
							{t({ one: "{n} warning", other: "{n} warnings" }, { n: preview.warnings.length })}
						</summary>
						<ul>
							{preview.warnings.map((w, i) => (
								<li key={i}>{w}</li>
							))}
						</ul>
					</details>
				)}

				<div className="import-preview__footer">
					<button className="button" onClick={onClose}>
						{t("Cancel")}
					</button>
					<button
						className="button button--primary"
						disabled={selectedCount === 0}
						onClick={() => {
							const indices = entries.map((e, i) => (e.selected ? i : -1)).filter((i) => i >= 0);
							onConfirm(indices);
						}}
					>
						{t({ one: "Import {n} map", other: "Import {n} maps" }, { n: selectedCount })}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function BulkActions() {
	const maps = useMapList();
	const [exporting, setExporting] = useState(false);
	const [importing, setImporting] = useState(false);
	const [parseStatus, setParseStatus] = useState<string | null>(null);
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const importEntriesRef = useRef<ImportEntry[] | null>(null);

	const handleExport = useCallback(async () => {
		setExporting(true);
		const progress = progressToast(t("Exporting maps..."));
		const unlisten = await events.bulkExportProgress.listen((e) =>
			progress.update(
				e.payload.current / e.payload.total,
				`${e.payload.current} / ${e.payload.total}`,
			),
		);
		try {
			const path = await cmd.storeExportBulkZip();
			const res = await fetch(mmaBufUrl(path));
			downloadBlob(await res.blob(), `mma-backup-${new Date().toISOString().slice(0, 10)}.zip`);
			progress.finish(t("Export saved"));
		} catch {
			progress.finish();
		} finally {
			unlisten();
			setExporting(false);
		}
	}, []);

	const handleImport = useCallback(async () => {
		const selection = await openDialog({
			multiple: true,
			filters: [{ name: t("Map data"), extensions: ["json", "zip", "mmafolders"] }],
		});
		if (!selection) return;
		const paths = Array.isArray(selection) ? selection : [selection];

		const folderFiles = paths.filter((p) => p.endsWith(".mmafolders"));
		const mapFiles = paths.filter((p) => !p.endsWith(".mmafolders"));

		if (folderFiles.length > 0) {
			await applyFolderFiles(folderFiles, maps);
		}
		if (mapFiles.length === 0) return;

		setParseStatus(mapFiles.length > 1 ? t("Scanning files...") : t("Scanning file..."));
		try {
			const aggregated: ImportEntry[] = [];
			const warnings: string[] = [];
			for (const path of mapFiles) {
				const entries = await cmd.bulkImportPreview(path);
				entries.forEach((e, localIndex) => {
					const isDuplicate = maps.some(
						(existing) => existing.name === e.name && existing.locationCount === e.locationCount,
					);
					aggregated.push({
						name: e.name,
						folder: e.folder,
						locationCount: e.locationCount,
						tagCount: e.tagCount,
						isDuplicate,
						selected: !isDuplicate,
						srcPath: path,
						localIndex,
					});
					warnings.push(...e.warnings);
				});
			}

			if (aggregated.length === 0) {
				log.warn("[bulk import] no maps found");
				setParseStatus(null);
				return;
			}

			importEntriesRef.current = aggregated;
			setPreview({ entries: aggregated, warnings });
		} catch (e) {
			log.error("[bulk import] preview failed:", e);
		} finally {
			setParseStatus(null);
		}
	}, [maps]);

	const handleConfirm = useCallback(async (indices: number[]) => {
		const all = importEntriesRef.current;
		if (!all) return;

		// Map each selected aggregated index back to its source file + that file's local index.
		const byPath = new Map<string, number[]>();
		for (const i of indices) {
			const entry = all[i];
			if (!entry) continue;
			const arr = byPath.get(entry.srcPath) ?? [];
			arr.push(entry.localIndex);
			byPath.set(entry.srcPath, arr);
		}
		if (byPath.size === 0) return;

		setImporting(true);
		setPreview(null);
		const total = indices.length;
		let base = 0; // maps confirmed in prior files, for global progress across the per-file loop
		const progress = progressToast(t("Importing maps..."));
		const unlisten = await events.bulkImportProgress.listen((e) =>
			progress.update((base + e.payload.current) / total, `${base + e.payload.current} / ${total}`),
		);
		let failed = 0;
		try {
			for (const [path, localIndices] of byPath) {
				try {
					await cmd.bulkImportConfirm(path, localIndices);
				} catch (e) {
					failed += localIndices.length;
					log.error("[bulk import] confirm failed for", path, e);
				}
				base += localIndices.length;
			}
			await invalidateMapList();
			progress.finish(
				failed
					? t("Imported {imported}, {failed} failed", { imported: total - failed, failed })
					: t("Import complete"),
			);
		} catch (e) {
			log.error("[bulk import] confirm failed:", e);
			progress.finish();
		} finally {
			unlisten();
			setImporting(false);
			importEntriesRef.current = null;
		}
	}, []);

	return (
		<>
			<button
				className="settings-gear"
				onClick={handleExport}
				disabled={exporting}
				title={exporting ? t("Exporting...") : t("Export all maps")}
			>
				<Icon path={mdiExport} />
			</button>
			<button
				className="settings-gear"
				onClick={handleImport}
				disabled={importing || parseStatus !== null}
				title={parseStatus ?? (importing ? t("Importing...") : t("Import maps"))}
			>
				<Icon path={mdiImport} />
			</button>
			{preview && (
				<ImportPreviewModal
					preview={preview}
					onConfirm={handleConfirm}
					onClose={() => {
						fireAndForget(cmd.bulkImportCancel(), "bulkImportCancel");
						setPreview(null);
						importEntriesRef.current = null;
					}}
				/>
			)}
		</>
	);
}

// --- Sorting ---

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
	{ value: "name", label: msg("Name") },
	{ value: "opened", label: msg("Last opened") },
	{ value: "created", label: msg("Date created") },
	{ value: "amount", label: msg("Location count") },
];

function sortMaps(maps: MapMeta[], mode: SortMode): MapMeta[] {
	const sorted = [...maps];
	switch (mode) {
		case "name":
			return sorted.sort((a, b) => a.name.localeCompare(b.name));
		case "opened":
			return sorted.sort((a, b) => {
				const at = a.lastOpenedAt ?? "";
				const bt = b.lastOpenedAt ?? "";
				if (!at && bt) return 1;
				if (at && !bt) return -1;
				return at > bt ? -1 : at < bt ? 1 : 0;
			});
		case "created":
			return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		case "amount":
			return sorted.sort((a, b) => b.locationCount - a.locationCount);
	}
}

// --- Main ---

function applyFilter(listEl: HTMLElement | null, query: string) {
	if (!listEl) return;
	const entries = listEl.querySelectorAll<HTMLElement>("[data-filter-name]");
	const folders = listEl.querySelectorAll<HTMLElement>("[data-filter-folder]");
	const q = parseMapQuery(query);
	if (q.text.length === 0 && q.labels.length === 0) {
		for (const el of entries) el.hidden = false;
		for (const el of folders) el.hidden = false;
	} else {
		for (const el of entries) {
			const labels = (el.dataset.filterLabels ?? "").split("\n").filter(Boolean);
			el.hidden = !mapMatchesQuery(el.dataset.filterName!, labels, q);
		}
		for (const el of folders) {
			const hasVisible = el.querySelector<HTMLElement>("[data-filter-name]:not([hidden])") !== null;
			el.hidden = !hasVisible;
		}
	}
}

export function MapList() {
	const maps = useMapList();
	const [sortMode, setSortMode] = useLocalStorage<SortMode>("mapListSort", "name");
	const [syntheticFolders, setSyntheticFolders] = useState<string[]>([]);
	const [dragItem, setDragItem] = useState<DragItem | null>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const dropRef = useRef<DropTarget>(false);
	const prevHighlight = useRef<HTMLElement | null>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const filterRef = useRef("");
	const filterInputRef = useRef<HTMLInputElement>(null);
	const [hasFilter, setHasFilter] = useState(false);
	const mapListFields = useSetting("mapListFields");

	const clearFilter = useCallback(() => {
		if (filterInputRef.current) filterInputRef.current.value = "";
		filterRef.current = "";
		setHasFilter(false);
		applyFilter(listRef.current, "");
		filterInputRef.current?.focus();
	}, []);

	const toggleLabelFilter = useCallback((label: string) => {
		const input = filterInputRef.current;
		if (!input) return;
		input.value = toggleLabelInQuery(input.value, label);
		filterRef.current = input.value.toLowerCase();
		setHasFilter(input.value.length > 0);
		applyFilter(listRef.current, filterRef.current);
	}, []);

	useEffect(() => {
		if (filterRef.current) applyFilter(listRef.current, filterRef.current);
	}, [maps]);

	const grouped = useMemo(() => {
		const folders = new Map<string | null, MapMeta[]>();
		folders.set(null, []);
		for (const sf of syntheticFolders) {
			if (!folders.has(sf)) folders.set(sf, []);
		}
		for (const m of maps) {
			const key = m.folder;
			if (!folders.has(key)) folders.set(key, []);
			folders.get(key)!.push(m);
		}
		return folders;
	}, [maps, syntheticFolders]);

	const folderEntries = useMemo(
		(): [string, MapMeta[]][] =>
			[...grouped.entries()]
				.filter((e): e is [string, MapMeta[]] => e[0] !== null)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, sortMaps(v, sortMode)]),
		[grouped, sortMode],
	);
	const rootMaps = useMemo(() => sortMaps(grouped.get(null) ?? [], sortMode), [grouped, sortMode]);

	const [activeAction, setActiveAction] = useState<(MapAction | FolderAction) | null>(null);

	const handleMapAction = useCallback((action: MapAction) => setActiveAction(action), []);
	const handleFolderAction = useCallback((action: FolderAction) => setActiveAction(action), []);

	const handleDragStart = useCallback((item: DragItem, e: React.PointerEvent) => {
		setDragItem(item);
		document.body.style.userSelect = "none";

		if (previewRef.current) {
			previewRef.current.style.left = `${e.clientX + 12}px`;
			previewRef.current.style.top = `${e.clientY - 12}px`;
		}

		const onMove = (ev: PointerEvent) => {
			if (previewRef.current) {
				previewRef.current.style.left = `${ev.clientX + 12}px`;
				previewRef.current.style.top = `${ev.clientY - 12}px`;
			}

			const target = hitTestDropTarget(ev.clientX, ev.clientY);
			dropRef.current = target;

			if (prevHighlight.current) {
				prevHighlight.current.classList.remove("map-list__drop");
				prevHighlight.current = null;
			}

			if (target !== false && target !== item.folder) {
				const selector =
					target === null ? "[data-drop-folder='']" : `[data-drop-folder='${CSS.escape(target)}']`;
				const el = document.querySelector<HTMLElement>(selector);
				if (el) {
					el.classList.add("map-list__drop");
					prevHighlight.current = el;
				}
			}
		};

		const onUp = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.body.style.userSelect = "";

			if (prevHighlight.current) {
				prevHighlight.current.classList.remove("map-list__drop");
				prevHighlight.current = null;
			}

			const target = dropRef.current;
			if (target !== false && target !== item.folder) {
				moveMapToFolder(item.id, target);
			}
			dropRef.current = false;
			setDragItem(null);
		};

		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	}, []);

	return (
		<div className="page-map-list">
			<section>
				<h2>
					{t("Your Maps")}{" "}
					<span style={{ color: "#fff8", fontWeight: "normal", fontSize: "0.75em" }}>
						({t({ one: "{n} map", other: "{n} maps" }, { n: maps.length })},{" "}
						{t(
							{ one: "{n} location", other: "{n} locations" },
							{ n: maps.reduce((a, m) => a + m.locationCount, 0) },
						)}
						)
					</span>
				</h2>

				<p style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
					<span
						style={{
							display: "inline-block",
							width: "2rem",
							textAlign: "center",
						}}
					>
						<Icon path={mdiTextSearch} />
					</span>
					<span style={{ position: "relative", flexGrow: 1, display: "flex" }}>
						<TextInput
							defaultValue=""
							ref={filterInputRef}
							onChange={(e) => {
								filterRef.current = e.target.value.toLowerCase();
								setHasFilter(e.target.value.length > 0);
								applyFilter(listRef.current, filterRef.current);
							}}
							onKeyDown={(e) => {
								if (e.key === "Escape" && filterInputRef.current?.value) {
									e.preventDefault();
									clearFilter();
									return;
								}
								if (e.key !== "Enter") return;
								e.preventDefault();
								const name = filterInputRef.current?.value.trim();
								if (!name) return;
								const entries = listRef.current?.querySelectorAll<HTMLElement>(
									"[data-filter-name]:not([hidden])",
								);
								const exact = entries
									? [...entries].find((el) => el.dataset.filterName === name.toLowerCase())
									: undefined;
								if (exact) {
									exact.querySelector<HTMLAnchorElement>(".map-link")?.click();
									return;
								}
								createMap(name).then((m) => openMapWindow(m.id, m.name));
							}}
							type="text"
							placeholder={t("Search maps...")}
							title={t('Filter by name, or by label with label:name / label:"two words"')}
							style={{ flexGrow: 1, paddingRight: hasFilter ? "1.75rem" : undefined }}
							autoFocus
						/>
						{hasFilter && (
							<button
								type="button"
								className="icon-button"
								aria-label={t("Clear search")}
								onClick={clearFilter}
								style={{
									position: "absolute",
									right: "0.25rem",
									top: "50%",
									transform: "translateY(-50%)",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									lineHeight: 0,
									padding: 2,
									color: "#888",
								}}
							>
								<Icon path={mdiClose} size={16} />
							</button>
						)}
					</span>
					<NSelect
						className="map-list__sort"
						value={sortMode}
						onChange={(e) => setSortMode(e.target.value as SortMode)}
					>
						{SORT_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{t(o.label)}
							</option>
						))}
					</NSelect>
					<button
						className="icon-button"
						onClick={() => {
							const name = filterInputRef.current?.value.trim();
							if (!name) {
								toast(t("Type a name to create a folder"));
								return;
							}
							setSyntheticFolders((prev) => (prev.includes(name) ? prev : [...prev, name]));
						}}
						aria-label={t("New folder")}
					>
						<Icon path={mdiFolder} />
					</button>
					<button
						className="icon-button"
						onClick={() => {
							const name = filterInputRef.current?.value.trim();
							if (!name) {
								toast(t("Type a name to create a map"));
								return;
							}
							createMap(name);
						}}
						aria-label={t("New map")}
					>
						<Icon path={mdiPlus} />
					</button>
				</p>

				<ul className="map-list" data-drop-folder="" ref={listRef}>
					{folderEntries.map(([name, maps]) => (
						<FolderEntry
							key={name}
							name={name!}
							maps={maps}
							dragId={dragItem?.id ?? null}
							onDragStart={handleDragStart}
							onMapAction={handleMapAction}
							onFolderAction={handleFolderAction}
							onLabelClick={toggleLabelFilter}
							fields={mapListFields}
							searching={hasFilter}
						/>
					))}
					{rootMaps.map((m) => (
						<MapEntry
							key={m.id}
							meta={m}
							isDragging={dragItem?.id === m.id}
							onDragStart={handleDragStart}
							onAction={handleMapAction}
							onLabelClick={toggleLabelFilter}
							fields={mapListFields}
						/>
					))}
					{rootMaps.length === 0 && dragItem && (
						<li className="map-list__entry">{t("drop map here to move out of folder")}</li>
					)}
				</ul>
			</section>
			<section className="updates">
				<ul className="updates__container">
					<li className="updates__item updates__item--warning">
						<span className="updates__circle" />
						<time className="updates__time">{t("Warning")}</time>
						<p>
							<Trans
								msg="This is a work in progress. Report bugs {here}"
								here={
									<>
										{/* The dot sits beside the link, not inside it: the link is underlined. */}
										<button
											type="button"
											className="link-button"
											onClick={() => openAppDialog("feedback")}
										>
											{t("here")}
										</button>
										<UnreadReplyDot />
									</>
								}
							/>
							.
						</p>
					</li>
					<WhatsNew />
				</ul>
			</section>

			<div
				ref={previewRef}
				style={{
					position: "fixed",
					pointerEvents: "none",
					zIndex: 9999,
					padding: "6px 12px",
					background: "var(--sand-3, #333)",
					borderRadius: "4px",
					color: "var(--sand-12, #eee)",
					fontSize: "14px",
					whiteSpace: "nowrap",
					display: dragItem ? "block" : "none",
				}}
			>
				{dragItem?.name}
			</div>
			{activeAction && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setActiveAction(null);
					}}
				>
					<DialogContent
						title={
							activeAction.type === "edit"
								? t("Edit map")
								: activeAction.type === "delete"
									? t("Delete map")
									: activeAction.type === "rename-folder"
										? t("Rename folder")
										: t("Delete folder")
						}
						className="edit-map-modal"
					>
						{activeAction.type === "edit" && (
							<MapEditForm
								id={activeAction.id}
								name={activeAction.name}
								labels={(activeAction as MapAction).labels}
							/>
						)}
						{activeAction.type === "delete" && (
							<>
								<p>{t('Delete "{name}"?', { name: activeAction.name || t("(unnamed)") })}</p>
								<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
									<button className="button" onClick={() => setActiveAction(null)}>
										{t("Cancel")}
									</button>
									<button
										className="button button--destructive"
										onClick={() => {
											deleteMap(activeAction.id);
											setActiveAction(null);
										}}
									>
										{t("Delete")}
									</button>
								</div>
							</>
						)}
						{activeAction.type === "rename-folder" && (
							<RenameForm
								name={activeAction.name}
								onRename={(from, to) =>
									setSyntheticFolders((prev) => prev.map((f) => (f === from ? to : f)))
								}
							/>
						)}
						{activeAction.type === "delete-folder" && (
							<>
								<p>
									{t(
										{
											one: 'Delete folder "{name}"? The {n} map inside will be moved to the root.',
											other:
												'Delete folder "{name}"? The {n} maps inside will be moved to the root.',
										},
										{ name: activeAction.name, n: (activeAction as FolderAction).mapCount },
									)}
								</p>
								<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
									<button className="button" onClick={() => setActiveAction(null)}>
										{t("Cancel")}
									</button>
									<button
										className="button button--destructive"
										onClick={async () => {
											const name = activeAction.name;
											setActiveAction(null);
											setSyntheticFolders((prev) => prev.filter((f) => f !== name));
											await deleteFolder(name);
										}}
									>
										{t("Delete folder")}
									</button>
								</div>
							</>
						)}
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}
