import { useEffect, useState } from "react";
import { collectDiagnostics, type Diagnostics } from "@/lib/diagnostics";
import { useAsync } from "@/lib/hooks/useAsync";
import { useDomEvent } from "@/lib/hooks/useDomEvent";
import { fmt, formatBytes, localeFormat } from "@/lib/util/format";
import {
	startFrameMeter,
	stopFrameMeter,
	frameStats,
	type FrameStats,
} from "@/lib/render/frameMeter";
import {
	computeRenderStats,
	getDeckMetrics,
	type DeckMetrics,
	type RenderStats,
} from "@/lib/render/renderStats";
import { t } from "@/lib/i18n";

interface LiveStats {
	frame: FrameStats;
	deck: DeckMetrics | null;
	scene: RenderStats | null;
}

const uptimeFmt = localeFormat<Partial<Record<Intl.DurationFormatUnit, number>>>(
	(l) => new Intl.DurationFormat(l, { style: "narrow" }),
);
const fmtInt = (n: number) => fmt.format(Math.round(n));
const fmtMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function statsRows(d: Diagnostics): [string, string | number][] {
	return [
		["Version", d.appVersion],
		["Build", d.buildMode],
		["Maps", d.db.maps],
		["Locations", fmt.format(d.db.locations)],
		["Tags", d.db.tags],
		["Commits", d.db.commits],
		["Pending saves", d.map?.dirtyCount ?? 0],
		["DB size", formatBytes(d.db.sizeBytes)],
		["Journal mode", d.db.journalMode],
		["Foreign keys", d.db.foreignKeys ? "ON" : "OFF"],
		["opensv", d.opensvVersion],
		["WebGL", d.webglRenderer],
		["DPR", d.devicePixelRatio],
		["Viewport", d.viewport],
		["JS heap", d.jsHeap ? `${fmtMB(d.jsHeap.usedBytes)} / ${fmtMB(d.jsHeap.limitBytes)}` : "N/A"],
		["Startup", `${d.startupMs} ms`],
		[
			"Uptime",
			uptimeFmt.format({
				hours: Math.floor(d.uptimeSecs / 3600),
				minutes: Math.floor(d.uptimeSecs / 60) % 60,
				seconds: d.uptimeSecs % 60,
			}),
		],
		["User agent", d.userAgent],
	];
}

function liveRows(live: LiveStats): [string, string][] {
	const { frame, deck, scene } = live;
	const rows: [string, string][] = [
		["FPS", `${frame.fps} (p95 ${frame.p95.toFixed(1)} ms, worst ${frame.worst.toFixed(0)} ms)`],
		["Long tasks", `${frame.longTasks} (${fmtInt(frame.longTaskMs)} ms)`],
	];
	if (scene) {
		rows.push(
			["Markers", `${fmtInt(scene.totalMarkers)} (${fmtInt(scene.onScreenMarkers)} on screen)`],
			["Selection overlay", fmtInt(scene.selOverlay)],
			["Layers", String(scene.layers)],
			[
				"Marker quad",
				`${scene.quadSidePx.toFixed(1)}px ${scene.markerStyle} x${scene.markerSize} @ ${scene.dpr}dpr`,
			],
			["Est fragments", `${(scene.estFragments / 1e6).toFixed(1)}M / frame`],
			["Overdraw", `${scene.overdraw.toFixed(2)}x viewport`],
		);
	} else {
		rows.push(["Markers", "no map open"]);
	}
	if (deck) {
		rows.push(
			["Deck layers drawn", `${deck.drawLayersCount} of ${deck.layersCount}`],
			["CPU / frame", `${deck.cpuTimePerFrame.toFixed(2)} ms`],
			["GPU / frame", deck.gpuTimePerFrame > 0 ? `${deck.gpuTimePerFrame.toFixed(2)} ms` : "n/a"],
			[
				"GPU memory",
				`${fmtMB(deck.gpuMemory)} (buf ${fmtMB(deck.bufferMemory)}, tex ${fmtMB(deck.textureMemory)})`,
			],
		);
	}
	return rows;
}

export function StatsForNerds({ onClose }: { onClose: () => void }) {
	const [live, setLive] = useState<LiveStats | null>(null);
	const { data: stats, error } = useAsync(collectDiagnostics, []);

	useEffect(() => {
		startFrameMeter();
		const tick = () =>
			setLive({ frame: frameStats(), deck: getDeckMetrics(), scene: computeRenderStats() });
		const iv = setInterval(tick, 1000);
		tick();
		return () => {
			clearInterval(iv);
			stopFrameMeter();
		};
	}, []);

	useDomEvent("keydown", (e) => {
		if ((e as KeyboardEvent).key === "Escape") onClose();
	});

	if (!stats && !error) return null;

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 9999,
				background: "rgba(0,0,0,0.6)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				style={{
					background: "var(--surface-2)",
					color: "var(--text-1)",
					borderRadius: 8,
					padding: "20px 28px",
					minWidth: 420,
					maxWidth: 600,
					fontSize: 13,
					lineHeight: 1.7,
					border: "1px solid var(--border-subtle)",
				}}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: 16,
					}}
				>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>
						{t("Stats for Nerds")}
					</span>
					<button
						onClick={onClose}
						style={{
							background: "none",
							border: "none",
							color: "var(--text-2)",
							cursor: "pointer",
							fontSize: 18,
							padding: "0 4px",
						}}
					>
						x
					</button>
				</div>
				{error && <div style={{ color: "var(--destructive)" }}>{String(error)}</div>}
				{stats && (
					<table style={{ width: "100%", borderCollapse: "collapse" }}>
						<tbody>
							{statsRows(stats).map(([label, value]) => (
								<tr key={label}>
									<td
										className="text-muted"
										style={{
											paddingRight: 16,
											whiteSpace: "nowrap",
											verticalAlign: "top",
										}}
									>
										{label}
									</td>
									<td className="mono" style={{ wordBreak: "break-all" }}>
										{value}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{live && (
					<>
						<div
							style={{
								fontSize: 12,
								fontWeight: 600,
								color: "var(--text-2)",
								margin: "12px 0 4px",
								textTransform: "uppercase",
								letterSpacing: "0.05em",
							}}
						>
							{t("Rendering (live)")}
						</div>
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							<tbody>
								{liveRows(live).map(([label, value]) => (
									<tr key={label}>
										<td
											className="text-muted"
											style={{
												paddingRight: 16,
												whiteSpace: "nowrap",
												verticalAlign: "top",
											}}
										>
											{label}
										</td>
										<td className="mono" style={{ wordBreak: "break-all" }}>
											{value}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}
			</div>
		</div>
	);
}
