/**
 * Click-to-go + keyboard movement between Look Around panoramas.
 * Ported from lookaround-map `js/viewer/MovementPlugin.js` (MIT).
 */
import { AbstractPlugin } from "@photo-sphere-viewer/core";
import { Vector2 } from "three";
import type { LookaroundPano } from "../api";
import { CameraType } from "./enums";
import { DEG2RAD, distanceBetween, enuToPhotoSphere, geodeticToEnu, wrap } from "./geo";
import { MOVEMENT_MARKER_URL } from "./marker";
import { inferCameraType } from "./misc";
import { ScreenFrustum } from "./ScreenFrustum";

const MARKER_ID = "0";
const MAX_DISTANCE = 100;

type MarkerPlugin = {
	addMarker: (cfg: Record<string, unknown>) => void;
	updateMarker: (cfg: Record<string, unknown>) => void;
	markers: Record<string, { state: { visible: boolean }; config: { data: LookaroundPano | null } }>;
};

type MovementPsv = {
	plugins: { markers: MarkerPlugin };
	config: { panoData: { apiBaseUrl: string } };
	container: HTMLElement;
	parent: HTMLElement;
	state: { size: { width: number; height: number } };
	dataHelper: {
		viewerCoordsToVector3: (c: { x: number; y: number }) => unknown;
		vector3ToSphericalCoords: (v: unknown) => { pitch: number; yaw: number };
		sphericalCoordsToViewerCoords: (p: {
			pitch: number;
			yaw: number;
		}) => { x: number; y: number };
	};
	getPosition: () => { yaw: number; pitch: number };
	addEventListener: (type: string, cb: (e: unknown) => void) => void;
	navigateTo: (pano: LookaroundPano) => Promise<void>;
	dispatchEvent?: (e: Event) => void;
};

type NearbyEntry = {
	pano: LookaroundPano;
	enu: [number, number, number];
	position: { distance: number; pitch: number; yaw: number };
	scale: number;
};

export class MovementPlugin extends AbstractPlugin {
	static override id = "movement";

	private readonly psv: MovementPsv;
	private readonly abortController = new AbortController();
	private readonly marker: MovementPsv["plugins"]["markers"]["markers"][string];
	private readonly screenFrustum: ScreenFrustum;
	private lastMousePosition: { pitch: number; yaw: number } | null = null;
	private mouseHasMoved = false;
	private lastProcessedMoveEvent = 0;
	private movementEnabled = true;
	private readonly canMoveWithKeyboard: boolean;
	private nearbyPanos: NearbyEntry[] = [];

	constructor(psv: MovementPsv, options: { canMoveWithKeyboard?: boolean }) {
		super(psv as never);
		this.psv = psv;
		this.canMoveWithKeyboard = options.canMoveWithKeyboard ?? false;

		psv.plugins.markers.addMarker({
			id: MARKER_ID,
			position: { yaw: 0, pitch: 0 },
			size: { width: 1, height: 1 },
			scale: { zoom: [0.5, 1] },
			image: MOVEMENT_MARKER_URL,
			opacity: 0.4,
			data: null,
			visible: false,
		});
		this.marker = psv.plugins.markers.markers[MARKER_ID]!;

		psv.container.addEventListener("mousemove", (e) => this.onMouseMove(e));
		psv.addEventListener("click", async (e) => {
			await this.onClick(e as { data: { rightclick?: boolean; pitch: number; yaw: number } });
		});
		psv.parent.addEventListener(
			"keydown",
			async (e) => {
				await this.onKeyDown(e as KeyboardEvent);
			},
			{ signal: this.abortController.signal },
		);

		this.screenFrustum = new ScreenFrustum(psv as never);
	}

	updatePanoMarkers(refPano: LookaroundPano, panos: LookaroundPano[]): void {
		this.nearbyPanos = [];
		const cameraHeight = this.getCameraHeight(refPano);
		const refEle = refPano.elevation ?? 0;

		for (const pano of panos) {
			if (refPano.lat === pano.lat && refPano.lon === pano.lon) continue;

			const deltaEle = (pano.elevation ?? refEle) - refEle;
			const enu = geodeticToEnu(
				pano.lon,
				pano.lat,
				deltaEle,
				refPano.lon,
				refPano.lat,
				cameraHeight,
			);
			const position = enuToPhotoSphere(enu, 0);
			if (position.distance > MAX_DISTANCE) continue;

			const scale = 0.05 + (0.5 - (0.5 * position.distance) / 100);
			this.nearbyPanos.push({ pano, enu, position, scale });
		}
	}

	override destroy(): void {
		this.abortController.abort();
		super.destroy();
	}

	private getCameraHeight(pano: LookaroundPano): number {
		switch (inferCameraType(pano)) {
			case CameraType.SmallCam:
			case CameraType.LowCam:
				return 2.2;
			case CameraType.Backpack:
				return 2;
			case CameraType.BigCam:
			default:
				return 2.4;
		}
	}

	private onMouseMove(e: MouseEvent): void {
		this.mouseHasMoved = true;
		const updateLimit = 1000 / 60.0;
		const now = Date.now();
		if (now - this.lastProcessedMoveEvent <= updateLimit) return;
		this.lastProcessedMoveEvent = now;

		const rect = this.psv.container.getBoundingClientRect();
		const vector = this.psv.dataHelper.viewerCoordsToVector3({
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
		});
		if (vector != null) {
			const position = this.psv.dataHelper.vector3ToSphericalCoords(vector);
			this.lastMousePosition = position;
			this.mouseMovedTo(position);
		} else {
			this.hideMarker();
		}
	}

	private mouseMovedTo(position: { pitch: number; yaw: number }): void {
		if (!this.nearbyPanos.length || !this.movementEnabled) return;
		const closest = this.getClosestPanoMarker(position);
		if (!closest) {
			this.hideMarker();
			return;
		}
		this.psv.plugins.markers.updateMarker({
			id: MARKER_ID,
			position: { pitch: closest.position.pitch, yaw: closest.position.yaw },
			size: { width: 100 * closest.scale, height: 100 * closest.scale },
			visible: true,
			data: closest.pano,
		});
	}

	private async onClick(e: {
		data: { rightclick?: boolean; pitch: number; yaw: number };
	}): Promise<void> {
		if (e.data.rightclick || !this.movementEnabled) return;

		if (!this.marker.state.visible || !this.marker.config.data) {
			if (this.mouseHasMoved) return;
			const closest = this.getClosestPanoMarker({
				pitch: e.data.pitch,
				yaw: e.data.yaw,
			});
			if (closest) await this.navigateTo(closest.pano);
		} else {
			const pano = this.marker.config.data;
			this.hideMarker();
			this.movementEnabled = false;
			await this.navigateTo(pano);
			this.movementEnabled = true;
			if (this.lastMousePosition) this.mouseMovedTo(this.lastMousePosition);
		}
	}

	private async onKeyDown(e: KeyboardEvent): Promise<void> {
		if (!this.movementEnabled || !this.canMoveWithKeyboard) return;
		const direction = this.keyToDirection(e.key);
		if (direction === null) return;
		const position = this.psv.getPosition();
		let yaw = Math.PI - (position.yaw + Math.PI / 2);
		yaw += direction;
		await this.moveInDirection(yaw);
	}

	async moveInDirection(
		yaw: number,
		maxDist = 25,
		tolerance = 30 * DEG2RAD,
	): Promise<LookaroundPano | null> {
		const pano = this.getClosestPanoInDirection(yaw, 0, maxDist, tolerance);
		if (pano) await this.navigateTo(pano);
		return pano;
	}

	getClosestPanoInDirection(
		yaw: number,
		minDistance = 0,
		maxDistance = 25,
		tolerance = 30 * DEG2RAD,
	): LookaroundPano | null {
		yaw = wrap(yaw);
		let closestDist = Infinity;
		let bestPano: LookaroundPano | null = null;
		for (const entry of this.nearbyPanos) {
			if (entry.position.distance > maxDistance || entry.position.distance < minDistance) {
				continue;
			}
			const enuVec = new Vector2(entry.enu[0], entry.enu[1]);
			const angle = enuVec.angle();
			const diff = angle - yaw;
			if (Math.abs(diff) < tolerance && closestDist > entry.position.distance) {
				closestDist = entry.position.distance;
				bestPano = entry.pano;
			}
		}
		return bestPano;
	}

	private keyToDirection(key: string): number | null {
		switch (key) {
			case "ArrowUp":
				return 0;
			case "ArrowLeft":
				return Math.PI / 2;
			case "ArrowDown":
				return Math.PI;
			case "ArrowRight":
				return -Math.PI / 2;
			default:
				return null;
		}
	}

	private async navigateTo(pano: LookaroundPano): Promise<void> {
		await this.psv.navigateTo(pano);
		this.dispatchEvent(new CustomEvent("moved", { detail: pano }) as never);
	}

	private getClosestPanoMarker(
		position: { pitch: number; yaw: number },
	): NearbyEntry | null {
		this.screenFrustum.update();
		let closest: NearbyEntry | null = null;
		let closestDist = Infinity;
		for (const entry of this.nearbyPanos) {
			if (this.markerPositionIsOffScreen(entry.position)) continue;
			const distance = distanceBetween(
				position.pitch,
				position.yaw,
				entry.position.pitch,
				entry.position.yaw,
				1,
			);
			if (distance < closestDist) {
				closestDist = distance;
				closest = entry;
			}
		}
		return closest;
	}

	private markerPositionIsOffScreen(panoPosition: {
		pitch: number;
		yaw: number;
	}): boolean {
		const viewerCoords = this.psv.dataHelper.sphericalCoordsToViewerCoords({
			pitch: panoPosition.pitch,
			yaw: panoPosition.yaw,
		});
		return (
			viewerCoords.x > this.psv.state.size.width ||
			viewerCoords.x < 0 ||
			viewerCoords.y > this.psv.state.size.height ||
			viewerCoords.y < 0
		);
	}

	private hideMarker(): void {
		this.psv.plugins.markers.updateMarker({
			id: MARKER_ID,
			visible: false,
			data: null,
		});
	}
}
