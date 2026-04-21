"""Download ONNX models required by the real engine.

Run once (or let main.py lifespan run it on first boot):
    python -m app.setup_models

Models:
    silero_vad.onnx  (~2 MB)  — GitHub raw from snakers4/silero-vad
    wespeaker.onnx   (~25 MB) — k2-fsa/sherpa-onnx releases
"""
from __future__ import annotations

import logging
import urllib.request
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")

SILERO_URL = (
    "https://github.com/snakers4/silero-vad/raw/master/"
    "src/silero_vad/data/silero_vad.onnx"
)
# WeSpeaker EN ResNet34: too weak at discriminating non-English speakers.
WESPEAKER_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx"
)
# 3D-Speaker ERes2Net large (Chinese-trained but generalizes well across languages,
# significantly more discriminative than WeSpeaker EN on cross-gender FR voices).
ERES2NET_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx"
)


def _download(url: str, target: Path) -> None:
    if target.is_file() and target.stat().st_size > 0:
        log.info("already present: %s", target)
        return
    log.info("downloading %s → %s", url, target)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    urllib.request.urlretrieve(url, str(tmp))
    tmp.rename(target)
    log.info("  done (%d bytes)", target.stat().st_size)


def main() -> None:
    target = settings.models_dir
    target.mkdir(parents=True, exist_ok=True)
    _download(SILERO_URL, target / "silero_vad.onnx")
    _download(WESPEAKER_URL, target / "wespeaker.onnx")
    _download(ERES2NET_URL, target / "eres2net_large.onnx")
    log.info("all models ready in %s", target)


if __name__ == "__main__":
    main()
