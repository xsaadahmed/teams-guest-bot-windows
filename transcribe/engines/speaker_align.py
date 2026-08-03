"""Align ASR segments with Teams caption speaker intervals."""

from __future__ import annotations

import json
import os
from typing import List, Tuple


def load_speaker_intervals(captions_path: str) -> List[Tuple[float, float, str]]:
    """Return (start_s, end_s, speaker) from the bot's captions.json (ms -> seconds)."""
    if not os.path.exists(captions_path):
        return []
    with open(captions_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    intervals = []
    for entry in data.get("captions", []):
        start_s = entry.get("tStartMs", 0) / 1000.0
        end_s = entry.get("tEndMs", entry.get("tStartMs", 0)) / 1000.0
        if end_s - start_s < 1.5:
            end_s = start_s + 1.5
        intervals.append((start_s, end_s, entry.get("speaker", "Unknown")))
    intervals.sort(key=lambda x: x[0])
    return intervals


def speaker_for_segment(seg_start: float, seg_end: float, intervals: List[Tuple[float, float, str]]) -> str:
    """Pick the speaker whose caption window overlaps this segment the most."""
    best_speaker = None
    best_overlap = 0.0
    for cs, ce, speaker in intervals:
        overlap = min(seg_end, ce) - max(seg_start, cs)
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker

    if best_speaker is not None:
        return best_speaker

    mid = (seg_start + seg_end) / 2.0
    candidate = None
    for cs, _ce, speaker in intervals:
        if cs <= mid:
            candidate = speaker
        else:
            break
    return candidate or "Unknown"
