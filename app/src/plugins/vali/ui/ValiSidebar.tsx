import { useState, useRef, useCallback, useEffect } from "react";
import { Command, type Child } from "@tauri-apps/plugin-shell";
import { cmd } from "@/lib/commands";
import { createLocation } from "@/types";
import { getCurrentMap, createTags } from "@/store/useMapStore";
import { Icon } from "@/components/primitives/Icon";
import { mdiArrowLeft } from "@mdi/js";
import "./vali.css";

type Phase = "editing" | "generating" | "done" | "error";

interface LogLine {
	text: string;
	isError: boolean;
}

interface ValiLocation {
	lat: number;
	lng: number;
	heading?: number;
	pitch?: number;
	zoom?: number;
	panoId?: string;
}

const VALIG_URL = "https://valig.vercel.app";
const OUTPUT_SUFFIX = "-locations.json";

let sessionPhase: Phase = "editing";
let sessionLines: LogLine[] = [];
let sessionChild: Child | null = null;

export function ValiSidebar({ onClose }: { onClose: () => void }) {
	const [phase, setPhase] = useState<Phase>(sessionPhase);
	const [lines, setLines] = useState<LogLine[]>(sessionLines);
	const [error, setError] = useState("");
	const [importCount, setImportCount] = useState(0);
	const logRef = useRef<HTMLDivElement>(null);
	const childRef = useRef<Child | null>(sessionChild);

	useEffect(() => {
		sessionPhase = phase;
	}, [phase]);
	useEffect(() => {
		sessionLines = lines;
	}, [lines]);

	// Auto-scroll log to bottom
	useEffect(() => {
		if (logRef.current) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [lines]);

	const appendLine = useCallback((text: string, isError = false) => {
		setLines((prev) => [...prev, { text, isError }]);
	}, []);

	const importLocations = useCallback(
		async (outputPath: string) => {
			try {
				const raw = await cmd.readFile(outputPath);
				const valiLocs: ValiLocation[] = JSON.parse(raw);
				let tagId: number | null = null;
				const tagName = getCurrentMap()?.meta.settings?.generatedLocationTag;
				if (tagName) {
					tagId = (await createTags([tagName]))[0].id;
				}
				const locations = valiLocs.map((v) =>
					createLocation({
						lat: v.lat,
						lng: v.lng,
						heading: v.heading ?? 0,
						pitch: v.pitch ?? 0,
						zoom: v.zoom ?? 0,
						panoId: v.panoId ?? null,
						...(tagId != null ? { tags: [tagId] } : {}),
					}),
				);
				MMA.addLocations(locations);
				setImportCount(locations.length);
			} catch (e) {
				setError(`Failed to import locations: ${e}`);
				setPhase("error");
			}
		},
		[],
	);

	const handleGenerate = useCallback(async () => {
		setError("");
		setImportCount(0);

		let json: string;
		try {
			json = await navigator.clipboard.readText();
		} catch {
			setError("Could not read clipboard. Copy the JSON from Vali first.");
			return;
		}

		try {
			JSON.parse(json);
		} catch {
			setError(
				"Clipboard does not contain valid JSON. Click the copy button in Vali's Definition panel first.",
			);
			return;
		}

		let tempPath: string;
		try {
			tempPath = await cmd.writeTempFile("vali_config.json", json);
		} catch (e) {
			setError(`Failed to write config: ${e}`);
			return;
		}

		const outputPath = tempPath.replace(/\.json$/, OUTPUT_SUFFIX);

		setPhase("generating");
		setLines([]);

		try {
			const command = Command.create("vali", ["generate", "--file", tempPath]);

			command.stdout.on("data", (line) => appendLine(line));
			command.stderr.on("data", (line) => appendLine(line, true));

			command.on("close", (data) => {
				childRef.current = null;
				sessionChild = null;
				if (data.code === 0) {
					setPhase("done");
					importLocations(outputPath);
				} else {
					setPhase("error");
					setError(`Vali exited with code ${data.code}`);
				}
			});

			command.on("error", (err) => {
				childRef.current = null;
				sessionChild = null;
				setPhase("error");
				setError(String(err));
			});

			const child = await command.spawn();
			childRef.current = child;
			sessionChild = child;
		} catch (e) {
			setPhase("error");
			setError(`Failed to start Vali: ${e}`);
		}
	}, [appendLine, importLocations]);

	const handleKill = useCallback(async () => {
		if (childRef.current) {
			await childRef.current.kill();
			childRef.current = null;
			sessionChild = null;
			setPhase("error");
			setError("Cancelled by user");
		}
	}, []);

	const handleReset = useCallback(() => {
		setPhase("editing");
		setLines([]);
		setError("");
		sessionPhase = "editing";
		sessionLines = [];
	}, []);

	const handleClose = useCallback(() => {
		childRef.current?.kill();
		childRef.current = null;
		sessionChild = null;
		sessionPhase = "editing";
		sessionLines = [];
		onClose();
	}, [onClose]);

	return (
		<section className="map-sidebar vali-sidebar">
			<header className="vali-sidebar__header">
				<button className="icon-button" onClick={handleClose}>
					<Icon path={mdiArrowLeft} />
				</button>
				<h2 className="vali-sidebar__title">Vali</h2>
			</header>

			<div className="vali-sidebar__body">
				{phase === "editing" && (
					<>
						<div className="vali-sidebar__iframe-wrap">
							<iframe
								src={VALIG_URL}
								title="Vali Configuration Editor"
								allow="clipboard-write; clipboard-read"
							/>
						</div>
						<div className="vali-sidebar__actions">
							{error && <div className="vali-sidebar__error">{error}</div>}
							<button className="button button--primary" onClick={handleGenerate}>
								Generate
							</button>
						</div>
					</>
				)}

				{(phase === "generating" || phase === "done" || phase === "error") && (
					<div className="vali-sidebar__output">
						<div className="vali-sidebar__output-header">
							Output
							<span className="vali-sidebar__output-status">
								{phase === "generating" && (
									<>
										<span className="vali-sidebar__spinner" /> Running...
									</>
								)}
								{phase === "done" &&
									(importCount > 0 ? `Imported ${importCount} locations` : "Complete")}
								{phase === "error" && "Failed"}
							</span>
						</div>

						<div className="vali-sidebar__log" ref={logRef}>
							{lines.map((line, i) => (
								<div
									key={i}
									className={`vali-sidebar__log-line${line.isError ? " vali-sidebar__log-line--error" : ""}`}
								>
									{line.text}
								</div>
							))}
							{phase === "error" && error && (
								<div className="vali-sidebar__log-line vali-sidebar__log-line--error">{error}</div>
							)}
						</div>

						<div className="vali-sidebar__output-actions">
							{phase === "generating" ? (
								<button className="button" onClick={handleKill}>
									Cancel
								</button>
							) : (
								<button className="button" onClick={handleReset}>
									Back to Editor
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
