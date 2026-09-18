import { useMemo, useState, type PointerEvent, type ReactNode } from "react";
import { SegmentedControl } from "@/components/primitives/Sidebar";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Flag } from "@/components/primitives/Flag";
import { Bar } from "@/components/primitives/Bar";
import { countryName, dateTimeFmt, dayMonthFmt, fmt } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { movementLabels } from "./game";
import { getHistory } from "./storage";
import { pastStats, type TrendPoint } from "./stats";

const W = 640;
const H = 160;
const PAD = { left: 44, right: 12, top: 10, bottom: 22 };
const MAX_ROUND = 5000;
const Y_TICKS = [0, 2500, 5000];

const score = (n: number) => fmt.format(Math.round(n));

function TrendChart({ points }: { points: TrendPoint[] }) {
	const [hovered, setHovered] = useState<number | null>(null);
	const plotW = W - PAD.left - PAD.right;
	const plotH = H - PAD.top - PAD.bottom;
	const x = (i: number) => PAD.left + (i / (points.length - 1)) * plotW;
	const y = (v: number) => PAD.top + plotH - (v / MAX_ROUND) * plotH;
	const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.averageScore)}`).join("");
	const at = hovered ?? points.length - 1;
	const focus = points[at];

	const track = (e: PointerEvent<SVGSVGElement>) => {
		const box = e.currentTarget.getBoundingClientRect();
		const svgX = ((e.clientX - box.left) / box.width) * W;
		const i = Math.round(((svgX - PAD.left) / plotW) * (points.length - 1));
		setHovered(Math.max(0, Math.min(points.length - 1, i)));
	};

	return (
		<figure className="lg-stats__trend">
			<figcaption className="lg-stats__caption">{t("Average round by game")}</figcaption>
			<div className="lg-stats__chart">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					onPointerMove={track}
					onPointerLeave={() => setHovered(null)}
					role="img"
					aria-label={t("Average round by game")}
				>
					{Y_TICKS.map((v) => (
						<g key={v}>
							<line
								className="lg-stats__grid"
								x1={PAD.left}
								x2={W - PAD.right}
								y1={y(v)}
								y2={y(v)}
							/>
							<text
								className="lg-stats__tick"
								x={PAD.left - 8}
								y={y(v)}
								textAnchor="end"
								dy="0.32em"
							>
								{fmt.format(v)}
							</text>
						</g>
					))}
					<text className="lg-stats__tick" x={PAD.left} y={H - 4}>
						{dayMonthFmt.format(points[0].finishedAt)}
					</text>
					<text className="lg-stats__tick" x={W - PAD.right} y={H - 4} textAnchor="end">
						{dayMonthFmt.format(points[points.length - 1].finishedAt)}
					</text>
					<path className="lg-stats__line" d={path} />
					{hovered !== null && (
						<line
							className="lg-stats__crosshair"
							x1={x(at)}
							x2={x(at)}
							y1={PAD.top}
							y2={PAD.top + plotH}
						/>
					)}
					<circle className="lg-stats__dot" cx={x(at)} cy={y(focus.averageScore)} r={4} />
				</svg>
				{hovered !== null && (
					<div
						className="lg-stats__tooltip"
						style={{
							left: `${Math.min(Math.max((x(at) / W) * 100, 15), 85)}%`,
							top: `${(y(focus.averageScore) / H) * 100}%`,
						}}
					>
						<strong>{score(focus.averageScore)}</strong>
						<span>
							{focus.mapName} · {dateTimeFmt.format(focus.finishedAt)}
						</span>
					</div>
				)}
			</div>
		</figure>
	);
}

function Tile({ label, value }: { label: string; value: string }) {
	return (
		<div className="lg-stats__tile">
			<span className="lg-stats__tile-label">{label}</span>
			<span className="lg-stats__tile-value">{value}</span>
		</div>
	);
}

function Table({ head, rows }: { head: string[]; rows: { key: string; cells: ReactNode[] }[] }) {
	return (
		<table className="data-table">
			<thead>
				<tr>
					{head.map((h, i) => (
						<th key={h} className={i === 0 ? "data-table__fill" : "data-table__num"}>
							{h}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row.key}>
						{row.cells.map((cell, i) => (
							<td key={i} className={i === 0 ? undefined : "data-table__num"}>
								{cell}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

export function PastStats({ mapId }: { mapId: string }) {
	const [scope, setScope] = useState<"map" | "all">("map");
	const stats = useMemo(
		() => pastStats(getHistory(scope === "map" ? mapId : null)),
		[scope, mapId],
	);
	const { overall } = stats;

	return (
		<div className="lg-stats">
			<SegmentedControl
				value={scope}
				onChange={setScope}
				options={[
					{ value: "map", label: t("This map") },
					{ value: "all", label: t("All maps") },
				]}
			/>
			{overall.games === 0 ? (
				<EmptyState>{t("No finished games yet")}</EmptyState>
			) : (
				<>
					<div className="lg-stats__tiles">
						<Tile label={t("Games")} value={fmt.format(overall.games)} />
						<Tile label={t("Rounds")} value={fmt.format(overall.rounds)} />
						<Tile label={t("Average round")} value={score(overall.averageScore)} />
						<Tile label={t("Best game")} value={score(overall.bestGame)} />
						<Tile label={t("Perfect rounds")} value={fmt.format(stats.perfectRounds)} />
						{stats.bestStreak !== null && (
							<Tile label={t("Best streak")} value={fmt.format(stats.bestStreak)} />
						)}
					</div>

					{stats.trend.length > 1 && <TrendChart points={stats.trend} />}

					{stats.countries.length > 0 && (
						<Table
							head={[t("Country"), t("Rounds"), t("Accuracy"), t("Average round")]}
							rows={stats.countries.map((c) => {
								const accuracy = c.hits / c.rounds;
								return {
									key: c.code,
									cells: [
										<span className="lg-stats__country">
											<Flag code={c.code} />
											{countryName(c.code)}
										</span>,
										fmt.format(c.rounds),
										<span className="lg-stats__meter">
											<Bar value={accuracy} className="lg-stats__meter-bar" />
											{t("{n}%", { n: Math.round(accuracy * 100) })}
										</span>,
										score(c.averageScore),
									],
								};
							})}
						/>
					)}

					<Table
						head={[t("Movement"), t("Games"), t("Average round")]}
						rows={stats.modes.map((m) => ({
							key: m.mode,
							cells: [movementLabels()[m.mode], fmt.format(m.games), score(m.averageScore)],
						}))}
					/>

					{scope === "all" && (
						<Table
							head={[t("Map"), t("Games"), t("Average round"), t("Best game")]}
							rows={stats.maps.map((m) => ({
								key: m.mapId,
								cells: [m.mapName, fmt.format(m.games), score(m.averageScore), score(m.bestGame)],
							}))}
						/>
					)}
				</>
			)}
		</div>
	);
}
