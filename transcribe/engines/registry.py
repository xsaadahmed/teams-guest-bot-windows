"""Supported STT engines — import-only detection, no model downloads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional


@dataclass(frozen=True)
class EngineSpec:
    id: str
    label: str
    models: List[str]
    default_model: str
    detect: Callable[[], Optional[dict]]


def _detect_faster_whisper() -> Optional[dict]:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return None
    version = getattr(faster_whisper, "__version__", None)
    return {
        "installed": True,
        "version": version,
        "models": ["tiny", "base", "small", "medium", "large-v3"],
        "defaultModel": "small",
    }


def _detect_parakeet() -> Optional[dict]:
    try:
        import nemo.collections.asr  # noqa: F401
    except ImportError:
        return None
    try:
        import nemo

        version = getattr(nemo, "__version__", None)
    except Exception:
        version = None
    return {
        "installed": True,
        "version": version,
        "models": ["nvidia/parakeet-tdt-0.6b-v2"],
        "defaultModel": "nvidia/parakeet-tdt-0.6b-v2",
    }


ENGINE_SPECS: List[EngineSpec] = [
    EngineSpec(
        id="faster_whisper",
        label="faster-whisper",
        models=["tiny", "base", "small", "medium", "large-v3"],
        default_model="small",
        detect=_detect_faster_whisper,
    ),
    EngineSpec(
        id="parakeet",
        label="NVIDIA Parakeet (NeMo)",
        models=["nvidia/parakeet-tdt-0.6b-v2"],
        default_model="nvidia/parakeet-tdt-0.6b-v2",
        detect=_detect_parakeet,
    ),
]


def engine_by_id(engine_id: str) -> Optional[EngineSpec]:
    for spec in ENGINE_SPECS:
        if spec.id == engine_id:
            return spec
    return None
