use rayon::prelude::*;

/// Precomputed remap table for equirectangular -> perspective projection.
/// For each output pixel (u, v), stores the source (x, y) in the equirectangular image.
pub struct RemapTable {
    pub out_w: u32,
    pub out_h: u32,
    /// Flat array of [src_x, src_y] pairs, length = out_w * out_h
    pub map: Vec<[f32; 2]>,
}

impl RemapTable {
    /// Build a remap table for a perspective view.
    /// `fov_deg`: field of view in degrees
    /// `yaw_deg`: horizontal rotation (THETA)
    /// `pitch_deg`: vertical rotation (PHI)
    /// `pano_w`, `pano_h`: equirectangular source dimensions
    pub fn new(
        out_w: u32, out_h: u32,
        fov_deg: f32, yaw_deg: f32, pitch_deg: f32,
        pano_w: u32, pano_h: u32,
    ) -> Self {
        let f = 0.5 * out_w as f32 / (0.5 * fov_deg.to_radians()).tan();
        let cx = (out_w as f32 - 1.0) / 2.0;
        let cy = (out_h as f32 - 1.0) / 2.0;

        // K_inv = inverse of intrinsic matrix [[f,0,cx],[0,f,cy],[0,0,1]]
        let k_inv = [
            [1.0 / f,     0.0, -cx / f],
            [    0.0, 1.0 / f, -cy / f],
            [    0.0,     0.0,     1.0],
        ];

        // Rodrigues rotation: R = R2(pitch around rotated X) * R1(yaw around Y)
        let r1 = rodrigues_y(yaw_deg.to_radians());
        let r2 = rodrigues_axis(mat_vec(&r1, [1.0, 0.0, 0.0]), pitch_deg.to_radians());
        let r = mat_mul(&r2, &r1);

        // Combined: for each pixel, ray = R * K_inv * [u, v, 1]
        // Precompute R * K_inv
        let rk = mat_mul(&r, &k_inv);

        let pw = pano_w as f32;
        let ph = pano_h as f32;

        let n = (out_w * out_h) as usize;
        let mut map = vec![[0f32; 2]; n];

        map.par_chunks_mut(out_w as usize)
            .enumerate()
            .for_each(|(y, row)| {
                let v = y as f32;
                for (x, cell) in row.iter_mut().enumerate() {
                    let u = x as f32;
                    // ray = rk * [u, v, 1]
                    let rx = rk[0][0] * u + rk[0][1] * v + rk[0][2];
                    let ry = rk[1][0] * u + rk[1][1] * v + rk[1][2];
                    let rz = rk[2][0] * u + rk[2][1] * v + rk[2][2];

                    let norm = (rx * rx + ry * ry + rz * rz).sqrt();
                    let lon = rx.atan2(rz);
                    let lat = (ry / norm).asin();

                    let src_x = (lon / (2.0 * std::f32::consts::PI) + 0.5) * (pw - 1.0);
                    let src_y = (lat / std::f32::consts::PI + 0.5) * (ph - 1.0);

                    *cell = [src_x, src_y];
                }
            });

        Self { out_w, out_h, map }
    }

    /// Apply the remap with bilinear interpolation. Source is RGB, row-major.
    pub fn remap(&self, src: &[u8], src_w: u32, src_h: u32) -> image::RgbImage {
        let mut dst = image::RgbImage::new(self.out_w, self.out_h);
        let dst_raw = dst.as_mut();
        let sw = src_w as usize;
        let sh = src_h as usize;
        let ow = self.out_w as usize;

        dst_raw.par_chunks_mut(ow * 3)
            .enumerate()
            .for_each(|(y, row)| {
                for x in 0..ow {
                    let [sx, sy] = self.map[y * ow + x];

                    // Wrap horizontally (equirectangular)
                    let sx_wrapped = ((sx % sw as f32) + sw as f32) % sw as f32;
                    let sy_clamped = sy.clamp(0.0, (sh - 1) as f32);

                    let x0 = sx_wrapped as usize;
                    let y0 = sy_clamped as usize;
                    let x1 = (x0 + 1) % sw;
                    let y1 = (y0 + 1).min(sh - 1);
                    let fx = sx_wrapped - x0 as f32;
                    let fy = sy_clamped - y0 as f32;

                    for c in 0..3 {
                        let p00 = src[(y0 * sw + x0) * 3 + c] as f32;
                        let p10 = src[(y0 * sw + x1) * 3 + c] as f32;
                        let p01 = src[(y1 * sw + x0) * 3 + c] as f32;
                        let p11 = src[(y1 * sw + x1) * 3 + c] as f32;

                        let v = p00 * (1.0 - fx) * (1.0 - fy)
                            + p10 * fx * (1.0 - fy)
                            + p01 * (1.0 - fx) * fy
                            + p11 * fx * fy;

                        row[x * 3 + c] = v.round() as u8;
                    }
                }
            });

        dst
    }
}

// --- Matrix math (3x3) ---

type Mat3 = [[f32; 3]; 3];

fn rodrigues_y(angle: f32) -> Mat3 {
    let c = angle.cos();
    let s = angle.sin();
    [
        [ c, 0.0, s],
        [0.0, 1.0, 0.0],
        [-s, 0.0, c],
    ]
}

fn rodrigues_axis(axis: [f32; 3], angle: f32) -> Mat3 {
    let norm = (axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]).sqrt();
    let [kx, ky, kz] = [axis[0]/norm, axis[1]/norm, axis[2]/norm];
    let c = angle.cos();
    let s = angle.sin();
    let ic = 1.0 - c;
    [
        [c + kx*kx*ic,     kx*ky*ic - kz*s, kx*kz*ic + ky*s],
        [ky*kx*ic + kz*s,  c + ky*ky*ic,     ky*kz*ic - kx*s],
        [kz*kx*ic - ky*s,  kz*ky*ic + kx*s,  c + kz*kz*ic],
    ]
}

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut r = [[0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = a[i][0]*b[0][j] + a[i][1]*b[1][j] + a[i][2]*b[2][j];
        }
    }
    r
}

fn mat_vec(m: &Mat3, v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
        m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
        m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
    ]
}
