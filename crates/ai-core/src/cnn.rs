use crate::Point;
use std::path::Path;
use std::io::Read;

const MAX_POINTS: usize = 100;

pub struct CnnWeights {
    conv1_kernel: Box<[f32]>, conv1_bias: Box<[f32]>,  // (5, 2, 32), (32,)
    conv2_kernel: Box<[f32]>, conv2_bias: Box<[f32]>,  // (5, 32, 64), (64,)
    fc1_weight: Box<[f32]>, fc1_bias: Box<[f32]>,      // (1600, 128), (128,)
    fc2_weight: Box<[f32]>, fc2_bias: Box<[f32]>,      // (128, 13), (13,)
}

impl CnnWeights {
    pub fn load(path: &Path) -> Result<Self, String> {
        let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut arrays: Vec<(String, Vec<f32>, Vec<usize>)> = Vec::new();

        loop {
            let mut hdr = [0u8; 12];
            if f.read_exact(&mut hdr).is_err() { break; }
            let ndim = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
            let _ = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]);
            let key_len = u32::from_le_bytes([hdr[8], hdr[9], hdr[10], hdr[11]]) as usize;
            let mut key_bytes = vec![0u8; key_len];
            f.read_exact(&mut key_bytes).map_err(|e| e.to_string())?;
            let key = String::from_utf8_lossy(&key_bytes).to_string();

            let mut shape = vec![0usize; ndim];
            for d in 0..ndim {
                let mut b = [0u8; 4];
                f.read_exact(&mut b).map_err(|e| e.to_string())?;
                shape[d] = u32::from_le_bytes(b) as usize;
            }
            let n: usize = shape.iter().product();
            let mut raw = vec![0u8; n * 4];
            f.read_exact(&mut raw).map_err(|e| e.to_string())?;
            let data: Vec<f32> = raw.chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            arrays.push((key, data, shape));
        }

        let get = |name: &str| -> Result<(Vec<f32>, Vec<usize>), String> {
            arrays.iter()
                .find(|(k, _, _)| k.contains(name))
                .map(|(_, d, s)| (d.clone(), s.clone()))
                .ok_or_else(|| format!("weight '{}' not found", name))
        };

        Ok(Self {
            conv1_kernel: get("conv1_kernel")?.0.into_boxed_slice(),
            conv1_bias: get("conv1_bias")?.0.into_boxed_slice(),
            conv2_kernel: get("conv2_kernel")?.0.into_boxed_slice(),
            conv2_bias: get("conv2_bias")?.0.into_boxed_slice(),
            fc1_weight: get("fc1_kernel")?.0.into_boxed_slice(),
            fc1_bias: get("fc1_bias")?.0.into_boxed_slice(),
            fc2_weight: get("fc2_kernel")?.0.into_boxed_slice(),
            fc2_bias: get("fc2_bias")?.0.into_boxed_slice(),
        })
    }

    pub fn predict(&self, points: &[Point]) -> (usize, f32) {
        // 1. Normalize + angle-sort → 100×2 input
        let mut input = vec![vec![0.0f32; 2]; MAX_POINTS];
        let xs: Vec<f64> = points.iter().map(|p| p.x).collect();
        let ys: Vec<f64> = points.iter().map(|p| p.y).collect();
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let scale = (max_x - min_x).max(max_y - min_y).max(1.0);
        let cx = (min_x + max_x) / 2.0;
        let cy = (min_y + max_y) / 2.0;
        let half = scale / 2.0;

        let mut sorted: Vec<&Point> = points.iter().collect();
        sorted.sort_by(|a, b| {
            (a.y - cy).atan2(a.x - cx).partial_cmp(&(b.y - cy).atan2(b.x - cx)).unwrap_or(std::cmp::Ordering::Equal)
        });

        for i in 0..MAX_POINTS {
            let t = i as f64 / (MAX_POINTS as f64 - 1.0);
            let idx = (t * (sorted.len() - 1) as f64) as usize;
            let p = sorted[idx.min(sorted.len() - 1)];
            input[i][0] = ((p.x - cx) / half) as f32;
            input[i][1] = ((p.y - cy) / half) as f32;
        }

        // 2. Conv1D: 5×2×32, ReLU, pad=same → 100×32
        let c1 = conv1d(&input, &self.conv1_kernel, &self.conv1_bias, 2, 32, true);
        // 3. MaxPool1D(2) → 50×32
        let p1 = maxpool1d(&c1, 2);
        // 4. Conv1D: 5×32×64, ReLU, pad=same → 50×64
        let c2 = conv1d(&p1, &self.conv2_kernel, &self.conv2_bias, 32, 64, true);
        // 5. MaxPool1D(2) → 25×64
        let p2 = maxpool1d(&c2, 2);
        // 6. Flatten → 1600
        let flat: Vec<f32> = p2.iter().flat_map(|row| row.iter()).copied().collect();
        // 7. FC(1600→128) ReLU
        let mut fc1 = vec![0.0f32; 128];
        dense(&flat, &mut fc1, &self.fc1_weight, &self.fc1_bias, 128, 1600, true);
        // 8. FC(128→13) Softmax
        let mut fc2 = vec![0.0f32; 13];
        dense(&fc1, &mut fc2, &self.fc2_weight, &self.fc2_bias, 13, 128, false);
        softmax(&mut fc2);

        argmax(&fc2)
    }
}

fn softmax(x: &mut [f32]) {
    let max = x.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0.0;
    for v in x.iter_mut() { *v = (*v - max).exp(); sum += *v; }
    for v in x.iter_mut() { *v /= sum; }
}

fn argmax(x: &[f32]) -> (usize, f32) {
    let mut idx = 0usize;
    let mut max = f32::NEG_INFINITY;
    for (i, &v) in x.iter().enumerate() {
        if v > max { max = v; idx = i; }
    }
    (idx, max)
}

fn conv1d(input: &[Vec<f32>], kernel: &[f32], bias: &[f32],
           in_ch: usize, out_ch: usize, relu: bool) -> Vec<Vec<f32>> {
    let len = input.len();
    let ksize = kernel.len() / (in_ch * out_ch);
    let pad = ksize / 2;
    let mut output = vec![vec![0.0f32; out_ch]; len];

    for oc in 0..out_ch {
        for t in 0..len {
            let mut s = bias[oc];
            for k in 0..ksize {
                let src = if t + k < pad { pad - (t + k) }
                    else if t + k - pad >= len { 2 * len - (t + k - pad) - 2 }
                    else { t + k - pad };
                let src = src.min(len - 1);
                let src_row = &input[src];
                for ic in 0..in_ch {
                    // kernel layout: (ksize, in_ch, out_ch) = k * (in_ch * out_ch) + ic * out_ch + oc
                    let k_idx = k * (in_ch * out_ch) + ic * out_ch + oc;
                    s += src_row[ic] * kernel[k_idx];
                }
            }
            output[t][oc] = if relu && s < 0.0 { 0.0 } else { s };
        }
    }
    output
}

fn maxpool1d(input: &[Vec<f32>], pool: usize) -> Vec<Vec<f32>> {
    let len = input.len() / pool;
    let ch = input[0].len();
    let mut output = vec![vec![0.0f32; ch]; len];
    for t in 0..len {
        for c in 0..ch {
            let mut max_val = f32::NEG_INFINITY;
            for p in 0..pool {
                let v = input[t * pool + p][c];
                if v > max_val { max_val = v; }
            }
            output[t][c] = max_val;
        }
    }
    output
}

fn dense(input: &[f32], output: &mut [f32], weight: &[f32], bias: &[f32],
         out_dim: usize, in_dim: usize, relu: bool) {
    for o in 0..out_dim {
        let mut s = bias[o];
        for i in 0..in_dim {
            s += input[i] * weight[i * out_dim + o];
        }
        output[o] = if relu && s < 0.0 { 0.0 } else { s };
    }
}
