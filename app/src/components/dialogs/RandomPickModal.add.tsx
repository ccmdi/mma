import { useState, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { selectRandomFromSelection } from "@/store/useMapStore";
import { toast } from "@/lib/util/toast.add";
import { fmt } from "@/lib/util/format";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Size of the current selection to pick from. */
	total: number;
}

export function RandomPickModal({ open, onOpenChange, total }: Props) {
	const [value, setValue] = useState("");

	const parsed = Math.floor(Number(value));
	const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
	const count = valid ? Math.min(parsed, total) : 0;

	const handlePick = useCallback(() => {
		const picked = selectRandomFromSelection(count);
		if (picked > 0) toast(`Selected ${fmt.format(picked)} random location${picked !== 1 ? "s" : ""}`);
		onOpenChange(false);
	}, [count, onOpenChange]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="Pick random locations" className="random-pick">
				<p className="random-pick__status">
					Pick a number of locations at random from the current selection of{" "}
					{fmt.format(total)}. The picked locations replace the current selection.
				</p>
				<form
					className="random-pick__form"
					onSubmit={(e) => {
						e.preventDefault();
						if (valid) handlePick();
					}}
				>
					<input
						className="input random-pick__input"
						type="number"
						min={1}
						max={total}
						step={1}
						placeholder="Count"
						value={value}
						autoFocus
						onChange={(e) => setValue(e.target.value)}
					/>
					{valid && parsed > total && (
						<p className="random-pick__hint">Clamped to {fmt.format(total)} (whole selection).</p>
					)}
					<div className="random-pick__actions">
						<button className="button" type="button" onClick={() => onOpenChange(false)}>
							Cancel
						</button>
						<button className="button button--primary" type="submit" disabled={!valid}>
							Pick {valid ? fmt.format(count) : ""}
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
