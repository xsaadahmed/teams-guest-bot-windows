#!/usr/bin/env python3
"""
Produce a verbatim, speaker-attributed transcript by combining:

  1. ASR transcription of the recorded .wav (faster-whisper or NVIDIA Parakeet)
  2. the real speaker names + timestamps the bot scraped from Teams' live captions
     (saved next to the .wav as <name>.captions.json)

Usage:
    python transcribe_with_names.py path/to/recording.wav
    python transcribe_with_names.py path/to/recording.wav --engine faster_whisper --model small
    python transcribe_with_names.py path/to/recording.wav --engine parakeet --model nvidia/parakeet-tdt-0.6b-v2

Outputs (next to the .wav):
    <name>.named_transcript.txt
    <name>.named_transcript.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Anaconda + ctranslate2 OpenMP conflict on Windows — set before importing STT libs.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

from engines.faster_whisper_engine import transcribe as transcribe_faster_whisper
from engines.parakeet_engine import transcribe as transcribe_parakeet
from engines.registry import engine_by_id
from engines.speaker_align import load_speaker_intervals, speaker_for_segment


def fmt_ts(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def main() -> None:
    parser = argparse.ArgumentParser(description="ASR transcription with real Teams speaker names.")
    parser.add_argument("wav", help="Path to the recording .wav file.")
    parser.add_argument("--engine", default="faster_whisper", help="faster_whisper or parakeet.")
    parser.add_argument("--model", default=None, help="Model id for the selected engine.")
    parser.add_argument("--device", default="cpu", help="cpu or cuda.")
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="ctranslate2 compute type for faster-whisper (int8 for CPU, float16 for GPU).",
    )
    parser.add_argument("--language", default=None, help="Force a language code (faster-whisper only).")
    args = parser.parse_args()

    if not os.path.exists(args.wav):
        sys.exit(f"WAV not found: {args.wav}")

    spec = engine_by_id(args.engine)
    if spec is None:
        sys.exit(f"Unknown engine: {args.engine}")

    model_name = args.model or spec.default_model

    base = os.path.splitext(args.wav)[0]
    captions_path = base + ".captions.json"
    intervals = load_speaker_intervals(captions_path)
    if not intervals:
        print(
            f"WARNING: no speaker timeline found at {captions_path} - output will be transcribed "
            "but every line will be labeled 'Unknown'.",
            file=sys.stderr,
        )

    if args.engine == "faster_whisper":
        segments, meta = transcribe_faster_whisper(
            args.wav,
            model_name,
            device=args.device,
            compute_type=args.compute_type,
            language=args.language,
        )
    elif args.engine == "parakeet":
        segments, meta = transcribe_parakeet(args.wav, model_name, device=args.device)
    else:
        sys.exit(f"Engine not implemented: {args.engine}")

    results = []
    lines = []
    for seg in segments:
        speaker = speaker_for_segment(seg["start"], seg["end"], intervals)
        text = seg["text"].strip()
        if not text:
            continue
        results.append({"start": seg["start"], "end": seg["end"], "speaker": speaker, "text": text})
        lines.append(f"[{fmt_ts(seg['start'])}] {speaker}: {text}")

    txt_path = base + ".named_transcript.txt"
    json_path = base + ".named_transcript.json"

    engine_label = spec.label
    header = f"--- Verbatim transcript ({engine_label} '{model_name}') with Teams speaker names ---\n"
    if meta.get("language") is not None:
        prob = meta.get("language_probability")
        if prob is not None:
            header += f"Detected language: {meta['language']} (p={prob:.2f})\n"
    header += "\n"

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(lines) + "\n")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "engine": meta.get("engine", args.engine),
                "model": model_name,
                "language": meta.get("language"),
                "segments": results,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"\nDone. Wrote:\n  {txt_path}\n  {json_path}")


if __name__ == "__main__":
    main()
