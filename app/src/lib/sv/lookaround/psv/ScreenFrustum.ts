/** Ported from lookaround-map `js/viewer/ScreenFrustum.js` (MIT). */
import { Frustum, Matrix4 } from "three";

type PsvWithRenderer = {
	renderer: {
		camera: {
			updateMatrix: () => void;
			updateMatrixWorld: () => void;
			projectionMatrix: Matrix4;
			matrixWorldInverse: Matrix4;
		};
	};
};

export class ScreenFrustum {
	readonly frustum = new Frustum();
	private readonly projScreenMatrix = new Matrix4();

	constructor(private readonly psv: PsvWithRenderer) {}

	update(yaw = 0): void {
		const camera = this.psv.renderer.camera;
		camera.updateMatrix();
		camera.updateMatrixWorld();
		this.projScreenMatrix.multiplyMatrices(
			camera.projectionMatrix,
			camera.matrixWorldInverse,
		);
		this.projScreenMatrix.multiplyMatrices(
			this.projScreenMatrix,
			new Matrix4().makeRotationY(yaw),
		);
		this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
	}
}
