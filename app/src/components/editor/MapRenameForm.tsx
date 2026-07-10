import { updateMapMeta, deleteMap } from "@/store/useMapStore";
import { useId, useState } from "react";
import { useCloseDialog } from "../primitives/Dialog";

function DeleteMapSection({ mapId, name }: { mapId: string; name: string }) {
	const [confirming, setConfirming] = useState(false);

	if (!confirming) {
		return (
			<div className="edit-map-modal__delete">
				<button type="button" className="button button--danger" onClick={() => setConfirming(true)}>
					Delete map
				</button>
			</div>
		);
	}

	return (
		<div className="edit-map-modal__delete">
			<p>
				Delete &ldquo;{name || "(unnamed)"}&rdquo;? This permanently removes the map and its
				history.
			</p>
			<div className="edit-map-modal__actions">
				<button type="button" className="button" onClick={() => setConfirming(false)}>
					Cancel
				</button>
				<button
					type="button"
					className="button button--danger"
					onClick={() => void deleteMap(mapId)}
				>
					Delete map
				</button>
			</div>
		</div>
	);
}

export function MapRenameForm({ mapId, currentName }: { mapId: string; currentName: string }) {
	const id = useId();
	const close = useCloseDialog();
	const [name, setName] = useState(currentName);
	return (
		<>
			<form
				className="edit-map-modal__rename"
				onSubmit={(e) => {
					e.preventDefault();
					updateMapMeta({ name: name || currentName });
					close();
				}}
			>
				<p className="edit-map-modal__name">
					<label htmlFor={`${id}name`}>Map name:</label>
					<input
						id={`${id}name`}
						className="input"
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						minLength={1}
						maxLength={100}
						autoFocus
					/>
				</p>
				<div className="edit-map-modal__actions">
					<button
						type="submit"
						className="button button--primary"
						disabled={name.trim().length === 0}
					>
						Save
					</button>
				</div>
			</form>
			<DeleteMapSection mapId={mapId} name={currentName} />
		</>
	);
}
