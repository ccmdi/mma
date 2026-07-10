import { Fragment, useState, useEffect, useRef } from "react";
import type { ScoreBounds } from "@/bindings.gen";
import type { Bounds } from "@/types";
import { isWorldBounds, scoreTupleToBounds, boundsToScoreTuple } from "@/types";
import { useCurrentMap, updateMapMeta } from "@/store/useMapStore";
import {
	resolveScoreMaxError,
	formatDistance,
	useScoreMaxError,
	WORLD_MAX_ERROR,
} from "@/lib/sv/measure";

type Mode = "auto" | "world" | "fixed";

function modeOf(bounds: ScoreBounds): Mode {
	if (typeof bounds === "string") return "auto";
	return isWorldBounds(scoreTupleToBounds(bounds)) ? "world" : "fixed";
}

/** "Scoring" section of the edit-map modal. */
export function ScoreBoundsEditor() {
	const map = useCurrentMap();
	const bounds: ScoreBounds = map?.meta.scoreBounds ?? "auto";
	const mode = modeOf(bounds);
	const resolvedError = useScoreMaxError();

	const fixed: Bounds =
		typeof bounds !== "string" && !isWorldBounds(scoreTupleToBounds(bounds))
			? scoreTupleToBounds(bounds)
			: { south: 0, west: 0, north: 0, east: 0 };
	const [draft, setDraft] = useState<[string, string, string, string]>([
		String(fixed.south),
		String(fixed.west),
		String(fixed.north),
		String(fixed.east),
	]);
	const lastFixedRef = useRef<Bounds>(fixed);

	useEffect(() => {
		if (mode !== "fixed") return;
		lastFixedRef.current = fixed;
		setDraft([String(fixed.south), String(fixed.west), String(fixed.north), String(fixed.east)]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, fixed.south, fixed.west, fixed.north, fixed.east]);

	const setMode = (next: Mode) => {
		if (next === "auto") void updateMapMeta({ scoreBounds: "auto" });
		else if (next === "world")
			void updateMapMeta({
				scoreBounds: boundsToScoreTuple(google.maps.LatLngBounds.MAX_BOUNDS.toJSON()),
			});
		else void updateMapMeta({ scoreBounds: boundsToScoreTuple(lastFixedRef.current) });
	};

	const commitFixed = (parts: [string, string, string, string]) => {
		const nums = parts.map((p) => Number.parseFloat(p));
		if (nums.some((n) => !Number.isFinite(n))) return;
		const [s, w, n, e] = nums;
		const next: Bounds = { south: s, west: w, north: n, east: e };
		lastFixedRef.current = next;
		void updateMapMeta({ scoreBounds: boundsToScoreTuple(next) });
	};

	// Per-mode resolved max-error for the radio labels. The active mode shows the
	// live shared value; inactive modes show what they would resolve to.
	const autoError = mode === "auto" ? resolvedError : null;
	const fixedError =
		mode === "fixed" ? resolvedError : resolveScoreMaxError(lastFixedRef.current, []);

	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Scoring <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				<input
					type="radio"
					name="score-bounds"
					checked={mode === "auto"}
					onChange={() => setMode("auto")}
				/>
				Automatic based on locations
				{autoError != null && ` (${formatDistance(autoError)})`}
			</label>

			<label className="settings-popup__item">
				<input
					type="radio"
					name="score-bounds"
					checked={mode === "world"}
					onChange={() => setMode("world")}
				/>
				World map (ACW, {formatDistance(WORLD_MAX_ERROR)})
			</label>

			<label className="settings-popup__item">
				<input
					type="radio"
					name="score-bounds"
					checked={mode === "fixed"}
					onChange={() => setMode("fixed")}
				/>
				Fixed bounds
				{fixedError != null && ` (${formatDistance(fixedError)})`}
			</label>

			{mode === "fixed" && (
				<div
					className="settings-popup__item"
					style={{
						display: "grid",
						gridTemplateColumns: "auto 1fr auto 1fr",
						gap: ".25rem .5rem",
						alignItems: "center",
					}}
				>
					{(["S", "W", "N", "E"] as const).map((label, i) => (
						<Fragment key={label}>
							<span style={{ fontSize: ".8rem" }}>{label}</span>
							<input
								className="input"
								type="text"
								inputMode="decimal"
								value={draft[i]}
								onChange={(e) => {
									const next = [...draft] as typeof draft;
									next[i] = e.currentTarget.value;
									setDraft(next);
								}}
								onBlur={() => commitFixed(draft)}
								style={{ width: "100%", textAlign: "end" }}
							/>
						</Fragment>
					))}
				</div>
			)}
		</fieldset>
	);
}
