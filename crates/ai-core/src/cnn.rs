use crate::Point;
use std::path::Path;
use std::io::Read;

// 架构必须与 scripts/export_models.py 中的 SketchCNN 保持一致
const IMG_SIZE: usize = 28;
const C1: usize = 16; // conv1 输出通道
const C2: usize = 32; // conv2 输出通道
const C3: usize = 32; // conv3 输出通道
const FC_HIDDEN: usize = 64;
const NUM_CLASSES: usize = 13;
const K: usize = 3; // 卷积核大小

pub struct CnnWeights {
    conv1_w: Box<[f32]>, conv1_b: Box<[f32]>,
    conv2_w: Box<[f32]>, conv2_b: Box<[f32]>,
    conv3_w: Box<[f32]>, conv3_b: Box<[f32]>,
    fc1_w: Box<[f32]>, fc1_b: Box<[f32]>,
    fc2_w: Box<[f32]>, fc2_b: Box<[f32]>,
}

/// 渲染笔画到 28×28 位图，返回 784 维归一化像素数组（行优先，y*28+x）
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

/// 3×3 卷积，padding=1，stride=1，输出尺寸与输入一致（same 模式）
/// 输入/权重均为行优先：输入 (in_c, h, w)，权重 (out_c, in_c, 3, 3)
fn conv2d_same(inp: &[f32], w: &[f32], b: &[f32], in_c: usize, out_c: usize, h: usize, wd: usize) -> Vec<f32> {
    let pad = K / 2;
    let mut out = vec![0.0f32; out_c * h * wd];
    for oc in 0..out_c {
        let bias = b[oc];
        for y in 0..h {
            for x in 0..wd {
                let mut s = bias;
                for ic in 0..in_c {
                    for ky in 0..K {
                        let yy = y as isize + ky as isize - pad as isize;
                        if yy < 0 || yy >= h as isize { continue; }
                        for kx in 0..K {
                            let xx = x as isize + kx as isize - pad as isize;
                            if xx < 0 || xx >= wd as isize { continue; }
                            let w_idx = ((oc * in_c + ic) * K + ky) * K + kx;
                            let in_idx = (ic * h + yy as usize) * wd + xx as usize;
                            s += inp[in_idx] * w[w_idx];
                        }
                    }
                }
                out[(oc * h + y) * wd + x] = s;
            }
        }
    }
    out
}

/// 2×2 最大池化，stride=2，尺寸向下取整
fn maxpool2x2(inp: &[f32], channels: usize, h: usize, wd: usize) -> Vec<f32> {
    let oh = h / 2;
    let ow = wd / 2;
    let mut out = vec![0.0f32; channels * oh * ow];
    for ch in 0..channels {
        for y in 0..oh {
            for x in 0..ow {
                let mut m = f32::NEG_INFINITY;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let v = inp[(ch * h + y * 2 + dy) * wd + x * 2 + dx];
                        if v > m { m = v; }
                    }
                }
                out[(ch * oh + y) * ow + x] = m;
            }
        }
    }
    out
}

fn relu_inplace(v: &mut [f32]) {
    for x in v.iter_mut() {
        if *x < 0.0 { *x = 0.0; }
    }
}

/// 全连接层：out = relu?(W·in + b)，权重行优先 (rows=out, cols=in)
fn matmul(out: &mut [f32], inp: &[f32], w: &[f32], b: &[f32], rows: usize, cols: usize, use_relu: bool) {
    for r in 0..rows {
        let mut s = b[r];
        for c in 0..cols {
            s += inp[c] * w[r * cols + c];
        }
        out[r] = if use_relu && s < 0.0 { 0.0 } else { s };
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

/// conv(3×3, same) → ReLU → maxpool(2×2)
fn conv_block(inp: &[f32], w: &[f32], b: &[f32], in_c: usize, out_c: usize, h: usize, wd: usize) -> Vec<f32> {
    let mut x = conv2d_same(inp, w, b, in_c, out_c, h, wd);
    relu_inplace(&mut x);
    maxpool2x2(&x, out_c, h, wd)
}

impl CnnWeights {
    pub fn load(path: &Path) -> Result<Self, String> {
        let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;

        let mut magic = [0u8; 4];
        f.read_exact(&mut magic).map_err(|e| e.to_string())?;
        if &magic != b"SCNN" {
            return Err(format!(
                "unsupported model format (magic {:?}) — retrain with scripts/export_models.py (2D CNN)",
                String::from_utf8_lossy(&magic)
            ));
        }
        let mut ver_buf = [0u8; 4];
        f.read_exact(&mut ver_buf).map_err(|e| e.to_string())?;
        let version = u32::from_le_bytes(ver_buf);
        if version != 1 {
            return Err(format!("unsupported model version {version}"));
        }

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

        fn expect_shape(shape: &[usize], expected: &[usize], name: &str) -> Result<(), String> {
            if shape != expected {
                return Err(format!(
                    "model architecture mismatch: {name} shape {shape:?}, expected {expected:?} — retrain with scripts/export_models.py"
                ));
            }
            Ok(())
        }

        let (conv1_w, s) = read_array()?;
        expect_shape(&s, &[C1, 1, K, K], "conv1.weight")?;
        let (conv1_b, s) = read_array()?;
        expect_shape(&s, &[C1], "conv1.bias")?;
        let (conv2_w, s) = read_array()?;
        expect_shape(&s, &[C2, C1, K, K], "conv2.weight")?;
        let (conv2_b, s) = read_array()?;
        expect_shape(&s, &[C2], "conv2.bias")?;
        let (conv3_w, s) = read_array()?;
        expect_shape(&s, &[C3, C2, K, K], "conv3.weight")?;
        let (conv3_b, s) = read_array()?;
        expect_shape(&s, &[C3], "conv3.bias")?;
        let (fc1_w, s) = read_array()?;
        expect_shape(&s, &[FC_HIDDEN, C3 * 3 * 3], "fc1.weight")?;
        let (fc1_b, s) = read_array()?;
        expect_shape(&s, &[FC_HIDDEN], "fc1.bias")?;
        let (fc2_w, s) = read_array()?;
        expect_shape(&s, &[NUM_CLASSES, FC_HIDDEN], "fc2.weight")?;
        let (fc2_b, s) = read_array()?;
        expect_shape(&s, &[NUM_CLASSES], "fc2.bias")?;

        Ok(Self {
            conv1_w: conv1_w.into_boxed_slice(), conv1_b: conv1_b.into_boxed_slice(),
            conv2_w: conv2_w.into_boxed_slice(), conv2_b: conv2_b.into_boxed_slice(),
            conv3_w: conv3_w.into_boxed_slice(), conv3_b: conv3_b.into_boxed_slice(),
            fc1_w: fc1_w.into_boxed_slice(), fc1_b: fc1_b.into_boxed_slice(),
            fc2_w: fc2_w.into_boxed_slice(), fc2_b: fc2_b.into_boxed_slice(),
        })
    }

    pub fn predict(&self, points: &[Point]) -> (usize, f32) {
        let input = points_to_bitmap(points); // 1×28×28（行优先）

        let p1 = conv_block(&input, &self.conv1_w, &self.conv1_b, 1, C1, IMG_SIZE, IMG_SIZE); // 16×14×14
        let p2 = conv_block(&p1, &self.conv2_w, &self.conv2_b, C1, C2, IMG_SIZE / 2, IMG_SIZE / 2); // 32×7×7
        let p3 = conv_block(&p2, &self.conv3_w, &self.conv3_b, C2, C3, IMG_SIZE / 4, IMG_SIZE / 4); // 32×3×3

        let flat_len = C3 * 3 * 3;
        let mut hidden = vec![0.0f32; FC_HIDDEN];
        matmul(&mut hidden, &p3, &self.fc1_w, &self.fc1_b, FC_HIDDEN, flat_len, true);

        let mut out = vec![0.0f32; NUM_CLASSES];
        matmul(&mut out, &hidden, &self.fc2_w, &self.fc2_b, NUM_CLASSES, FC_HIDDEN, false);
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
    fn test_conv_same_preserves_size_identity_kernel() {
        // 单通道 3×3，核中心为 1 → 恒等映射
        let inp: Vec<f32> = (0..9).map(|i| i as f32).collect();
        let mut w = vec![0.0f32; 9];
        w[4] = 1.0;
        let b = vec![0.0f32];
        let out = conv2d_same(&inp, &w, &b, 1, 1, 3, 3);
        assert_eq!(out, inp);
    }

    #[test]
    fn test_maxpool_picks_max() {
        let inp = vec![1.0, 5.0, 0.0, 3.0];
        let out = maxpool2x2(&inp, 1, 2, 2);
        assert_eq!(out, vec![5.0]);
    }

    #[test]
    fn test_model_loads_and_predicts() {
        let path = std::path::Path::new("models/sketch_classify.bin");
        if !path.exists() {
            eprintln!("skipping: model file not found");
            return;
        }
        let model = CnnWeights::load(path).expect("should load model");
        // 只验证模型可以完成推理，不验证结果（结果依赖训练数据质量）
        let (_idx, _conf) = model.predict(&make_line());
        let (_idx, _conf) = model.predict(&make_rect());
        let (_idx, _conf) = model.predict(&make_circle());
        let (_idx, _conf) = model.predict(&make_triangle());
        let (_idx, _conf) = model.predict(&make_trapezoid());
    }
}
