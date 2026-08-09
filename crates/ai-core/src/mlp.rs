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

const MAX_POINTS: usize = 100;

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

        let (w1, s1) = read_array()?;
        let (b1, _) = read_array()?;
        let (w2, s2) = read_array()?;
        let (b2, _) = read_array()?;
        let (w3, s3) = read_array()?;
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
        let mut input = vec![0.0f32; MAX_POINTS * 2];
        let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
        let ys: Vec<f64> = points.iter().map(|p| p.y).collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let scale = (max_x - min_x).max(max_y - min_y).max(1.0);
        let cx = (min_x + max_x) / 2.0;
        let cy = (min_y + max_y) / 2.0;

        // 角度排序：与 QuickDraw 训练数据一致
        let mut sorted: Vec<&Point> = points.iter().collect();
        sorted.sort_by(|a, b| {
            let a_angle = (a.y - cy).atan2(a.x - cx);
            let b_angle = (b.y - cy).atan2(b.x - cx);
            a_angle.partial_cmp(&b_angle).unwrap_or(std::cmp::Ordering::Equal)
        });

        // 归一化：对齐 QuickDraw 的 (x/14-1, y/14-1)，用最大边长保证等比例
        let half = scale / 2.0;
        for i in 0..MAX_POINTS {
            let t = i as f64 / (MAX_POINTS as f64 - 1.0);
            let idx = (t * (sorted.len() - 1) as f64) as usize;
            let p = sorted[idx.min(sorted.len() - 1)];
            input[i * 2] = ((p.x - cx) / half) as f32;
            input[i * 2 + 1] = ((p.y - cy) / half) as f32;
        }

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

    fn make_line() -> Vec<Point> { (0..50).map(|i| Point { x: i as f64 * 2.0, y: 100.0 }).collect() }
    fn make_rect() -> Vec<Point> {
        let mut pts = Vec::new();
        for i in 0..=25 { pts.push(Point { x: 50.0 + i as f64 * 4.0, y: 50.0 }); }
        for i in 0..=25 { pts.push(Point { x: 150.0, y: 50.0 + i as f64 * 4.0 }); }
        for i in 0..=25 { pts.push(Point { x: 150.0 - i as f64 * 4.0, y: 150.0 }); }
        for i in 0..=25 { pts.push(Point { x: 50.0, y: 150.0 - i as f64 * 4.0 }); }
        pts
    }

    #[test]
    fn test_predict_does_not_panic() {
        let model = MlWeights {
            w1: vec![0.0f32; 200*256].into_boxed_slice(), b1: vec![0.0f32; 256].into_boxed_slice(),
            w2: vec![0.0f32; 256*128].into_boxed_slice(), b2: vec![0.0f32; 128].into_boxed_slice(),
            w3: vec![0.0f32; 128*13].into_boxed_slice(), b3: vec![0.0f32; 13].into_boxed_slice(),
            h1: 256, h2: 128, num_classes: 13, in_dim: 200,
        };
        model.predict(&make_line());
        model.predict(&make_rect());
        model.predict(&[]);
        model.predict(&[Point { x: 0.0, y: 0.0 }]);
    }
}
