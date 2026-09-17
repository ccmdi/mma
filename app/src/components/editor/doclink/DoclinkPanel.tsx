import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
	mdiPin,
	mdiPinOutline,
	mdiOpenInNew,
	mdiClose,
	mdiRefresh,
	mdiBookOpenVariant,
	mdiBookOpenOutline,
} from "@mdi/js";
import type { Tag } from "@/bindings.gen";
import { useMapState } from "@/store/useMapStore";
import { getSelectedTagIdsDeep } from "@/store/selectionActions";
import {
	parseDoclink,
	loadSection,
	evictDoc,
	doclinkedTags,
	preloadSectionImages,
	type DocSection,
} from "@/lib/doclink";
import { openHref } from "@/lib/map/mapClick";
import { useAsync } from "@/lib/hooks/useAsync";
import { usePointerDrag } from "@/lib/hooks/usePointerDrag";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { clamp, range } from "@/types/util";
import { DocRenderer } from "@/components/editor/doclink/DocRenderer";
import "./doclink.css";
import { t } from "@/lib/i18n";

const WIDTH_RANGE = range([280, 900]);

// The doc's own stylesheet renders inside a shadow root; these overrides keep
// oversized doc layout (fixed pt widths, inline img dims) inside the panel.
const OVERRIDE_CSS = `
:host { display: block; }
.doclink-doc { background: #fff; color: #000; padding: 0.75rem 1rem; word-break: break-word; }
.doclink-doc img { max-width: 100% !important; height: auto !important; }
.doclink-doc table { max-width: 100%; }
`;

function ShadowHtml({ css, html }: { css: string; html: string }) {
	const hostRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = hostRef.current;
		if (!el) return;
		const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
		// Sanitized by the doclink provider (scripts/handlers stripped); shadow root isolates the doc CSS.
		// eslint-disable-next-line no-restricted-syntax
		root.innerHTML = `<style>${css}</style><style>${OVERRIDE_CSS}</style><div class="doclink-doc">${html}</div>`;
	}, [css, html]);

	const onClick = useCallback((e: React.MouseEvent) => {
		const a = e.nativeEvent
			.composedPath()
			.find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && !!n.href);
		if (!a) return;
		e.preventDefault();
		void openHref(a.href);
	}, []);

	return <div ref={hostRef} onClick={onClick} />;
}

export interface DoclinkPanelProps {
	width: number;
	onWidthChange: (w: number) => void;
	onClose: () => void;
}

export function DoclinkPanel({ width, onWidthChange, onClose }: DoclinkPanelProps) {
	const tagMap = useMapState((s) => s.tags);
	const selectedTagIds = useMapState(getSelectedTagIdsDeep);
	const tags: Tag[] = doclinkedTags(tagMap);
	const [pinned, setPinned] = useState(false);
	const [sel, setSel] = useState<{ tagId: number; idx: number } | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	// Follow tag selections: the newest selected tag with doclinks wins; keep the
	// current one while it stays selected.
	const candidates = selectedTagIds.filter((id) => (tagMap[id]?.doclinks?.length ?? 0) > 0);
	const candidateKey = candidates.join(",");
	useEffect(() => {
		if (pinned || candidates.length === 0) return;
		setSel((prev) =>
			prev && candidates.includes(prev.tagId)
				? prev
				: { tagId: candidates[candidates.length - 1], idx: 0 },
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [candidateKey, pinned]);

	const selTag = tags.find((t) => t.id === sel?.tagId);
	const links = selTag?.doclinks ?? [];
	const idx = clamp(sel?.idx ?? 0, 0, Math.max(0, links.length - 1));
	const url: string | undefined = links[idx];
	const docRef = url ? parseDoclink(url) : null;

	// Whole-document mode: same doc, no anchor slice; scrolled to the linked
	// section. Per-link, so it resets when the shown link changes.
	const [wholeDoc, setWholeDoc] = useState(false);
	useEffect(() => setWholeDoc(false), [url]);
	const loadRef = wholeDoc && docRef ? { ...docRef, anchor: null } : docRef;

	// Forced re-fetch: evict the doc's cached HTML, then bump the nonce to re-run the load.
	const [refreshNonce, setRefreshNonce] = useState(0);
	const onRefresh = useCallback(() => {
		if (docRef) evictDoc(docRef);
		setRefreshNonce((n) => n + 1);
	}, [docRef]);

	const {
		data: section,
		loading,
		error,
	} = useAsync(
		() => (loadRef ? loadSection(loadRef).then(preloadSectionImages) : null),
		[url, refreshNonce, wholeDoc],
	);
	// Keep the previous section on screen while the next one loads (no blank flash);
	// a small spinner overlays until the swap.
	const lastSectionRef = useRef<DocSection | null>(null);
	if (section) lastSectionRef.current = section;
	const shown = section ?? (loading ? lastSectionRef.current : null);
	const bodyRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (!section || !body) return;
		const anchor = wholeDoc ? docRef?.anchor : null;
		const target = anchor ? body.querySelector(`#${CSS.escape(anchor)}`) : null;
		body.scrollTop = target
			? body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top
			: 0;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [section]);

	const onResizeDown = usePointerDrag(() => ({
		onMove: (ev) => {
			const rect = panelRef.current?.getBoundingClientRect();
			if (rect) onWidthChange(Math.round(clamp(rect.right - ev.clientX, WIDTH_RANGE)));
		},
	}));

	const title = shown?.docTitle ?? selTag?.name ?? t("Doclink");

	return (
		<aside className="doclink-panel" style={{ width }} ref={panelRef}>
			<div className="doclink-panel__resize" onPointerDown={onResizeDown} />
			<div className="doclink-panel__header">
				<span className="doclink-panel__title" title={title}>
					{title}
				</span>
				<Tooltip content={t("Refresh document")} side="bottom">
					<button
						className="icon-button"
						type="button"
						aria-label={t("Refresh document")}
						disabled={!url || loading}
						onClick={onRefresh}
					>
						<Icon path={mdiRefresh} />
					</button>
				</Tooltip>
				<Tooltip
					content={wholeDoc ? t("Show linked section only") : t("Show whole document")}
					side="bottom"
				>
					<button
						className="icon-button"
						type="button"
						aria-label={t("Toggle whole document")}
						disabled={!docRef?.anchor}
						onClick={() => setWholeDoc((w) => !w)}
					>
						<Icon path={wholeDoc ? mdiBookOpenVariant : mdiBookOpenOutline} />
					</button>
				</Tooltip>
				<Tooltip
					content={pinned ? t("Unpin (follow selected tags)") : t("Pin current section")}
					side="bottom"
				>
					<button
						className="icon-button"
						type="button"
						aria-label={t("Pin section")}
						onClick={() => setPinned((p) => !p)}
					>
						<Icon path={pinned ? mdiPin : mdiPinOutline} />
					</button>
				</Tooltip>
				<Tooltip content={t("Open in browser")} side="bottom">
					<button
						className="icon-button"
						type="button"
						aria-label={t("Open in browser")}
						disabled={!url}
						onClick={() => url && void openExternal(url)}
					>
						<Icon path={mdiOpenInNew} />
					</button>
				</Tooltip>
				<Tooltip content={t("Close")} side="bottom">
					<button
						className="icon-button"
						type="button"
						aria-label={t("Close doclink panel")}
						onClick={onClose}
					>
						<Icon path={mdiClose} />
					</button>
				</Tooltip>
			</div>
			{/* Present whenever ANY tag in the map pages (fixed height, may be empty) --
			    mounting it per-tag shifts the doc body on every section switch. */}
			{tags.some((t) => (t.doclinks?.length ?? 0) > 1) && (
				<div className="doclink-panel__pager">
					{links.length > 1 &&
						links.map((_, i) => (
							<button
								key={i}
								type="button"
								className={i === idx ? "is-selected" : ""}
								onClick={() => selTag && setSel({ tagId: selTag.id, idx: i })}
							>
								{i + 1}
							</button>
						))}
				</div>
			)}
			<div
				ref={bodyRef}
				className={`doclink-panel__body${shown?.anchorFound && !shown.blocks ? " doclink-panel__body--fallback" : ""}`}
			>
				{loading && shown && (
					<div className="doclink-panel__loading">
						<span className="spinner" />
					</div>
				)}
				{tags.length === 0 ? (
					<div className="doclink-panel__status">
						{t("No tags in this map carry document links.")}
					</div>
				) : !selTag ? (
					<div className="doclink-panel__status">
						{t("Select a tag with document links to view its section.")}
					</div>
				) : !url ? (
					<div className="doclink-panel__status">{t("No document link selected.")}</div>
				) : !docRef ? (
					<div className="doclink-panel__status">
						{t("Unsupported document link:")} {url}
					</div>
				) : error ? (
					<div className="doclink-panel__status">
						{t("Couldn't load the document.")} {error.message}
					</div>
				) : shown && !shown.anchorFound ? (
					<div className="doclink-panel__status">
						{t("The linked section no longer exists in this document.")}
					</div>
				) : shown?.blocks ? (
					<DocRenderer blocks={shown.blocks} />
				) : shown ? (
					// Conversion failed: fall back to the doc's own HTML/CSS in a shadow root.
					<ShadowHtml css={shown.css} html={shown.html} />
				) : loading ? (
					<div className="doclink-panel__status doclink-panel__status--center">
						<span className="spinner" />
					</div>
				) : null}
			</div>
		</aside>
	);
}
