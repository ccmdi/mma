import { useRef, useState } from "react";
import { mdiClose, mdiImagePlus } from "@mdi/js";
import { IconButton } from "@/components/primitives/IconButton";
import { ImageLightbox } from "@/components/primitives/ImageLightbox";
import { MAX_ATTACHMENTS, type StagedImage } from "@/lib/feedback/attachments";
import { t } from "@/lib/i18n";

/** A button to attach images, and a chip for each one attached that opens it large. */
export function ReportImages({
	images,
	onAdd,
	onRemove,
}: {
	images: StagedImage[];
	onAdd: (files: FileList | null) => void;
	onRemove: (image: StagedImage) => void;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	const [viewing, setViewing] = useState<StagedImage | null>(null);
	return (
		<>
			<IconButton
				icon={mdiImagePlus}
				size={18}
				label={t("Attach an image, or paste one")}
				disabled={images.length >= MAX_ATTACHMENTS}
				onClick={() => fileInput.current?.click()}
			/>
			<input
				ref={fileInput}
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				multiple
				hidden
				onChange={(e) => {
					onAdd(e.target.files);
					e.target.value = "";
				}}
			/>
			{images.map((image) => (
				<span key={image.id} className="report-images__chip">
					<button type="button" onClick={() => setViewing(image)}>
						<img src={image.preview} alt="" />
						<span className="truncate">{image.name}</span>
					</button>
					<IconButton
						className="icon-button--inline"
						icon={mdiClose}
						size={12}
						label={t("Remove")}
						onClick={() => onRemove(image)}
					/>
				</span>
			))}
			{viewing && (
				<ImageLightbox
					open
					onOpenChange={() => setViewing(null)}
					src={viewing.preview}
					name={viewing.name}
					onRemove={() => onRemove(viewing)}
				/>
			)}
		</>
	);
}
