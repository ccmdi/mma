import { useCallback, useMemo, useRef, useState } from "react";
import type { Tag } from "@/bindings.gen";
import { Button } from "@/components/primitives/Button";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { TagPill } from "@/components/primitives/TagPill";
import { Icon } from "@/components/primitives/Icon";
import { mdiTagPlusOutline } from "@mdi/js";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/util/toast";
import { displayTagName } from "@/store/selections";
import { createTags, getVisibleTags, useMapState } from "@/store/useMapStore";

export function TagButton({ locationIds, label }: { locationIds: number[]; label?: string }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const tags = useMapState(getVisibleTags);
	const formRef = useRef<HTMLFormElement>(null);

	const query = name.trim().toLowerCase();
	const suggestions = useMemo(
		() => tags.filter((tag) => !query || tag.name.toLowerCase().includes(query)).slice(0, 10),
		[tags, query],
	);

	const apply = useCallback(
		async (tagName: string) => {
			const trimmed = tagName.trim();
			if (!trimmed || busy || locationIds.length === 0) return;
			setBusy(true);
			try {
				await createTags([trimmed], { type: "Locations", locations: locationIds, name: null });
				toast(
					locationIds.length === 1
						? t("Tagged with {tag}", { tag: trimmed })
						: t("Tagged {n} locations with {tag}", { n: locationIds.length, tag: trimmed }),
				);
				setName("");
				setOpen(false);
			} catch (e) {
				toast(e instanceof Error ? e.message : t("Could not add the tag"));
			} finally {
				setBusy(false);
			}
		},
		[busy, locationIds],
	);

	if (locationIds.length === 0) return null;

	return (
		<>
			<button
				type="button"
				className="lg-tag-btn"
				onClick={() => setOpen(true)}
				aria-label={label ?? t("Add a tag")}
			>
				<Icon path={mdiTagPlusOutline} size={18} />
				{label && <span>{label}</span>}
			</button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					title={
						locationIds.length === 1
							? t("Tag this location")
							: t("Tag {n} locations", { n: locationIds.length })
					}
					className="lg-tag-dialog"
					// TODO: deferred focus is a workaround for portal measuring before dialog layout settles
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						setTimeout(() => {
							formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
						}, 100);
					}}
				>
					<form
						ref={formRef}
						className="lg-tag-dialog__form"
						onSubmit={(e) => {
							e.preventDefault();
							void apply(name);
						}}
					>
						<SuggestInput<Tag>
							value={name}
							onChange={setName}
							suggestions={suggestions}
							onPick={(tag) => void apply(tag.name)}
							renderItem={(tag) => (
								<TagPill small color={tag.color} label={displayTagName(tag.name)} />
							)}
							getKey={(tag) => tag.id}
							placeholder={t("Tag name")}
							disabled={busy}
							portal
						/>
						<div className="lg-tag-dialog__actions">
							<Button type="button" onClick={() => setOpen(false)} disabled={busy}>
								{t("Cancel")}
							</Button>
							<Button variant="primary" type="submit" disabled={!name.trim() || busy}>
								{t("Add tag")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
