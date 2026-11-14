import array
import ctypes
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).parents[1]
FRAME = 320
RATE = 16000


def read_wav(path):
    with wave.open(str(path), "rb") as stream:
        assert (stream.getframerate(), stream.getnchannels(), stream.getsampwidth()) == (RATE, 1, 2)
        samples = array.array("h", stream.readframes(stream.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return list(samples)


class ReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        wrapper = Path(cls.temp.name) / "test_reference.c"
        wrapper.write_text('''#include "audio_reference.h"
void evaluate(const int16_t *samples, unsigned frames, int reset_at, float *matches) {
    audio_dsp_t dsp;
    audio_reference_matcher_t matcher;
    audio_dsp_init(&dsp);
    audio_reference_reset(&matcher);
    for (unsigned i = 0; i < frames; ++i) {
        if ((int)i == reset_at) audio_reference_reset(&matcher);
        const int16_t *pcm = samples + i * AUDIO_FRAME;
        audio_feature_t feature;
        float rms = audio_feature(&dsp, pcm, &feature), distance;
        unsigned clipped = 0, length;
        for (unsigned j = 0; j < AUDIO_FRAME; ++j)
            if (pcm[j] >= 32700 || pcm[j] <= -32700) ++clipped;
        matches[i] = audio_reference_feed(&matcher, &feature, rms, clipped, &distance, &length)
            ? distance : -1;
    }
}
''')
        library = Path(cls.temp.name) / "reference.so"
        subprocess.run(["clang", "-shared", "-fPIC", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror",
                        "-I", str(ROOT / "source"), str(ROOT / "source/audio_core.c"),
                        str(ROOT / "source/audio_reference.c"), str(wrapper), "-lm", "-o", str(library)], check=True)
        cls.library = ctypes.CDLL(str(library))
        cls.library.evaluate.argtypes = [ctypes.POINTER(ctypes.c_int16), ctypes.c_uint, ctypes.c_int,
                                         ctypes.POINTER(ctypes.c_float)]
        cls.original = read_wav(ROOT / "tests/fixtures/reference.wav")

    def matches(self, samples, reset_at=-1):
        frames = len(samples) // FRAME
        pcm = (ctypes.c_int16 * len(samples))(*samples)
        results = (ctypes.c_float * frames)()
        self.library.evaluate(pcm, frames, reset_at, results)
        return [(i * .02, score) for i, score in enumerate(results) if score >= 0]

    def padded(self, samples, offset=0):
        return [0] * (RATE + offset) + samples + [0] * (3 * RATE)

    def test_original_at_varied_gain_and_frame_alignment(self):
        for gain, offset in ((1, 0), (.5, 137), (.2, 319)):
            with self.subTest(gain=gain, offset=offset):
                matches = self.matches(self.padded([round(x * gain) for x in self.original], offset))
                self.assertEqual(len(matches), 1, matches)

    def test_playback_timing_changes_and_echo_noise(self):
        frames = [self.original[i:i+FRAME] for i in range(0, len(self.original), FRAME)]
        for scale in (.9, 1.1):
            adjusted = [x for i in range(round(len(frames) * scale))
                        for x in frames[min(len(frames)-1, int(i / scale))]]
            with self.subTest(scale=scale):
                self.assertEqual(len(self.matches(self.padded(adjusted))), 1)
        rng = random.Random(42)
        noisy = [round(.6 * x + (.18 * self.original[i-240] if i >= 240 else 0) + rng.gauss(0, 80))
                 for i, x in enumerate(self.original)]
        self.assertEqual(len(self.matches(self.padded(noisy))), 1)

    def test_reject_silence_noise_wrong_order_and_one_note(self):
        rng = random.Random(9)
        first_note = self.original[:20 * FRAME]
        cases = {
            "silence": [0] * (4 * RATE),
            "noise": [round(rng.gauss(0, 1000)) for _ in range(4 * RATE)],
            "reverse": list(reversed(self.original)),
            "one_note": first_note * 4,
            "unrelated_tone": [round(2500 * math.sin(2 * math.pi * 440 * i / RATE)) for i in range(3 * RATE)],
        }
        for name, samples in cases.items():
            with self.subTest(name=name):
                self.assertEqual(self.matches(self.padded(samples)), [])

    def test_clipped_input_and_capture_gap_are_rejected(self):
        clipped = [max(-32768, min(32767, x * 50)) for x in self.original]
        self.assertEqual(self.matches(self.padded(clipped)), [])
        self.assertEqual(self.matches(self.padded(self.original), reset_at=50 + 25), [])

    def test_second_complete_chime_after_cooldown(self):
        sequence = self.original + [0] * (3 * RATE) + self.original
        self.assertEqual(len(self.matches(self.padded(sequence))), 2)

    def test_full_source_recording_if_available(self):
        source = ROOT / ".host-build/reference-source.wav"
        if not source.exists():
            self.skipTest("Optional full-source WAV absent; the bundled reference fixture is tested above")
        self.assertEqual(len(self.matches(self.padded(read_wav(source)))), 1)
