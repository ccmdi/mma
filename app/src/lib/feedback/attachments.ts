import { useEffect, useRef, useState } from "react";
import type { AttachmentRef } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { mmaBufUrl } from "@/lib/util/util";

/** Enough for a before/after pair plus context, few enough that sending stays quick -- each
 *  one costs a proof of work. */
export const MAX_ATTACHMENTS = 4;

/** Long edge, in pixels. A screenshot of a 4K display is legible well below its native size,
 *  and every pixel past this is upload time and storage for nothing. */
const MAX_DIMENSION = 2560;

/** Re-encoding one of these through a canvas would flatten it to a single frame, and an
 *  animation is often the whole point of attaching it. */
const ANIMATED = new Set(["image/gif"]);

/** An image the user has attached but not yet sent. `path` is a staged copy Rust can read:
 *  the bytes cannot cross the IPC boundary directly. */
export interface StagedImage {
	id: string;
	name: string;
	path: string;
	/** Object URL for the thumbnail. Revoked when the image is dropped. */
	preview: string;
	size: number;
}

/** Cap the dimensions and drop everything that is not pixels.
 *
 *  Re-encoding is what strips the metadata: a phone photo of a screen carries GPS, and these
 *  images end up referenced from a public issue. */
async function normalize(file: Blob): Promise<Blob> {
	if (ANIMATED.has(file.type)) return file;

	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();

	// JPEG stays JPEG -- re-encoding a photo as PNG can multiply its size past the cap.
	const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
	return blob ?? file;
}

/** Copy an image into `session` and describe it. The staged file is what
 *  {@link uploadImages} later hands to Rust. */
async function stageImage(session: string, file: File, index: number): Promise<StagedImage> {
	const blob = await normalize(file);
	const extension = blob.type === "image/jpeg" ? "jpg" : blob.type.slice("image/".length);
	const name = file.name || `pasted-${index + 1}.${extension}`;
	const path = `${session}/${index}-${Date.now()}.${extension}`;

	const resp = await fetch(mmaBufUrl(path), { method: "POST", body: blob });
	if (!resp.ok) throw new Error(`could not stage ${name}`);

	return {
		id: crypto.randomUUID(),
		name,
		path,
		preview: URL.createObjectURL(blob),
		size: blob.size,
	};
}

/** Store every staged image and return what the body should reference, in the order the user
 *  arranged them. Sequential because each upload solves a proof of work. */
export async function uploadImages(images: StagedImage[]): Promise<AttachmentRef[]> {
	const refs: AttachmentRef[] = [];
	for (const image of images) {
		// At most MAX_ATTACHMENTS, and each call is a network upload behind a proof of work --
		// batching would only move the same loop into Rust.
		// eslint-disable-next-line local/no-ipc-in-loop
		refs.push(await cmd.feedbackUploadAttachment(image.path, image.name));
	}
	return refs;
}

/** Images staged for one message. Staged copies and previews are released when the owner
 *  unmounts, never as the list changes: that would discard the staging dir on the second add. */
export function useStagedImages() {
	const [images, setImages] = useState<StagedImage[]>([]);
	const session = useRef<string | null>(null);
	const current = useRef<StagedImage[]>([]);
	current.current = images;
	useEffect(
		() => () => {
			current.current.forEach((i) => URL.revokeObjectURL(i.preview));
			if (session.current) void cmd.storeUploadAbort(session.current).catch(() => {});
		},
		[],
	);

	const add = async (files: FileList | File[] | null) => {
		const picked = [...(files ?? [])].slice(0, MAX_ATTACHMENTS - current.current.length);
		if (!picked.length) return;
		session.current ??= await cmd.storeUploadBegin();
		const staged: StagedImage[] = [];
		for (const [i, file] of picked.entries()) {
			staged.push(await stageImage(session.current, file, current.current.length + i));
		}
		setImages((prev) => [...prev, ...staged]);
	};

	const remove = (image: StagedImage) => {
		URL.revokeObjectURL(image.preview);
		setImages((prev) => prev.filter((i) => i.id !== image.id));
	};

	const clear = () => {
		current.current.forEach((i) => URL.revokeObjectURL(i.preview));
		setImages([]);
	};

	return { images, add, remove, clear };
}
