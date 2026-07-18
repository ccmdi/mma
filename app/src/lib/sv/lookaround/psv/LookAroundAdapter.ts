/**
 * Adapter for Apple Look Around cube faces.
 * Ported from lookaround-map `js/viewer/LookAroundAdapter.js` (MIT).
 * JPEG-only (no HEIC worker) — lookmap serves JPEG when format is JPEG.
 */
import { Mesh, SphereGeometry, Vector3, ShaderMaterial, GLSL3, type Texture } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CONSTANTS, utils, AbstractAdapter } from "@photo-sphere-viewer/core";
import type { LookaroundPano } from "../api";
import { Face, type ImageFormatValue } from "./enums";
import { ScreenFrustum } from "./ScreenFrustum";

const NUM_FACES = 6;

type CameraFace = NonNullable<LookaroundPano["cameraMetadata"]>[number];

type PanoPayload = {
	panorama: LookaroundPano;
	url: string;
};

type AdapterPsv = {
	config: {
		panoData: {
			imageFormat: ImageFormatValue;
			apiBaseUrl: string;
			navigationCrossfadeDisablesPanning: boolean;
			navigationCrossfadeDuration: number;
			upgradeCrossfadeDuration: number;
		};
		panorama: PanoPayload;
		moveSpeed: number;
	};
	textureLoader: {
		loadFile: (url: string, onProgress?: (p: number) => void) => Promise<Blob>;
		blobToImage: (file: Blob) => Promise<HTMLImageElement>;
	};
	loader: { setProgress: (n: number) => void };
	renderer: {
		meshContainer: { children: unknown[]; remove: (m: unknown) => void; add: (m: unknown) => void };
		mesh: unknown;
		state: { vFov: number };
	};
	needsUpdate: () => void;
	setOption: (key: string, value: unknown) => void;
	addEventListener: (type: string, listener: object) => void;
};

type LookAroundPanoData = {
	imageFormat: ImageFormatValue;
	apiBaseUrl: string;
	navigationCrossfadeDisablesPanning: boolean;
	navigationCrossfadeDuration: number;
	upgradeCrossfadeDuration: number;
};

type MixAmountUniform = { value: number; elapsed: number; active: boolean };

type CrossfadeMaterial = ShaderMaterial & {
	uniforms: {
		texture1: { value: Texture | null; userData: Record<string, unknown> };
		texture2: { value: Texture | null; userData: Record<string, unknown> };
		mixAmount: MixAmountUniform;
	};
};

export class LookAroundAdapter extends AbstractAdapter<
	PanoPayload,
	LookAroundPanoData,
	Texture[],
	Mesh
> {
	static override id = "lookaround";
	static override supportsDownload = false;

	private readonly psv: AdapterPsv;
	private imageFormat: ImageFormatValue;
	private apiBaseUrl: string;
	private navigationCrossfadeDisablesPanning: boolean;
	private navigationCrossfadeDuration: number;
	private upgradeCrossfadeDuration: number;
	private panorama: LookaroundPano;
	private url: string;
	private previousFovH: number;
	private readonly screenFrustum: ScreenFrustum;
	private dynamicLoadingEnabled = true;
	private timestamp = 0;
	private mesh: Mesh | null = null;
	private meshesForFrustum: Mesh[] = [];

	constructor(psv: AdapterPsv) {
		super(psv as never);
		this.psv = psv;
		this.imageFormat = psv.config.panoData.imageFormat;
		this.apiBaseUrl = psv.config.panoData.apiBaseUrl;
		this.navigationCrossfadeDisablesPanning =
			psv.config.panoData.navigationCrossfadeDisablesPanning;
		this.navigationCrossfadeDuration = psv.config.panoData.navigationCrossfadeDuration;
		this.upgradeCrossfadeDuration = psv.config.panoData.upgradeCrossfadeDuration;
		this.panorama = psv.config.panorama.panorama;
		this.url = psv.config.panorama.url;
		this.previousFovH = this.panorama.cameraMetadata?.[0]?.fovH ?? 0;

		psv.addEventListener("position-updated", this);
		psv.addEventListener("zoom-updated", this);
		psv.addEventListener("before-rotate", this);
		psv.addEventListener("before-render", this);

		this.screenFrustum = new ScreenFrustum(psv as never);
	}

	override destroy(): void {
		/* no HEIC worker */
	}

	override supportsTransition(): boolean {
		return false;
	}

	override supportsPreload(): boolean {
		return false;
	}

	override loadTexture(panoramaMetadata: PanoPayload) {
		this.panorama = panoramaMetadata.panorama;
		this.url = panoramaMetadata.url;

		const promises: Promise<Texture>[] = [];
		const progress = [0, 0, 0, 0, 0, 0];
		const startZoom = 5;
		for (let i = 0; i < NUM_FACES; i++) {
			promises.push(this.loadOneTexture(startZoom, i, progress));
		}
		return Promise.all(promises).then((texture) => {
			this.recreateMeshIfNecessary();
			return { panorama: panoramaMetadata, texture };
		});
	}

	private async loadOneTexture(
		zoom: number,
		faceIdx: number,
		progress: number[] | null = null,
	): Promise<Texture> {
		// JPEG faces from lookmap — never request HEIC.
		const faceUrl = `${this.apiBaseUrl}${this.url}${zoom}/${faceIdx}/`;
		void this.imageFormat; // kept for API parity; always JPEG in MMA

		return this.psv.textureLoader
			.loadFile(faceUrl, (p) => {
				if (progress) {
					progress[faceIdx] = p;
					this.psv.loader.setProgress(utils.sum(progress) / 4);
				}
			})
			.then(async (file) => {
				const img = await this.psv.textureLoader.blobToImage(file);
				const texture = utils.createTexture(img);
				texture.userData = { zoom, url: this.url };
				return texture;
			});
	}

	private recreateMeshIfNecessary(): void {
		const fovH = this.panorama.cameraMetadata?.[0]?.fovH;
		if (fovH == null || this.previousFovH === fovH) {
			if (fovH != null) this.previousFovH = fovH;
			return;
		}
		const mesh = this.createMesh(this.psv.config.panoData);
		mesh.userData = { photoSphereViewer: true };

		mesh.updateMatrixWorld(true);

		this.psv.renderer.mesh = mesh;
		const oldMesh = this.psv.renderer.meshContainer.children[0];
		this.psv.renderer.meshContainer.remove(oldMesh);
		this.psv.renderer.meshContainer.add(mesh);
		this.previousFovH = fovH;
	}

	override createMesh(_panoData: LookAroundPanoData, scale = 1): Mesh {
		const radius = CONSTANTS.SPHERE_RADIUS * scale;
		const geometries = [];
		this.meshesForFrustum = [];
		const params: Array<{
			phiStart: number;
			phiLength: number;
			thetaStart: number;
			thetaLength: number;
		}> = [];

		const cams = this.panorama.cameraMetadata ?? [];
		for (let i = 0; i < NUM_FACES; i++) {
			const cam = cams[i] as CameraFace;
			params.push({
				phiStart: (cam.yaw ?? 0) - (cam.fovS ?? 0) / 2 - Math.PI / 2,
				phiLength: cam.fovS ?? 0,
				thetaStart: Math.PI / 2 - (cam.fovH ?? 0) / 2 - (cam.cy ?? 0),
				thetaLength: cam.fovH ?? 0,
			});

			if (i > 0 && i < Face.Top) {
				const overlap =
					params[i - 1]!.phiStart + params[i - 1]!.phiLength - params[i]!.phiStart;
				params[i - 1]!.phiLength -= overlap;
			}

			const faceGeom = new SphereGeometry(
				radius,
				24,
				32,
				params[i]!.phiStart,
				params[i]!.phiLength,
				params[i]!.thetaStart,
				params[i]!.thetaLength,
			).scale(-1, 1, 1);

			if (i === Face.Top || i === Face.Bottom) {
				faceGeom.rotateX(-(cam.pitch ?? 0));
				faceGeom.rotateZ(-(cam.roll ?? 0));
			}

			geometries.push(faceGeom);
			this.meshesForFrustum.push(new Mesh(faceGeom, []));
		}

		const mergedGeometry = mergeGeometries(geometries, true);
		const mesh = new Mesh(mergedGeometry, this.createPanoFaceMaterials());
		this.mesh = mesh;
		return mesh;
	}

	override setTexture(
		mesh: Mesh,
		textureData: { texture: Texture[] },
		_transition?: boolean,
	): void {
		this.doMovementCrossfade();
		for (let i = 0; i < NUM_FACES; i++) {
			if (textureData.texture[i]) {
				(mesh.material as CrossfadeMaterial[])[i]!.uniforms.texture1.value =
					textureData.texture[i]!;
			}
		}
		this.refresh();
	}

	override setTextureOpacity(mesh: Mesh, opacity: number): void {
		for (let i = 0; i < NUM_FACES; i++) {
			const mat = (mesh.material as CrossfadeMaterial[])[i]!;
			mat.opacity = opacity;
			mat.transparent = opacity < 1;
		}
	}

	override disposeTexture(textureData: { texture?: Texture[] }): void {
		textureData.texture?.forEach((texture) => texture.dispose());
	}

	disposeMesh(_mesh: Mesh): void {}

	handleEvent(e: { type: string; timestamp?: number }): void {
		switch (e.type) {
			case "before-rotate":
			case "zoom-updated":
				this.refresh();
				break;
			case "before-render":
				this.onBeforeRender(e);
				break;
		}
	}

	private onBeforeRender(e: { timestamp?: number }): void {
		if (!this.mesh || e.timestamp == null) return;
		const elapsed = e.timestamp - this.timestamp;
		this.timestamp = e.timestamp;

		let needsUpdate = false;
		for (let i = 0; i < NUM_FACES; i++) {
			const mat = (this.mesh.material as CrossfadeMaterial[])[i]!;
			if (mat.uniforms.mixAmount.active) {
				needsUpdate = true;
				if (mat.uniforms.mixAmount.elapsed > this.upgradeCrossfadeDuration) {
					mat.uniforms.mixAmount.active = false;
					mat.uniforms.mixAmount.value = 0;
					mat.uniforms.mixAmount.elapsed = 0;
				} else {
					mat.uniforms.mixAmount.value =
						1 - mat.uniforms.mixAmount.elapsed / this.upgradeCrossfadeDuration;
					mat.uniforms.mixAmount.elapsed += elapsed;
				}
			}
		}
		if (needsUpdate) this.psv.needsUpdate();
	}

	refresh(): void {
		if (!this.mesh) return;
		if ((this.mesh.material as unknown[]).length === 0) return;
		if (!this.dynamicLoadingEnabled) return;

		const visibleFaces = this.getVisibleFaces();
		if (this.psv.renderer.state.vFov < 55) {
			this.refreshFaces(visibleFaces, 0);
		} else {
			this.refreshFaces(visibleFaces, 2);
		}
	}

	private refreshFaces(faces: number[], zoom: number): void {
		if (!this.mesh) return;
		for (const faceIdx of faces) {
			const mat = (this.mesh.material as CrossfadeMaterial[])[faceIdx]!;
			const tex = mat.uniforms.texture1.value;
			if (
				tex &&
				(tex.userData.zoom as number) > zoom &&
				!tex.userData.refreshing
			) {
				tex.userData.refreshing = true;
				const oldUrl = tex.userData.url as string;
				void this.loadOneTexture(zoom, faceIdx).then((texture) => {
					if (mat.uniforms.texture1.value?.userData.url === oldUrl) {
						this.blendTexture(mat, texture);
						this.psv.needsUpdate();
					}
				});
			}
		}
	}

	private blendTexture(mat: CrossfadeMaterial, newTexture: Texture): void {
		mat.uniforms.mixAmount.value = 1;
		mat.uniforms.mixAmount.active = true;
		mat.uniforms.texture2.value = mat.uniforms.texture1.value;
		mat.uniforms.texture1.value = newTexture;
		mat.uniforms.texture1.userData.refreshing = false;
	}

	private createPanoFaceMaterials(): CrossfadeMaterial[] {
		const materials: CrossfadeMaterial[] = Array(NUM_FACES) as CrossfadeMaterial[];
		for (let i = 0; i < NUM_FACES; i++) {
			const material = this.createCrossfadeMaterial();
			material.polygonOffset = true;
			material.polygonOffsetUnits = 1;
			material.polygonOffsetFactor = i * 2;
			materials[i] = material;
		}
		return materials;
	}

	private createCrossfadeMaterial(): CrossfadeMaterial {
		return new ShaderMaterial({
			vertexShader: `
				out vec2 vTexCoord;
				void main() {
					vTexCoord = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: `
				in vec2 vTexCoord;
				uniform sampler2D texture1;
				uniform sampler2D texture2;
				uniform float mixAmount;
				out vec4 FragColor;
				void main() {
					vec4 color1 = texture(texture1, vTexCoord);
					vec4 color2 = texture(texture2, vTexCoord);
					FragColor = mix(color1, color2, mixAmount);
				}
			`,
			uniforms: {
				texture1: { value: null, userData: {} },
				texture2: { value: null, userData: {} },
				mixAmount: { value: 0.0, elapsed: 0.0, active: false },
			} as CrossfadeMaterial["uniforms"],
			glslVersion: GLSL3,
		}) as CrossfadeMaterial;
	}

	private getVisibleFaces(): number[] {
		this.screenFrustum.update(this.panorama.heading ?? 0);
		const point = new Vector3();
		const visibleFaces: number[] = [];
		for (let meshIdx = 0; meshIdx < this.meshesForFrustum.length; meshIdx++) {
			const mesh = this.meshesForFrustum[meshIdx]!;
			mesh.updateMatrixWorld();
			const position = mesh.geometry.getAttribute("position");
			for (let i = 0; i < position.count; i++) {
				point.fromBufferAttribute(position, i);
				if (this.screenFrustum.frustum.containsPoint(point)) {
					visibleFaces.push(meshIdx);
					break;
				}
			}
		}
		return visibleFaces;
	}

	private doMovementCrossfade(): void {
		if (this.navigationCrossfadeDuration < 1) return;
		const psvCanvas = document.querySelector(".psv-canvas") as HTMLCanvasElement | null;
		if (!psvCanvas) return;
		const crossfadeCanvas = document.querySelector(
			"#crossfade-canvas",
		) as HTMLCanvasElement | null;
		if (!crossfadeCanvas) return;

		crossfadeCanvas.width = psvCanvas.clientWidth;
		crossfadeCanvas.height = psvCanvas.clientHeight;
		crossfadeCanvas.style.display = "block";
		const ctx = crossfadeCanvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, crossfadeCanvas.width, crossfadeCanvas.height);
		crossfadeCanvas.style.opacity = "1";
		ctx.drawImage(psvCanvas, 0, 0, crossfadeCanvas.width, crossfadeCanvas.height);

		const prevMoveSpeed = this.psv.config.moveSpeed;
		if (this.navigationCrossfadeDisablesPanning) {
			this.psv.setOption("moveSpeed", 0);
		}
		const animStart = Date.now();
		const interval = window.setInterval(() => {
			const elapsed = Date.now() - animStart;
			if (elapsed > this.navigationCrossfadeDuration) {
				crossfadeCanvas.style.display = "none";
				this.psv.setOption("moveSpeed", prevMoveSpeed);
				window.clearInterval(interval);
				return;
			}
			crossfadeCanvas.style.opacity = String(
				1 - elapsed / this.navigationCrossfadeDuration,
			);
		}, 16.6666);
	}
}
