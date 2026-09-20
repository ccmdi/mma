import { useCallback, useMemo, useRef, useState } from "react";
import type { Tag } from "@/types";
import { Dialog, DialogActions, DialogContent, DialogForm } from "@/components/primitives/Dialog";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { TagPill } from "@/components/primitives/TagPill";
import { Icon } from "@/components/primitives/Icon";
import { mdiTagPlusOutline } from "@mdi/js";
import { t } from "@/lib/i18n";
import { search } from "@/lib/search";
import { toast } from "@/lib/util/toast";
import { displayTagName } from "@/store/selections";
import { createTags, getVisibleTags, useMapState } from "@/store/useMapStore";

export function TagButton({ locationIds, label }: { locationIds: number[]; label?: string }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const tags = useMapState(getVisibleTags);
	const formRef = useRef<HTMLFormElement>(null);

	const suggestions = useMemo(
		() => search(tags, name, (tag) => [tag.name]).slice(0, 10),
		[tags, name],
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
					// TODO: deferred focus is a workaround for portal measuring before dialog layout settles
					initialFocus={() => {
						setTimeout(() => {
							formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
						}, 100);
						return false;
					}}
				>
					<DialogForm ref={formRef} onSubmit={() => void apply(name)}>
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
						<DialogActions
							cancel={{ disabled: busy }}
							primary={{ label: t("Add tag"), disabled: !name.trim() || busy }}
						/>
					</DialogForm>
				</DialogContent>
			</Dialog>
		</>
	);
}
