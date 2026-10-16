/* eslint-disable react-refresh/only-export-components */
import { useRef, useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { mdiCloudDownloadOutline } from "@mdi/js";
import { Tag } from "@/store/tag";
import { cmd } from "@/lib/commands";
import type { ValiCountryStatus, ValiLocation } from "@/bindings.gen";
import { createLocation } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import { mapStorage } from "@/plugins/pluginStorage";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";
import { Sidebar } from "@/components/primitives/Sidebar";
import { ValiDownloadDialog } from "./ValiDownloadDialog";
import { log } from "@/lib/util/log";
import "./vali.css";
import { t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";

// The embedded Vali GUI (vendored bundle, ?host=mma) owns the whole flow: definition
// editor, tag input, generate button, progress. This side is the bridge, and keeps the
// definition and tag with the map:
//   <- iframe  { type: "vali:ready" }
//   -> iframe  { type: "vali:load", definition?, tag? }
//   <- iframe  { type: "vali:state", definition, tag }
//   <- iframe  { type: "vali:generate", data, tag }
//   <- iframe  { type: "vali:cancel" }
//   -> iframe  { type: "vali:progress", progress } (forwarded vali-progress events)
//   -> iframe  { type: "vali:done", count } | { type: "vali:error", message }

const VALIG_URL = "/valig/index.html?host=mma";

/** What a map keeps of its Vali setup. Absent fields mean the GUI's defaults. */
interface ValiProject {
	definition?: unknown;
	tag?: string;
}

/** The tag the GUI shares across maps; a map reads it until it saves its own setup. */
const SHARED_TAG_KEY = "vali-mma-tag";

function loadValiProject(): ValiProject {
	const sharedTag = localStorage.getItem(SHARED_TAG_KEY);
	return mapStorage("vali").get<ValiProject>(
		"project",
		sharedTag === null ? {} : { tag: sharedTag },
	);
}

function saveValiProject(project: ValiProject) {
	void mapStorage("vali").set("project", project);
}

async function importLocations(valiLocs: ValiLocation[], tagName: string): Promise<number> {
	let tagId: number | null = null;
	if (tagName) {
		[tagId] = await Tag.create([{ name: tagName }]);
	}
	const locations = valiLocs.map((v) =>
		createLocation({
			lat: v.lat,
			lng: v.lng,
			heading: v.heading,
			...(v.zoom != null ? { zoom: v.zoom } : {}),
			...(v.pitch != null ? { pitch: v.pitch } : {}),
			...(v.panoId != null ? { panoId: v.panoId } : {}),
			...(v.tags.length ? { extra: { tags: v.tags } } : {}),
			flags: LocationFlag.LoadAsPanoId,
			...(tagId != null ? { tags: [tagId] } : {}),
		}),
	);
	await MMA.Location.add(locations);
	return locations.length;
}

export type ValiBusy = "generate" | "download" | null;

export function valiMessageAction(
	type: unknown,
	busy: ValiBusy,
): "cancel" | "generate" | "reject" | "ignore" {
	if (type === "vali:cancel") return "cancel";
	if (type !== "vali:generate") return "ignore";
	if (busy === null) return "generate";
	return busy === "download" ? "reject" : "ignore";
}

export function ValiSidebar({ onClose }: { onClose: () => void }) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [downloadOpen, setDownloadOpen] = useState(false);
	// null = unknown: the check hasn't answered yet, or it failed. Never flag on a guess.
	const [stale, setStale] = useState<ValiCountryStatus[] | null>(null);
	// The ref answers the message handler synchronously; the state only drives the button.
	const busyRef = useRef<ValiBusy>(null);
	const runRef = useRef<number | null>(null);
	const [busy, setBusyState] = useState<ValiBusy>(null);
	const setBusy = (b: ValiBusy) => {
		busyRef.current = b;
		setBusyState(b);
	};

	useEffect(() => {
		const onMessage = async (e: MessageEvent) => {
			const gui = iframeRef.current?.contentWindow;
			if (!gui || e.source !== gui) return;
			const post = (msg: unknown) => gui.postMessage(msg, "*");
			if (e.data?.type === "vali:ready") {
				post({ type: "vali:load", ...loadValiProject() });
				return;
			}
			if (e.data?.type === "vali:state") {
				saveValiProject({ definition: e.data.definition, tag: String(e.data.tag ?? "") });
				return;
			}
			const action = valiMessageAction(e.data?.type, busyRef.current);
			if (action === "ignore") return;
			if (action === "cancel") {
				if (runRef.current !== null) void cmd.runCancel(runRef.current);
				return;
			}
			if (action === "reject") {
				post({ type: "vali:error", message: t("A coverage data download is still running.") });
				return;
			}
			setBusy("generate");
			const unlisten = await listen("vali-progress", (ev) =>
				post({ type: "vali:progress", progress: ev.payload }),
			);
			try {
				const runId = await cmd.runReserve();
				runRef.current = runId;
				const locations = await cmd.valiGenerate(JSON.stringify(e.data.data), runId);
				const count = await importLocations(locations, String(e.data.tag ?? ""));
				post({ type: "vali:done", count });
			} catch (err) {
				log.error("[vali] generate failed:", err);
				post({ type: "vali:error", message: String(err) });
			} finally {
				runRef.current = null;
				unlisten();
				setBusy(null);
			}
		};
		const handleMessage = (e: MessageEvent) => void onMessage(e);
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, []);

	// Metadata-only, so it costs a couple of listing requests. Offline leaves it unknown.
	const checkStale = useCallback(() => {
		cmd
			.valiDataStatus()
			.then(setStale)
			.catch((e) => {
				log.debug("[vali] data status unavailable:", e);
				setStale(null);
			});
	}, []);

	useEffect(checkStale, [checkStale]);

	const outdated = (stale?.length ?? 0) > 0;

	const reset = () => {
		saveValiProject({});
		iframeRef.current?.contentWindow?.postMessage({ type: "vali:load" }, "*");
	};

	return (
		<Sidebar
			title={t("Vali")}
			onBack={onClose}
			className="vali-sidebar"
			flush
			actions={
				<>
					<ConfirmButton variant="ghost" small disabled={busy === "generate"} onConfirm={reset}>
						{t("Reset")}
					</ConfirmButton>
					<IconButton
						className="vali-sidebar__download"
						icon={mdiCloudDownloadOutline}
						label={t("Download coverage data")}
						tooltip={outdated ? t("Coverage data is out of date") : t("Download coverage data")}
						tooltipSide="bottom"
						disabled={busy === "generate"}
						onClick={() => setDownloadOpen(true)}
					>
						{outdated && <span className="vali-sidebar__badge" />}
					</IconButton>
				</>
			}
		>
			<div className="vali-sidebar__iframe-wrap">
				<iframe ref={iframeRef} src={VALIG_URL} title={t("Vali")} />
			</div>
			<ValiDownloadDialog
				open={downloadOpen}
				onOpenChange={setDownloadOpen}
				running={busy === "download"}
				onRunningChange={(running) => setBusy(running ? "download" : null)}
				stale={stale}
				onDownloaded={checkStale}
			/>
		</Sidebar>
	);
}
