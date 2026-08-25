import { useState, useMemo, useRef } from "react";
import { cmd } from "@/lib/commands";
import { useAsync } from "@/lib/hooks/useAsync";
import { log } from "@/lib/util/log";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { getMapState } from "@/store/useMapStore";
import { isVirtualLocation } from "@/types";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";

export function QuickCopyToMapDialog({
	locationId,
	onClose,
}: {
	locationId: number;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const contentRef = useRef<HTMLDivElement>(null);
	const { data: maps } = useAsync(
		() =>
			cmd.storeListMaps().catch((e) => {
				log.error("[quickCopy] list failed:", e);
				return null;
			}),
		[],
	);

	const lower = query.trim().toLowerCase();
	const suggestions = useMemo(
		() =>
			lower
				? (maps ?? [])
						.filter((m) => m.id !== getMapState().mapId && m.name.toLowerCase().includes(lower))
						.sort((a, b) => a.name.localeCompare(b.name))
						.slice(0, 8)
				: [],
		[maps, lower],
	);

	const doCopy = (targetMapId: string) => {
		if (isVirtualLocation({ id: locationId })) {
			onClose();
			return;
		}
		cmd
			.storeCopyLocationsToMap(targetMapId, {
				type: "Locations",
				locations: [locationId],
				name: null,
			})
			.then((res) => {
				const container = contentRef.current;
				if (container)
					toast(
						res.copied > 0
							? t('Copied to "{name}"', { name: res.targetName })
							: t('Already in "{name}"', { name: res.targetName }),
						1500,
						container,
					);
				setTimeout(onClose, 600);
			})
			.catch((e) => {
				log.error("[quickCopy] failed:", e);
				const container = contentRef.current;
				if (container) toast(t("Copy failed"), 1500, container);
				setTimeout(onClose, 600);
			});
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title={t("Copy location to map")} className="copy-to-map-modal-host">
				<div className="copy-to-map-modal" ref={contentRef}>
					<SuggestInput
						containerClassName="copy-to-map-modal__add"
						placeholder={t("Search for a map...")}
						value={query}
						onChange={setQuery}
						suggestions={suggestions}
						getKey={(m) => m.id}
						onPick={(m) => doCopy(m.id)}
						listStyle={{ top: "100%", left: 0, zIndex: 10 }}
						autoFocus
						renderItem={(m) => (
							<>
								<strong>{m.name || t("(unnamed)")}</strong>
								{m.folder && <span className="search-result__context"> &middot; {m.folder}</span>}
							</>
						)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
