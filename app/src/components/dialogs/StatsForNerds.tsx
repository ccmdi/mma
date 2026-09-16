import { useEffect, useState } from "react";
import type { ProcedureActivity } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { collectDiagnostics, engineRows, type Diagnostics } from "@/lib/diagnostics";
import { useAsync } from "@/lib/hooks/useAsync";
import { fmt, formatBytes, localeFormat } from "@/lib/util/format";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { ProgressBar } from "@/components/primitives/ProgressBar";
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

function statsRows(d: Diagnostics): [string, string | number][] {
	return [
		["Version", d.appVersion],
		["Build", d.buildMode],
		["Maps", d.db.maps],
		["Locations (saved)", fmt.format(d.db.savedLocations)],
		["Tags", d.db.tags],
		["Commits", d.db.commits],
		["Pending saves", d.map?.dirtyCount ?? 0],
		["DB size", formatBytes(d.db.sizeBytes)],
		["Location data", formatBytes(d.db.locationSizeBytes)],
		["Journal mode", d.db.journalMode],
		["Foreign keys", d.db.foreignKeys ? "ON" : "OFF"],
		["opensv", d.opensvVersion],
		["WebGL", d.webglRenderer],
		["DPR", d.devicePixelRatio],
		["Viewport", d.viewport],
		[
			"JS heap",
			d.jsHeap ? `${formatBytes(d.jsHeap.usedBytes)} / ${formatBytes(d.jsHeap.limitBytes)}` : "N/A",
		],
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
			["Fragments (estimate)", `${(scene.estFragments / 1e6).toFixed(1)}M / frame`],
			["Overdraw (estimate)", `${scene.overdraw.toFixed(2)}x viewport`],
		);
	} else {
		rows.push(["Markers", "no map open"]);
	}
	if (deck) {
		rows.push(
			["Deck layers drawn", `${deck.drawLayersCount} of ${deck.layersCount}`],
			["CPU / frame", `${deck.cpuTimePerFrame.toFixed(2)} ms`],
		);
		if (deck.gpuTimePerFrame > 0) {
			rows.push(["GPU / frame", `${deck.gpuTimePerFrame.toFixed(2)} ms`]);
		}
		rows.push([
			"GPU memory",
			`${formatBytes(deck.gpuMemory)} (buf ${formatBytes(deck.bufferMemory)}, tex ${formatBytes(deck.textureMemory)})`,
		]);
	}
	return rows;
}

function StatTable({ rows }: { rows: [string, string | number][] }) {
	return (
		<table className="stats-nerds__table">
			<tbody>
				{rows.map(([label, value]) => (
					<tr key={label}>
						<th scope="row">{label}</th>
						<td className="mono">{value}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function EngineSection({ activity }: { activity: ProcedureActivity | null }) {
	const { providers, queries, requestsPerSecond, idle } = engineRows(activity);
	if (idle) return <p className="stats-nerds__idle">{t("Engine idle")}</p>;
	return (
		<>
			{providers.map((p) => (
				<div key={p.key} className="stats-nerds__job">
					<div className="stats-nerds__job-head">
						<span className="stats-nerds__job-label">{t(p.label)}</span>
						<span className="mono">
							{fmt.format(p.done)} / {fmt.format(p.total)}
							<span className="text-muted">
								{p.failed > 0 && t({ one: ", {n} failed", other: ", {n} failed" }, { n: p.failed })}
								{p.skipped > 0 &&
									t({ one: ", {n} skipped", other: ", {n} skipped" }, { n: p.skipped })}
							</span>
						</span>
					</div>
					<ProgressBar value={p.fraction} className="stats-nerds__bar" />
					<div className="stats-nerds__job-net mono">
						{t(
							"{inflight} / {limit} in flight, {waiting} rate-waiting, {retries} retries, {instances} instances",
							{
								inflight: p.inflight,
								limit: p.inflightLimit,
								waiting: p.rateWaiting,
								retries: p.retries,
								instances: p.instances,
							},
						)}
					</div>
				</div>
			))}
			{queries.map((q) => (
				<div key={q.entry} className="stats-nerds__job">
					<div className="stats-nerds__job-head">
						<span className="stats-nerds__job-label">{q.entry}</span>
						<span className="mono">
							{q.inflight} / {q.inflightLimit}
							<span className="text-muted">
								{q.retries > 0 &&
									t({ one: ", {n} retry", other: ", {n} retries" }, { n: q.retries })}
							</span>
						</span>
					</div>
				</div>
			))}
			<div className="stats-nerds__job-net mono">
				{t("{rate} requests/s", { rate: requestsPerSecond.toFixed(1) })}
			</div>
		</>
	);
}

export function StatsForNerds({ onClose }: { onClose: () => void }) {
	const [live, setLive] = useState<LiveStats | null>(null);
	const [activity, setActivity] = useState<ProcedureActivity | null>(null);
	const { data: stats, error } = useAsync(collectDiagnostics, []);

	useEffect(() => {
		startFrameMeter();
		const tick = () => {
			setLive({ frame: frameStats(), deck: getDeckMetrics(), scene: computeRenderStats() });
			void cmd.procedureActivity().then(setActivity, () => setActivity(null));
		};
		const iv = setInterval(tick, 1000);
		tick();
		return () => {
			clearInterval(iv);
			stopFrameMeter();
		};
	}, []);

	if (!stats && !error) return null;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title={t("Stats for Nerds")} className="stats-nerds">
				{error && <div className="stats-nerds__error">{String(error)}</div>}
				<div className="stats-nerds__columns">
					<div className="stats-nerds__column">
						{stats && <StatTable rows={statsRows(stats)} />}
						{live && (
							<>
								<h3 className="stats-nerds__heading">{t("Rendering (live)")}</h3>
								<StatTable rows={liveRows(live)} />
							</>
						)}
					</div>
					<div className="stats-nerds__column">
						<h3 className="stats-nerds__heading">{t("Engine (live)")}</h3>
						<EngineSection activity={activity} />
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
