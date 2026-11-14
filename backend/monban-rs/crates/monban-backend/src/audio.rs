//! PCM helpers shared by the TTS preview, ASR uploads and the voice pipeline.

/// A mono 16-bit little-endian WAV file (what Python's `wave` module writes).
pub fn wav_mono16(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_matches_python_wave_module() {
        // Bytes produced by Python: wave.open(..., "wb") with 1 channel, width 2, 48000 Hz
        // and two zero samples.
        let expected: [u8; 48] = [
            b'R', b'I', b'F', b'F', 40, 0, 0, 0, b'W', b'A', b'V', b'E', b'f', b'm', b't', b' ',
            16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0xBB, 0, 0, 0, 0x77, 1, 0, 2, 0, 16, 0, b'd', b'a',
            b't', b'a', 4, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(wav_mono16(&[0, 0, 0, 0], 48000), expected);
    }
}
