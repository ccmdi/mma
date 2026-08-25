import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { mdiArrowRight, mdiChevronDown, mdiChevronRight, mdiClose, mdiFolder } from "@mdi/js";
import { TagPill } from "@/components/primitives/TagPill";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { TextInput } from "@/components/primitives/TextInput";
import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/primitives/Icon";
import { useMapState, updateTags } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { useMapSetting } from "@/store/useMapSetting";
import {
	parseDoclink,
	loadOutline,
	anchorsInDoc,
	matchTagsToHeadings,
	type DocRef,
	type DoclinkMatch,
} from "@/lib/doclink";
import { useAsync } from "@/lib/hooks/useAsync";
import { textColorFor, rgbToHex } from "@/lib/util/color";
import { toggleInSet } from "@/lib/util/util";
import {
	buildTagTree,
	isLeafTag,
	loadExpanded,
	type TagTreeNode,
} from "@/components/editor/tags/tagTreeRange";
import type { Tag } from "@/bindings.gen";
import { t } from "@/lib/i18n";

function docUrl(docId: string): string {
	return `https://docs.google.com/document/d/${docId}/edit`;
}

function headingUrl(docId: string, anchor: string): string {
	return `${docUrl(docId)}#heading=${anchor}`;
}

const matchKey = (m: DoclinkMatch) => `${m.tag.id}:${m.heading.anchor}`;

const NO_VIRTUAL_TAGS = {};
const NO_ALIASES = {};

// --- Tags pane: the sidebar's tag tree, read-only, with pills as arm targets ---

interface TreeCtx {
	docId: string;
	armedId: number | null;
	onArm: (id: number) => void;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	tagMap: Record<string, Tag>;
}

function TreePill({
	tag,
	label,
	isAlias,
	ctx,
}: {
	tag: Tag;
	label: string;
	isAlias?: boolean;
	ctx: TreeCtx;
}) {
	return (
		<TagPill
			as="button"
			type="button"
			small
			color={tag.color}
			count={anchorsInDoc(tag, ctx.docId).size || undefined}
			className={clsx(
				"doclink-assign__tag",
				isAlias && "is-alias",
				tag.id === ctx.armedId && "is-armed",
			)}
			title={tag.name}
			onClick={() => ctx.onArm(tag.id)}
			label={label}
		/>
	);
}

/** Doclinks in this doc across the branch's tags (aliases dedup to one count). */
function branchLinkCount(node: TagTreeNode, ctx: TreeCtx): number {
	let total = 0;
	for (const id of new Set(node.descendantTagIds)) {
		const tag = ctx.tagMap[id];
		if (tag) total += anchorsInDoc(tag, ctx.docId).size;
	}
	return total;
}

/** A folder row at the sidebar's scale and shape (2rem colored pill-row).
 *  Clicking a tag-bearing row arms its tag; a tagless row just toggles. */
function TagBranch({ node, ctx }: { node: TagTreeNode; ctx: TreeCtx }) {
	const open = ctx.expanded.has(node.fullPath);
	const linked = branchLinkCount(node, ctx);
	const fg = textColorFor(node.inheritedColor);
	return (
		<div className="doclink-assign__branch">
			<div
				className={clsx(
					"doclink-assign__folder-row",
					node.tag && node.tag.id === ctx.armedId && "is-armed",
				)}
				style={{ backgroundColor: node.inheritedColor, color: fg }}
				title={node.tag?.name}
				tabIndex={0}
				onClick={() => (node.tag ? ctx.onArm(node.tag.id) : ctx.onToggle(node.fullPath))}
			>
				<button
					type="button"
					className="doclink-assign__chevron"
					aria-label={t("Toggle folder")}
					style={{ color: fg }}
					onClick={(e) => {
						e.stopPropagation();
						ctx.onToggle(node.fullPath);
					}}
				>
					<Icon path={open ? mdiChevronDown : mdiChevronRight} size={18} />
				</button>
				<span className="doclink-assign__folder-name">{node.segment}</span>
				{!node.tag && (
					<Icon path={mdiFolder} size={13} style={{ color: fg, opacity: 0.5, flexShrink: 0 }} />
				)}
				{linked > 0 && <span className="mono doclink-assign__folder-count">{linked}</span>}
			</div>
			{open && (
				<div className="doclink-assign__branch-children">
					<TagLevel nodes={node.children} ctx={ctx} />
				</div>
			)}
		</div>
	);
}

/** One tree level, mirroring the sidebar's layout: leaf pills as a wrapped group
 *  above folder rows (buildTagTree already orders them that way). */
function TagLevel({ nodes, ctx }: { nodes: TagTreeNode[]; ctx: TreeCtx }) {
	const leaves = nodes.filter(isLeafTag);
	const branches = nodes.filter((n) => !isLeafTag(n));
	return (
		<>
			{leaves.length > 0 && (
				<div className="doclink-assign__pills">
					{leaves.map((n) => (
						<TreePill
							key={n.fullPath}
							tag={n.tag!}
							label={n.segment}
							isAlias={n.isAlias}
							ctx={ctx}
						/>
					))}
				</div>
			)}
			{branches.map((n) => (
				<TagBranch key={n.fullPath} node={n} ctx={ctx} />
			))}
		</>
	);
}

export function DoclinkAssignDialog({ open, onOpenChange }: DialogProps) {
	const tagMap = useMapState((s) => s.tags);
	const tags: Tag[] = useMemo(() => Object.values(tagMap), [tagMap]);

	// Doc identity: pasted URL, prefilled from the map's first existing doclink.
	const inferred = tags.flatMap((t) => t.doclinks ?? [])[0] ?? "";
	const [urlInput, setUrlInput] = useState<string | null>(null);
	const url = urlInput ?? inferred;
	const docRef: DocRef | null = url ? parseDoclink(url) : null;

	const [armedId, setArmedId] = useState<number | null>(null);
	const armed = tags.find((t) => t.id === armedId) ?? null;
	const [tagFilter, setTagFilter] = useState("");
	const [headingFilter, setHeadingFilter] = useState("");
	const [matches, setMatches] = useState<DoclinkMatch[] | null>(null);

	// The same tree the sidebar shows: same sort, folders, virtual tags, aliases,
	// and view mode, so the dialog matches the user's mental model of their tags.
	const tagViewMode = useSetting("tagViewMode");
	const sortMode = useSetting("tagSortMode");
	const folderColorMode = useSetting("tagFolderColorMode");
	const folderColorRgb = useSetting("tagFolderColor");
	const tagCounts = useMapState((s) => s.tagCounts);
	const [virtualTags] = useMapSetting("virtualTags", NO_VIRTUAL_TAGS);
	const [aliases] = useMapSetting("aliases", NO_ALIASES);
	const tree = useMemo(
		() =>
			buildTagTree(tags, sortMode, tagCounts, virtualTags, aliases, tagViewMode === "tree", {
				mode: folderColorMode,
				color: rgbToHex(folderColorRgb),
			}),
		[tags, sortMode, tagCounts, virtualTags, aliases, tagViewMode, folderColorMode, folderColorRgb],
	);
	// Folder expansion starts where the sidebar left it; toggles stay dialog-local.
	const [expanded, setExpanded] = useState(loadExpanded);
	useEffect(() => {
		if (open) setExpanded(loadExpanded());
	}, [open]);

	// Every doc the map's tags link to, for switching without re-pasting URLs.
	const knownDocIds = useMemo(() => {
		const ids: string[] = [];
		for (const tag of tags) {
			for (const u of tag.doclinks ?? []) {
				const ref = parseDoclink(u);
				if (ref && !ids.includes(ref.docId)) ids.push(ref.docId);
			}
		}
		return ids;
	}, [tags]);
	// Prefetched on map open, so these resolve from cache in the common case.
	const { data: knownTitles } = useAsync(
		() =>
			Promise.all(
				knownDocIds.map((docId) =>
					loadOutline({ provider: "gdoc", docId, anchor: null, url: docUrl(docId) })
						.then((o) => o.title)
						.catch(() => null),
				),
			),
		[knownDocIds.join(","), open],
	);

	const {
		data: outline,
		loading,
		error,
	} = useAsync(() => (docRef && open ? loadOutline(docRef) : null), [docRef?.docId, open]);

	// anchor -> tags assigned to it (for this doc), recomputed from live tag data.
	const assignments = useMemo(() => {
		const byAnchor = new Map<string, Tag[]>();
		if (!docRef) return byAnchor;
		for (const tag of tags) {
			for (const anchor of anchorsInDoc(tag, docRef.docId)) {
				const list = byAnchor.get(anchor) ?? [];
				list.push(tag);
				byAnchor.set(anchor, list);
			}
		}
		return byAnchor;
	}, [tags, docRef]);

	const filteredTags = useMemo(
		() =>
			tags
				.filter((tag) => tag.name.toLowerCase().includes(tagFilter.toLowerCase()))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
		[tags, tagFilter],
	);
	const shownHeadings = headingFilter
		? (outline?.headings ?? []).filter((h) =>
				h.text.toLowerCase().includes(headingFilter.toLowerCase()),
			)
		: (outline?.headings ?? []);

	// Refresh path for reimports: import only adopts doclinks onto tags that
	// have none, so clearing this doc's links first lets a reimport repopulate.
	const clearDoc = async () => {
		if (!docRef) return;
		const updates = tags
			.filter((t) => anchorsInDoc(t, docRef.docId).size > 0)
			.map((t) => ({
				id: t.id,
				patch: {
					doclinks: (t.doclinks ?? []).filter((u) => parseDoclink(u)?.docId !== docRef.docId),
				},
			}));
		if (updates.length > 0) await updateTags(updates);
	};

	const toggle = async (tag: Tag, anchor: string) => {
		if (!docRef) return;
		const target = headingUrl(docRef.docId, anchor);
		const existing = tag.doclinks ?? [];
		const has = existing.some((u) => {
			const r = parseDoclink(u);
			return r?.docId === docRef.docId && r.anchor === anchor;
		});
		const doclinks = has
			? existing.filter((u) => {
					const r = parseDoclink(u);
					return !(r?.docId === docRef.docId && r.anchor === anchor);
				})
			: [...existing, target];
		await updateTags([{ id: tag.id, patch: { doclinks } }]);
	};

	const runMatch = () => {
		if (!docRef || !outline) return;
		setMatches(matchTagsToHeadings(tags, outline.headings, docRef.docId));
	};

	const applyMatches = async () => {
		if (!docRef || !matches) return;
		// Re-read live tag data: manual toggles while the preview was open must not duplicate.
		const byTag = new Map<number, string[]>();
		for (const m of matches) {
			const tag = tagMap[m.tag.id];
			if (!tag || anchorsInDoc(tag, docRef.docId).has(m.heading.anchor)) continue;
			const list = byTag.get(tag.id) ?? [];
			list.push(headingUrl(docRef.docId, m.heading.anchor));
			byTag.set(tag.id, list);
		}
		const updates = [...byTag.entries()].map(([id, added]) => ({
			id,
			patch: { doclinks: [...(tagMap[id].doclinks ?? []), ...added] },
		}));
		if (updates.length > 0) await updateTags(updates);
		setMatches(null);
	};

	const treeCtx: TreeCtx = {
		docId: docRef?.docId ?? "",
		armedId,
		onArm: (id) => setArmedId(id === armedId ? null : id),
		expanded,
		onToggle: (path) => setExpanded((prev) => toggleInSet(prev, path)),
		tagMap,
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Assign document links")} className="doclink-assign">
				<div className="doclink-assign__url">
					<TextInput
						placeholder={t("Paste a Google Docs link...")}
						value={url}
						onChange={(e) => {
							setUrlInput(e.target.value);
							setMatches(null);
						}}
					/>
					<Button
						disabled={!docRef || assignments.size === 0}
						title={t("Remove this document's links from every tag")}
						onClick={() => void clearDoc()}
					>
						{t("Clear doc links")}
					</Button>
				</div>
				{knownDocIds.length > 1 && (
					<div className="doclink-assign__docs">
						{knownDocIds.map((docId, i) => (
							<Button
								key={docId}
								variant="ghost"
								small
								className={clsx(docId === docRef?.docId && "is-active")}
								onClick={() => {
									setUrlInput(docUrl(docId));
									setMatches(null);
								}}
							>
								{knownTitles?.[i] ?? docId.slice(0, 12)}
							</Button>
						))}
					</div>
				)}
				{!docRef ? (
					<p className="doclink-assign__hint">
						{t("Paste a link to a Google Doc to load its headings.")}
					</p>
				) : (
					<>
						<div className="doclink-assign__armed">
							{armed ? (
								<>
									<TagPill small color={armed.color} label={armed.name} title={armed.name} />
									<span>{t("Click headings to link or unlink.")}</span>
								</>
							) : (
								<span>{t("Pick a tag, then click headings to link it.")}</span>
							)}
						</div>
						{matches && (
							<div className="doclink-assign__match">
								<div className="doclink-assign__match-head">
									<span className="doclink-assign__pane-title">
										{t("Suggested links")} <span className="mono">{matches.length}</span>
									</span>
									{matches.length > 0 && (
										<Button variant="primary" small onClick={() => void applyMatches()}>
											{t("Link all")}
										</Button>
									)}
									<Button variant="ghost" small onClick={() => setMatches(null)}>
										{t("Cancel")}
									</Button>
								</div>
								{matches.length === 0 ? (
									<p className="doclink-assign__hint">{t("No headings match your tag names.")}</p>
								) : (
									<div className="doclink-assign__match-rows">
										{matches.map((m) => (
											<div key={matchKey(m)} className="doclink-assign__match-row">
												<TagPill small color={m.tag.color} label={m.tag.name} title={m.tag.name} />
												<Icon path={mdiArrowRight} size={14} />
												<span className="doclink-assign__match-heading">{m.heading.text}</span>
												<button
													type="button"
													className="icon-button"
													aria-label={t("Dismiss")}
													onClick={() =>
														setMatches(matches.filter((x) => matchKey(x) !== matchKey(m)))
													}
												>
													<Icon path={mdiClose} size={14} />
												</button>
											</div>
										))}
									</div>
								)}
							</div>
						)}
						<div className="doclink-assign__panes">
							<div className="doclink-assign__pane">
								<div className="doclink-assign__pane-head">
									<span className="doclink-assign__pane-title">{t("Tags")}</span>
									<TextInput
										placeholder={t("Filter tags...")}
										value={tagFilter}
										onChange={(e) => setTagFilter(e.target.value)}
									/>
								</div>
								<div className="doclink-assign__tags">
									{tagFilter ? (
										<div className="doclink-assign__pills">
											{filteredTags.map((tag) => (
												<TreePill key={tag.id} tag={tag} label={tag.name} ctx={treeCtx} />
											))}
										</div>
									) : (
										<TagLevel nodes={tree} ctx={treeCtx} />
									)}
									{tags.length === 0 && (
										<p className="doclink-assign__hint">{t("This map has no tags.")}</p>
									)}
								</div>
							</div>
							<div className="doclink-assign__pane">
								<div className="doclink-assign__pane-head">
									<span className="doclink-assign__pane-title">
										{outline?.title ?? t("Document")}
									</span>
									<TextInput
										placeholder={t("Filter headings...")}
										value={headingFilter}
										onChange={(e) => setHeadingFilter(e.target.value)}
									/>
									<Button
										small
										disabled={!outline || outline.headings.length === 0}
										onClick={runMatch}
									>
										{t("Match names")}
									</Button>
								</div>
								<div className="doclink-assign__outline">
									{loading && <p className="doclink-assign__hint">{t("Loading document...")}</p>}
									{error && (
										<p className="doclink-assign__hint">
											{t("Couldn't load:")} {error.message}
										</p>
									)}
									{shownHeadings.map((h) => {
										const assigned = assignments.get(h.anchor) ?? [];
										const armedHere = armed !== null && assigned.some((t) => t.id === armed.id);
										return (
											<button
												key={h.anchor}
												type="button"
												className={clsx(
													"doclink-assign__heading",
													armed && "is-assignable",
													armedHere && "is-active",
												)}
												style={{ paddingLeft: `${(h.level - 1) * 14 + 8}px` }}
												onClick={() => armed && void toggle(armed, h.anchor)}
											>
												<span className="doclink-assign__heading-text">{h.text}</span>
												{assigned.map((tag) => (
													<span
														key={tag.id}
														className="doclink-assign__chip"
														style={{ background: tag.color, color: textColorFor(tag.color) }}
														title={t(
															"Assigned to {name} (click heading with this tag armed to remove)",
															{ name: tag.name },
														)}
													>
														{tag.name}
													</span>
												))}
											</button>
										);
									})}
									{outline && outline.headings.length === 0 && (
										<p className="doclink-assign__hint">
											{t("No linkable headings found in this doc.")}
										</p>
									)}
								</div>
							</div>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
