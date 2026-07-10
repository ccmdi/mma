import { useState, useEffect, useMemo, useRef } from "react";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import type { MapMeta } from "@/bindings.gen";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { getCurrentMapId, getActiveLocation } from "@/store/useMapStore";
import { isVirtualLocation } from "@/types";
import { showToast } from "@/lib/sv/lookup";

export function QuickCopyToMapDialog({ onClose }: { onClose: () => void }) {
	const [maps, setMaps] = useState<MapMeta[] | null>(null);
	const [query, setQuery] = useState("");
	const contentRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		cmd
			.storeListMaps()
			.then(setMaps)
			.catch((e) => log.error("[quickCopy] list failed:", e));
	}, []);

	const lower = query.trim().toLowerCase();
	const suggestions = useMemo(
		() =>
			lower
				? (maps ?? [])
						.filter((m) => m.id !== getCurrentMapId() && m.name.toLowerCase().includes(lower))
						.sort((a, b) => a.name.localeCompare(b.name))
						.slice(0, 8)
				: [],
		[maps, lower],
	);

	const doCopy = (targetMapId: string) => {
		const loc = getActiveLocation();
		if (!loc || isVirtualLocation(loc)) {
			onClose();
			return;
		}
		cmd
			.storeCopyLocationsToMap(targetMapId, [loc.id])
			.then((res) => {
				const container = contentRef.current;
				if (container) {
					showToast(
						container,
						res.copied > 0 ? `Copied to "${res.targetName}"` : `Already in "${res.targetName}"`,
					);
				}
				setTimeout(onClose, 600);
			})
			.catch((e) => {
				log.error("[quickCopy] failed:", e);
				const container = contentRef.current;
				if (container) showToast(container, "Copy failed");
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
			<DialogContent title="Copy location to map" className="copy-to-map-modal-host">
				<div className="copy-to-map-modal" ref={contentRef}>
					<SuggestInput
						containerClassName="copy-to-map-modal__add"
						placeholder="Search for a map..."
						value={query}
						onChange={setQuery}
						suggestions={suggestions}
						getKey={(m) => m.id}
						onPick={(m) => doCopy(m.id)}
						listStyle={{ top: "100%", left: 0, zIndex: 10 }}
						autoFocus
						renderItem={(m) => (
							<>
								<strong>{m.name || "(unnamed)"}</strong>
								{m.folder && <span className="search-result__context"> &middot; {m.folder}</span>}
							</>
						)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
