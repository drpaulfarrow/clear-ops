"""Clear Ops voice on Modal: Kyutai's Unmute (speech-to-text, turn taking, text-to-speech) on one
L4 GPU that only runs while Paul is talking, and scales to zero a few minutes after.

Deployed by .github/workflows/deploy.yml with `modal deploy voice/voice.py` when the repository
has MODAL_TOKEN_ID and MODAL_TOKEN_SECRET. The workflow also writes the Modal secret
"clearops-voice" with VOICE_KEY (shared with Fly, derived from the Modal token secret) and
CLEAROPS_LLM_URL (the voice brain on Fly, which Unmute calls as its OpenAI-compatible LLM).

Only the gateway (gateway.py) is reachable from outside, and only with VOICE_KEY. Unmute and the
two moshi-server workers listen on loopback. Nothing is recorded.
"""

import os
import subprocess
import sys
import sysconfig
from pathlib import Path

import modal

APP_NAME = "clearops-voice"
MOSHI_SERVER_VERSION = "0.6.4"
# The moshi-server Python environment (for the TTS's Python component), pinned as Unmute pins it.
MOSHI_PY_COMMIT = "4fae088e130f6b44d489aefc0ef1836745e921de"
# Unmute's backend, pinned to the commit this was written against.
UNMUTE_COMMIT = "e348e567c7020d40020412024f7aa03c38a3bc3e"
# L4 is Ada Lovelace (sm_89). Set so the CUDA kernels build without a GPU in the image builder.
CUDA_COMPUTE_CAP = "89"
GPU = os.environ.get("VOICE_GPU", "L4")

HERE = Path(__file__).parent
HF_CACHE = "/root/.cache/huggingface"

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12")
    .apt_install("curl", "build-essential", "ca-certificates", "libssl-dev", "git", "pkg-config", "cmake", "wget")
    .run_commands(
        "curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal",
        "curl -LsSf https://astral.sh/uv/0.7.2/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh",
    )
    .env({"PATH": "/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/cuda/bin", "CUDA_COMPUTE_CAP": CUDA_COMPUTE_CAP})
    # The TTS server embeds Python: build its environment first, then build moshi-server against it.
    .run_commands(
        "mkdir -p /opt/moshi",
        f"cd /opt/moshi && wget -q https://raw.githubusercontent.com/kyutai-labs/moshi/{MOSHI_PY_COMMIT}/rust/moshi-server/pyproject.toml",
        f"cd /opt/moshi && wget -q https://raw.githubusercontent.com/kyutai-labs/moshi/{MOSHI_PY_COMMIT}/rust/moshi-server/uv.lock",
        "cd /opt/moshi && uv sync --frozen",
        "cd /opt/moshi && export LD_LIBRARY_PATH=$(.venv/bin/python -c 'import sysconfig; print(sysconfig.get_config_var(\"LIBDIR\"))')"
        " && export PATH=/opt/moshi/.venv/bin:$PATH && export CXXFLAGS='-include cstdint'"
        f" && cargo install --features cuda moshi-server@{MOSHI_SERVER_VERSION}",
    )
    # Unmute's backend in its own environment, and the moshi-server configs it ships.
    .run_commands(
        f"git clone https://github.com/kyutai-labs/unmute.git /opt/unmute && cd /opt/unmute && git checkout {UNMUTE_COMMIT}",
        "cd /opt/unmute && uv sync --frozen --no-dev",
        # Load a handful of voices, not all 900 in kyutai/tts-voices: fetching every one at start-up got the
        # container rate-limited by Hugging Face. The pattern (fnmatch, where * crosses folders) matches the
        # TTS default (unmute-prod-website/default_voice.wav) and the VCTK p22x speakers, Cleo's included.
        "sed -i 's#hf-snapshot://kyutai/tts-voices/[*][*]/[*].safetensors#hf-snapshot://kyutai/tts-voices/[uv]*/[dp][e2][f2]*.safetensors#' /opt/unmute/services/moshi-server/configs/tts.toml",
        "grep -qF 'tts-voices/[uv]*/[dp][e2][f2]*.safetensors' /opt/unmute/services/moshi-server/configs/tts.toml",
    )
    # The gateway runs in the image's own Python.
    .pip_install("fastapi==0.162.5", "websockets==17.4", "sphn==0.2.1", "numpy==2.5.3", "httpx==0.28.1")
    .add_local_file(HERE / "gateway.py", "/root/gateway.py")
)

app = modal.App(APP_NAME)
hf_cache = modal.Volume.from_name("clearops-voice-hf-cache", create_if_missing=True)


def _moshi_env() -> dict:
    env = dict(os.environ)
    libdir = subprocess.check_output(
        ["/opt/moshi/.venv/bin/python", "-c", "import sysconfig; print(sysconfig.get_config_var('LIBDIR'))"], text=True
    ).strip()
    env["LD_LIBRARY_PATH"] = f"{libdir}:{env.get('LD_LIBRARY_PATH', '')}"
    env["VIRTUAL_ENV"] = "/opt/moshi/.venv"
    env["PATH"] = f"/opt/moshi/.venv/bin:{env['PATH']}"
    return env


@app.cls(
    image=image,
    gpu=GPU,
    volumes={HF_CACHE: hf_cache},
    secrets=[modal.Secret.from_name("clearops-voice")],
    # Scale to zero five minutes after the last call ends.
    scaledown_window=300,
    # One conversation can run for up to four hours.
    timeout=4 * 3600,
    startup_timeout=1800,
    max_containers=1,
)
@modal.concurrent(max_inputs=4)
class Voice:
    @modal.enter()
    def start(self) -> None:
        """Start the three loopback servers without waiting; the gateway tells Clear Ops while they warm up."""
        Path("/tmp/unmute_logs").mkdir(exist_ok=True)
        Path("/opt/unmute/static").mkdir(exist_ok=True)
        moshi = _moshi_env()
        configs = "/opt/unmute/services/moshi-server/configs"
        self.procs = [
            subprocess.Popen(["/root/.cargo/bin/moshi-server", "worker", "--config", f"{configs}/stt.toml", "--port", "8090"], cwd="/opt/unmute", env=moshi),
            subprocess.Popen(["/root/.cargo/bin/moshi-server", "worker", "--config", f"{configs}/tts.toml", "--port", "8089"], cwd="/opt/unmute", env=moshi),
        ]
        backend = dict(os.environ)
        backend.update(
            {
                "KYUTAI_STT_URL": "ws://127.0.0.1:8090",
                "KYUTAI_TTS_URL": "ws://127.0.0.1:8089",
                "KYUTAI_LLM_URL": os.environ["CLEAROPS_LLM_URL"],
                "KYUTAI_LLM_MODEL": "clearops-voice",
                "KYUTAI_LLM_API_KEY": os.environ["VOICE_KEY"],
            }
        )
        # Never record: make sure nothing upstream turned it on.
        backend.pop("KYUTAI_RECORDINGS_DIR", None)
        self.procs.append(
            subprocess.Popen(
                ["uv", "run", "--frozen", "--no-dev", "uvicorn", "unmute.main_websocket:app", "--host", "127.0.0.1", "--port", "8000", "--ws-per-message-deflate=false"],
                cwd="/opt/unmute",
                env=backend,
            )
        )

    @modal.exit()
    def stop(self) -> None:
        for p in getattr(self, "procs", []):
            p.terminate()
        try:
            hf_cache.commit()
        except Exception:
            pass

    @modal.asgi_app(label=APP_NAME)
    def web(self):
        sys.path.insert(0, "/root")
        from gateway import app_from_env

        return app_from_env()
