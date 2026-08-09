use crate::Point;
use std::path::Path;
use std::io::Read;

pub struct MlWeights {
    w1: Box<[f32]>, b1: Box<[f32]>,
    w2: Box<[f32]>, b2: Box<[f32]>,
    w3: Box<[f32]>, b3: Box<[f32]>,
    h1: usize, h2: usize, num_classes: usize,
    in_dim: usize,
}

const IMG_SIZE: usize = 28;

/// 渲染笔画到 28×28 位图，返回 784 维归一化像素数组
fn points_to_bitmap(points: &[Point]) -> Vec<f32> {
    let mut bitmap = vec![0.0f32; IMG_SIZE * IMG_SIZE];
    if points.len() < 2 { return bitmap; }

    let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
    let ys: Vec<f64> = points.iter().map(|p| p.y).collect();
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let scale = (max_x - min_x).max(max_y - min_y).max(1.0);

    for i in 0..points.len() - 1 {
        let x0 = ((points[i].x - min_x) / scale * (IMG_SIZE as f64 - 1.0)) as isize;
        let y0 = ((points[i].y - min_y) / scale * (IMG_SIZE as f64 - 1.0)) as isize;
        let x1 = ((points[i + 1].x - min_x) / scale * (IMG_SIZE as f64 - 1.0)) as isize;
        let y1 = ((points[i + 1].y - min_y) / scale * (IMG_SIZE as f64 - 1.0)) as isize;
        // Bresenham 画线 + 高斯加粗（3×3 核）
        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx + dy;
        let mut x = x0;
        let mut y = y0;
        loop {
            for dy2 in -1isize..=1 {
                for dx2 in -1isize..=1 {
                    let nx = x + dx2;
                    let ny = y + dy2;
                    if nx >= 0 && nx < IMG_SIZE as isize && ny >= 0 && ny < IMG_SIZE as isize {
                        let w = if dx2 == 0 && dy2 == 0 { 1.0 } else { 0.5 };
                        bitmap[(ny as usize) * IMG_SIZE + nx as usize] = (bitmap[(ny as usize) * IMG_SIZE + nx as usize] + w as f32).min(1.0);
                    }
                }
            }
            if x == x1 && y == y1 { break; }
            let e2 = 2 * err;
            if e2 >= dy { err += dy; x += sx; }
            if e2 <= dx { err += dx; y += sy; }
        }
    }

    bitmap
}

fn matmul_add_relu(out: &mut [f32], inp: &[f32], w: &[f32], b: &[f32], rows: usize, cols: usize) {
    for r in 0..rows {
        let mut s = b[r];
        for c in 0..cols {
            s += inp[c] * w[r * cols + c];
        }
        out[r] = if s > 0.0 { s } else { 0.0 };
    }
}

fn softmax_flat(x: &mut [f32]) {
    let max = x.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0.0;
    for v in x.iter_mut() {
        *v = (*v - max).exp();
        sum += *v;
    }
    for v in x.iter_mut() { *v /= sum; }
}

impl MlWeights {
    pub fn load(path: &Path) -> Result<Self, String> {
        let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut read_array = || -> Result<(Vec<f32>, Vec<usize>), String> {
            let mut hdr = [0u8; 8];
            f.read_exact(&mut hdr).map_err(|e| e.to_string())?;
            let ndim = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
            let _is_f32 = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]);
            let mut shape = vec![0usize; ndim];
            for d in 0..ndim {
                let mut b = [0u8; 4];
                f.read_exact(&mut b).map_err(|e| e.to_string())?;
                shape[d] = u32::from_le_bytes(b) as usize;
            }
            let n = shape.iter().product::<usize>();
            let mut raw = vec![0u8; n * 4];
            f.read_exact(&mut raw).map_err(|e| e.to_string())?;
            let data: Vec<f32> = raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            Ok((data, shape))
        };

        let (w1, s1) = read_array()?; // (input, h1)
        let (b1, _) = read_array()?;
        let (w2, s2) = read_array()?; // (h1, h2)
        let (b2, _) = read_array()?;
        let (w3, s3) = read_array()?; // (h2, classes)
        let (b3, _) = read_array()?;

        Ok(Self {
            w1: w1.into_boxed_slice(), b1: b1.into_boxed_slice(),
            w2: w2.into_boxed_slice(), b2: b2.into_boxed_slice(),
            w3: w3.into_boxed_slice(), b3: b3.into_boxed_slice(),
            h1: s1[1], h2: s2[1], num_classes: s3[1],
            in_dim: s1[0],
        })
    }

    pub fn predict(&self, points: &[Point]) -> (usize, f32) {
        let input = points_to_bitmap(points);
        let in_dim = self.in_dim;

        let mut h1 = vec![0.0f32; self.h1];
        let mut h2 = vec![0.0f32; self.h2];
        let mut out = vec![0.0f32; self.num_classes];

        matmul_add_relu(&mut h1, &input[..in_dim], &self.w1, &self.b1, self.h1, in_dim);
        matmul_add_relu(&mut h2, &h1, &self.w2, &self.b2, self.h2, self.h1);
        matmul_add_relu(&mut out, &h2, &self.w3, &self.b3, self.num_classes, self.h2);
        softmax_flat(&mut out);

        let mut max_idx = 0usize;
        let mut max_val = f32::NEG_INFINITY;
        for (i, &v) in out.iter().enumerate() {
            if v > max_val { max_val = v; max_idx = i; }
        }
        (max_idx, max_val)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Point;

    fn make_line() -> Vec<Point> {
        (0..50).map(|i| Point { x: i as f64 * 2.0, y: 100.0 }).collect()
    }

    fn make_rect() -> Vec<Point> {
        let mut pts = Vec::new();
        for i in 0..=25 { pts.push(Point { x: 50.0 + i as f64 * 4.0, y: 50.0 }); }
        for i in 0..=25 { pts.push(Point { x: 150.0, y: 50.0 + i as f64 * 4.0 }); }
        for i in 0..=25 { pts.push(Point { x: 150.0 - i as f64 * 4.0, y: 150.0 }); }
        for i in 0..=25 { pts.push(Point { x: 50.0, y: 150.0 - i as f64 * 4.0 }); }
        pts
    }

    fn make_circle() -> Vec<Point> {
        (0..100).map(|i| {
            let a = std::f64::consts::PI * 2.0 * i as f64 / 100.0;
            Point { x: 100.0 + 40.0 * a.cos(), y: 100.0 + 40.0 * a.sin() }
        }).collect()
    }

    fn make_triangle() -> Vec<Point> {
        let mut pts = Vec::new();
        for i in 0..=33 { pts.push(Point { x: 100.0 - 50.0 + i as f64 * 100.0 / 33.0, y: 100.0 + 40.0 * (i as f64 / 33.0) }); }
        pts
    }

    fn make_trapezoid() -> Vec<Point> {
        let mut pts = Vec::new();
        let cx = 200.0; let cy = 200.0; let w = 100.0; let h = 80.0; let tw = 60.0;
        for i in 0..=20 { pts.push(Point { x: cx - tw / 2.0 + i as f64 * tw / 20.0, y: cy - h / 2.0 }); }
        for i in 0..=20 { pts.push(Point { x: cx + w / 2.0, y: cy - h / 2.0 + i as f64 * h / 20.0 }); }
        for i in (0..=20).rev() { pts.push(Point { x: cx - w / 2.0 + i as f64 * w / 20.0, y: cy + h / 2.0 }); }
        for i in (0..=20).rev() { pts.push(Point { x: cx - w / 2.0, y: cy + h / 2.0 - i as f64 * h / 20.0 }); }
        pts
    }

    #[test]
    fn test_bitmap_line_has_pixels() {
        let bm = points_to_bitmap(&make_line());
        let active = bm.iter().filter(|&&v| v > 0.0).count();
        assert!(active > 10, "line should produce {active} active pixels");
    }

    #[test]
    fn test_bitmap_rect_has_pixels() {
        let bm = points_to_bitmap(&make_rect());
        let active = bm.iter().filter(|&&v| v > 0.0).count();
        assert!(active > 40, "rect should have > 40 active pixels, got {active}");
    }

    #[test]
    fn test_bitmap_empty_all_zero() {
        let bm = points_to_bitmap(&[]);
        assert_eq!(bm.iter().sum::<f32>(), 0.0);
    }

    #[test]
    fn test_bitmap_single_point_empty() {
        let bm = points_to_bitmap(&[Point { x: 5.0, y: 5.0 }]);
        assert_eq!(bm.iter().sum::<f32>(), 0.0);
    }

    #[test]
    fn test_model_loads_and_predicts() {
        let path = std::path::Path::new("models/sketch_classify.bin");
        if !path.exists() {
            eprintln!("skipping: model file not found");
            return;
        }
        let model = MlWeights::load(path).expect("should load model");
        // 只验证模型可以完成推理，不验证结果（结果依赖训练数据质量）
        let (_idx, _conf) = model.predict(&make_line());
        let (_idx, _conf) = model.predict(&make_rect());
        let (_idx, _conf) = model.predict(&make_circle());
        let (_idx, _conf) = model.predict(&make_triangle());
        let (_idx, _conf) = model.predict(&make_trapezoid());
    }
}
