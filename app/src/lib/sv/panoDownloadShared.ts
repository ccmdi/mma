/** Shared equirect → perspective math used by Google and Look Around download. */

function rotationMatrix(axis: [number, number, number], angle: number): number[][] {
	const rad = (angle * Math.PI) / 180;
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const t = 1 - c;
	const [x, y, z] = axis;

	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}

function applyRotation(m: number[][], v: [number, number, number]): [number, number, number] {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

function multiplyMatrices(a: number[][], b: number[][]): number[][] {
	const result = Array.from({ length: 3 }, () => Array(3).fill(0));
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			for (let k = 0; k < 3; k++) {
				result[i][j] += a[i][k] * b[k][j];
			}
		}
	}
	return result;
}

/** Reproject an equirectangular canvas to a rectilinear view. */
export function generatePerspectiveFromEquirect(
	canvas: HTMLCanvasElement,
	fov: number,
	theta: number,
	phi: number,
	outputWidth: number,
	outputHeight: number,
): HTMLCanvasElement {
	const out = document.createElement("canvas");
	out.width = outputWidth;
	out.height = outputHeight;
	const perspectiveCtx = out.getContext("2d")!;

	const f = (0.5 * outputWidth) / Math.tan((fov / 2) * (Math.PI / 180));
	const cx = outputWidth / 2;
	const cy = outputHeight / 2;

	const inputWidth = canvas.width;
	const inputHeight = canvas.height;
	const inputImageData = canvas.getContext("2d")!.getImageData(0, 0, inputWidth, inputHeight);

	const outputImageData = perspectiveCtx.createImageData(outputWidth, outputHeight);
	const outputData = outputImageData.data;

	const r1 = rotationMatrix([0, 1, 0], theta);
	const rotatedXAxis = applyRotation(r1, [1, 0, 0]);
	const r2 = rotationMatrix(rotatedXAxis, phi);
	const r = multiplyMatrices(r2, r1);

	for (let y = 0; y < outputHeight; y++) {
		for (let x = 0; x < outputWidth; x++) {
			const nx = (x - cx) / f;
			const ny = (y - cy) / f;
			const nz = 1;

			const [rx, ry, rz] = applyRotation(r, [nx, ny, nz]);
			const lon = Math.atan2(rx, rz);
			const lat = Math.asin(ry / Math.sqrt(rx * rx + ry * ry + rz * rz));

			const u = Math.floor((lon / (2 * Math.PI) + 0.5) * inputWidth);
			const v = Math.floor((lat / Math.PI + 0.5) * inputHeight);

			if (u >= 0 && u < inputWidth && v >= 0 && v < inputHeight) {
				const srcOffset = (v * inputWidth + u) * 4;
				const destOffset = (y * outputWidth + x) * 4;
				outputData[destOffset] = inputImageData.data[srcOffset];
				outputData[destOffset + 1] = inputImageData.data[srcOffset + 1];
				outputData[destOffset + 2] = inputImageData.data[srcOffset + 2];
				outputData[destOffset + 3] = 255;
			}
		}
	}

	perspectiveCtx.putImageData(outputImageData, 0, 0);
	return out;
}
