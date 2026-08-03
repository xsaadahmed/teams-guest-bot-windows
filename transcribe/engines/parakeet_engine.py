"""NVIDIA Parakeet (NeMo) ASR backend."""

from __future__ import annotations

import sys
from typing import List, Tuple


def transcribe(wav_path: str, model_name: str, device: str = "cpu") -> Tuple[List[dict], dict]:
    try:
        import nemo.collections.asr as nemo_asr
    except ImportError:
        sys.exit("NeMo ASR is not installed in this Python environment.")

    # NeMo uses CUDA when available; device is best-effort for CPU-only installs.
    print(f"Loading Parakeet model '{model_name}'...", file=sys.stderr)
    model = nemo_asr.models.ASRModel.from_pretrained(model_name)

    if device == "cuda":
        try:
            import torch

            if torch.cuda.is_available():
                model = model.cuda()
        except Exception:
            pass

    print("Transcribing...", file=sys.stderr)
    out = model.transcribe([wav_path], timestamps=True)

    results: List[dict] = []
    if not out:
        return results, {"engine": "parakeet", "model": model_name, "language": None}

    hypothesis = out[0]
    segments = getattr(hypothesis, "timestamp", None) or getattr(hypothesis, "timestamps", None)
    text = getattr(hypothesis, "text", "") or str(hypothesis)

    if segments:
        for seg in segments:
            start = float(seg.get("start", seg.get("start_offset", 0)))
            end = float(seg.get("end", seg.get("end_offset", start)))
            seg_text = (seg.get("segment") or seg.get("text") or "").strip()
            if seg_text:
                results.append({"start": start, "end": end, "text": seg_text})
    elif text.strip():
        results.append({"start": 0.0, "end": 0.0, "text": text.strip()})

    meta = {"engine": "parakeet", "model": model_name, "language": None}
    return results, meta
