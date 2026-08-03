"""faster-whisper ASR backend."""

from __future__ import annotations

import sys
from typing import List, Optional, Tuple


def transcribe(
    wav_path: str,
    model_name: str,
    device: str = "cpu",
    compute_type: str = "int8",
    language: Optional[str] = None,
) -> Tuple[List[dict], dict]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper is not installed in this Python environment.")

    print(
        f"Loading Whisper model '{model_name}' ({device}/{compute_type})...",
        file=sys.stderr,
    )
    model = WhisperModel(model_name, device=device, compute_type=compute_type)

    print("Transcribing (this can take a while on CPU)...", file=sys.stderr)
    segments, info = model.transcribe(wav_path, vad_filter=True, language=language)

    results = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        results.append({"start": seg.start, "end": seg.end, "text": text})

    meta = {
        "engine": "faster_whisper",
        "model": model_name,
        "language": info.language,
        "language_probability": info.language_probability,
    }
    return results, meta
