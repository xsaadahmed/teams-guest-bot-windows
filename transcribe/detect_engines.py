#!/usr/bin/env python3
"""Import-only probe for STT engines. Prints JSON to stdout — no model downloads."""

from __future__ import annotations

import json
import sys

from engines.registry import ENGINE_SPECS


def main() -> None:
    engines = []
    for spec in ENGINE_SPECS:
        detected = spec.detect()
        if detected:
            engines.append(
                {
                    "id": spec.id,
                    "label": spec.label,
                    "installed": True,
                    "version": detected.get("version"),
                    "models": detected.get("models", spec.models),
                    "defaultModel": detected.get("defaultModel", spec.default_model),
                }
            )
        else:
            engines.append(
                {
                    "id": spec.id,
                    "label": spec.label,
                    "installed": False,
                    "version": None,
                    "models": spec.models,
                    "defaultModel": spec.default_model,
                }
            )

    payload = {
        "pythonPath": sys.executable,
        "pythonVersion": ".".join(str(x) for x in sys.version_info[:3]),
        "engines": engines,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
