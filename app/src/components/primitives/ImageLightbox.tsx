import { Dialog, DialogActions, DialogContent, type DialogProps } from "./Dialog";
import { t } from "@/lib/i18n";

/** An image shown large, with the option to remove it when it is one being attached. */
export function ImageLightbox({
	src,
	name,
	onRemove,
	open,
	onOpenChange,
}: DialogProps & { src: string; name: string; onRemove?: () => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={name} size="xl" className="lightbox">
				<img className="lightbox__image" src={src} alt={name} />
				{onRemove && (
					<DialogActions
						destructive={{
							label: t("Remove"),
							onClick: () => {
								onRemove();
								onOpenChange(false);
							},
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
