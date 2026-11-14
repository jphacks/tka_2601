//! Sample-rate conversion of mono s16le PCM from the TTS rate to the device's 16 kHz.
//!
//! livekit-agents converts TTS audio with `rtc.AudioResampler` (soxr, medium quality)
//! before handing it to the 16 kHz device output. This is a linear-phase Kaiser-windowed
//! sinc resampler over the whole reply: no delay (an impulse at input sample `3k` lands on
//! output sample `k` for 48 kHz → 16 kHz, as with soxr), pass band flat to ~7 kHz, alias
//! rejection above 8 kHz better than 70 dB. Samples are not bit-identical to soxr.
//!
//! The output length follows soxr's rule as observed through `rtc.AudioResampler`
//! (push everything, then flush): `round_half_up(n * output_rate / input_rate)`.

/// The device sample rate.
pub const DEVICE_SAMPLE_RATE: u32 = 16_000;

/// Stop-band attenuation of the anti-aliasing filter in dB.
const ATTENUATION_DB: f64 = 80.0;
/// Cutoff (-6 dB) as a fraction of the lower Nyquist frequency.
const CUTOFF: f64 = 0.94;
/// Transition band width as a fraction of the lower Nyquist frequency.
const TRANSITION: f64 = 0.12;

/// Output samples for `input_samples` samples, as `rtc.AudioResampler` produces them.
pub fn resampled_len(input_samples: usize, input_rate: u32, output_rate: u32) -> usize {
    let numerator = 2 * input_samples as u128 * u128::from(output_rate) + u128::from(input_rate);
    (numerator / (2 * u128::from(input_rate))) as usize
}

/// Convert TTS audio at `input_rate` to the 16 kHz device rate (a copy when it already is).
pub fn resample_to_device(pcm: &[u8], input_rate: u32) -> Vec<u8> {
    resample(pcm, input_rate, DEVICE_SAMPLE_RATE)
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// Modified Bessel function of the first kind, order 0.
fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..200 {
        term *= (half / k as f64) * (half / k as f64);
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        let pi_x = std::f64::consts::PI * x;
        pi_x.sin() / pi_x
    }
}

/// Resample mono s16le `pcm` (a trailing odd byte is ignored).
pub fn resample(pcm: &[u8], input_rate: u32, output_rate: u32) -> Vec<u8> {
    assert!(input_rate > 0 && output_rate > 0, "sample rates must be positive");
    let input: Vec<f64> = pcm
        .chunks_exact(2)
        .map(|sample| f64::from(i16::from_le_bytes([sample[0], sample[1]])))
        .collect();
    if input_rate == output_rate {
        return pcm[..input.len() * 2].to_vec();
    }
    let out_len = resampled_len(input.len(), input_rate, output_rate);
    if input.is_empty() || out_len == 0 {
        return Vec::new();
    }

    let (rate_in, rate_out) = (u64::from(input_rate), u64::from(output_rate));
    // Frequencies relative to the input rate (cycles per input sample).
    let nyquist = rate_in.min(rate_out) as f64 / 2.0 / rate_in as f64;
    let cutoff = CUTOFF * nyquist;
    let transition = TRANSITION * nyquist;
    let beta = 0.1102 * (ATTENUATION_DB - 8.7);
    let taps = (ATTENUATION_DB - 8.0) / (2.285 * 2.0 * std::f64::consts::PI * transition);
    let half_width = (taps / 2.0).ceil();
    let i0_beta = bessel_i0(beta);
    let kernel = |x: f64| -> f64 {
        let ratio = x / half_width;
        if ratio.abs() >= 1.0 {
            return 0.0;
        }
        2.0 * cutoff * sinc(2.0 * cutoff * x) * bessel_i0(beta * (1.0 - ratio * ratio).sqrt()) / i0_beta
    };

    // Output sample k sits at input position k * rate_in / rate_out. Its fractional part
    // takes one of `phases` values; precompute the normalized taps for each.
    let g = gcd(rate_in, rate_out);
    let phases = (rate_out / g) as usize;
    let reach = half_width as i64;
    let tables: Vec<Vec<f64>> = (0..phases)
        .map(|phase| {
            let fraction = phase as f64 * g as f64 / rate_out as f64;
            let mut weights: Vec<f64> =
                (-reach..=reach + 1).map(|offset| kernel(fraction - offset as f64)).collect();
            let total: f64 = weights.iter().sum();
            for weight in &mut weights {
                *weight /= total;
            }
            weights
        })
        .collect();

    let mut out = Vec::with_capacity(out_len * 2);
    for k in 0..out_len as u64 {
        let position = k * rate_in;
        let base = (position / rate_out) as i64;
        let phase = ((position % rate_out) / g) as usize;
        let mut acc = 0.0;
        for (tap, weight) in tables[phase].iter().enumerate() {
            let index = base - reach + tap as i64;
            if index >= 0 && (index as usize) < input.len() {
                acc += input[index as usize] * weight;
            }
        }
        let sample = acc.round().clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16;
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frequency: f64, rate: u32, samples: usize, amplitude: f64) -> Vec<u8> {
        (0..samples)
            .flat_map(|i| {
                let value = amplitude * (2.0 * std::f64::consts::PI * frequency * i as f64 / f64::from(rate)).sin();
                (value as i16).to_le_bytes()
            })
            .collect()
    }

    fn samples(pcm: &[u8]) -> Vec<i16> {
        pcm.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]])).collect()
    }

    fn peak(pcm: &[u8], from: usize, to: usize) -> i32 {
        samples(pcm)[from..to].iter().map(|s| i32::from(*s).abs()).max().unwrap()
    }

    #[test]
    fn lengths_follow_audio_resampler() {
        // Observed with livekit rtc.AudioResampler (push all, then flush).
        for (n, expected) in [(960, 320), (1000, 333), (1001, 334), (4801, 1600), (25922, 8641), (1, 0), (2, 1), (7, 2)] {
            assert_eq!(resampled_len(n, 48000, 16000), expected, "n={n}");
            assert_eq!(resample(&vec![0; n * 2], 48000, 16000).len(), expected * 2);
        }
        for (n, expected) in [(1, 1), (3, 2), (5, 3), (101, 51)] {
            assert_eq!(resampled_len(n, 32000, 16000), expected);
        }
        for (n, expected) in [(1, 0), (13, 5), (1000, 363), (4411, 1600)] {
            assert_eq!(resampled_len(n, 44100, 16000), expected);
        }
    }

    #[test]
    fn same_rate_is_a_copy() {
        let pcm = sine(300.0, 16000, 1000, 5000.0);
        assert_eq!(resample_to_device(&pcm, 16000), pcm);
    }

    #[test]
    fn pass_band_keeps_amplitude() {
        for frequency in [300.0, 1000.0, 3000.0, 6500.0] {
            let out = resample(&sine(frequency, 48000, 48000, 10000.0), 48000, 16000);
            assert_eq!(out.len(), 32000);
            let level = peak(&out, 2000, 14000);
            assert!((9850..=10150).contains(&level), "{frequency} Hz peak {level}");
        }
    }

    #[test]
    fn aliases_are_removed() {
        for frequency in [8800.0, 9000.0, 12000.0, 20000.0] {
            let out = resample(&sine(frequency, 48000, 48000, 10000.0), 48000, 16000);
            let level = peak(&out, 2000, 14000);
            assert!(level <= 5, "{frequency} Hz leaked {level}");
        }
    }

    #[test]
    fn impulse_is_not_delayed() {
        let mut pcm = vec![0u8; 4800 * 2];
        pcm[960 * 2..960 * 2 + 2].copy_from_slice(&30000i16.to_le_bytes());
        let out = samples(&resample(&pcm, 48000, 16000));
        let position = (0..out.len()).max_by_key(|i| i32::from(out[*i]).abs()).unwrap();
        assert_eq!(position, 320);
    }

    #[test]
    fn other_rates() {
        let out = resample(&sine(1000.0, 44100, 44100, 10000.0), 44100, 16000);
        assert_eq!(out.len(), 32000);
        let level = peak(&out, 2000, 14000);
        assert!((9850..=10150).contains(&level), "peak {level}");
        let out = resample(&sine(1000.0, 8000, 8000, 10000.0), 8000, 16000);
        assert_eq!(out.len(), 32000);
        let level = peak(&out, 2000, 14000);
        assert!((9850..=10150).contains(&level), "peak {level}");
    }
}
