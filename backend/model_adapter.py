"""Model runtime adapters.

The rest of PiCODE only uses `status()` and `stream_chat()`, so switching
inference runtimes means adding an adapter here, not touching the UI.

- OllamaAdapter: Ollama's native API (/api/tags, /api/show, /api/chat).
  Model family is read from Ollama metadata.
- OpenAICompatAdapter: any server exposing /v1/models and /v1/chat/completions
  (e.g. llama.cpp's llama-server, LM Studio, vLLM). Such servers do not report
  a model family, so Gemma 4 can only be inferred from the model id and is
  labeled as such.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def is_local_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in LOCAL_HOSTS or host.endswith(".localhost")


class ModelError(Exception):
    """An error with a stable code the UI can explain."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ModelConfig:
    runtime: str = "ollama"            # "ollama" | "openai"
    base_url: str = "http://127.0.0.1:11434"
    model: str = "gemma4:e2b"
    timeout_s: float = 300.0           # max wait between streamed chunks
    num_ctx: int = 4096                # Ollama context window
    api_key: str = field(default="", repr=False)  # backend-only, never sent to the browser


def _looks_like_gemma4(name: str) -> bool:
    n = name.lower().replace("-", "").replace("_", "").replace(" ", "")
    return "gemma4" in n


class BaseAdapter:
    def __init__(self, cfg: ModelConfig):
        self.cfg = cfg
        self.base = cfg.base_url.rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.cfg.api_key}"} if self.cfg.api_key else {}

    def _timeout(self, read: float | None = None) -> httpx.Timeout:
        return httpx.Timeout(connect=5.0, read=read or self.cfg.timeout_s, write=30.0, pool=5.0)

    async def status(self) -> dict:  # pragma: no cover - interface
        raise NotImplementedError

    def stream_chat(self, messages: list[dict], schema: dict, max_tokens: int) -> AsyncIterator[str]:
        raise NotImplementedError  # pragma: no cover - interface


class OllamaAdapter(BaseAdapter):
    _capabilities: dict[str, list[str]] = {}

    async def status(self) -> dict:
        info = {"reachable": False, "modelInstalled": False, "availableModels": [],
                "family": None, "isGemma4": None, "verification": "none"}
        async with httpx.AsyncClient(timeout=self._timeout(8.0), headers=self._headers()) as client:
            try:
                r = await client.get(f"{self.base}/api/tags")
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise ModelError("unreachable", f"Cannot reach Ollama at {self.base}: {e.__class__.__name__}") from e
            info["reachable"] = True
            models = r.json().get("models", [])
            info["availableModels"] = [m.get("name") for m in models]
            match = next((m for m in models if m.get("name") == self.cfg.model or m.get("model") == self.cfg.model), None)
            if match is None and models:
                # Auto-fallback to available model while preferred model is downloading
                fallback = next((m for m in models if "gemma" in m.get("name", "").lower()), models[0])
                self.cfg.model = fallback.get("name")
                match = fallback
            if match is None:
                return info
            info["modelInstalled"] = True
            details = match.get("details", {})
            info.update(parameterSize=details.get("parameter_size"),
                        quantization=details.get("quantization_level"),
                        format=details.get("format"))
            try:
                s = await client.post(f"{self.base}/api/show", json={"model": self.cfg.model})
                s.raise_for_status()
                show = s.json()
                caps = show.get("capabilities", [])
                OllamaAdapter._capabilities[self.cfg.model] = caps
                info["capabilities"] = caps
                family = show.get("details", {}).get("family") or details.get("family")
            except httpx.HTTPError:
                family = details.get("family")
            info["family"] = family
            if family:
                info["isGemma4"] = family.lower() == "gemma4"
                info["verification"] = "runtime-metadata"
        return info

    async def stream_chat(self, messages, schema, max_tokens):
        caps = OllamaAdapter._capabilities.get(self.cfg.model, [])
        body = {
            "model": self.cfg.model,
            "messages": messages,
            "stream": True,
            "format": schema,
            "keep_alive": "15m",
            "options": {"num_ctx": self.cfg.num_ctx, "temperature": 0.2, "num_predict": max_tokens},
        }
        if "thinking" in caps:
            body["think"] = False  # we want the JSON answer directly, not a reasoning trace
        async with httpx.AsyncClient(timeout=self._timeout(), headers=self._headers()) as client:
            try:
                async with client.stream("POST", f"{self.base}/api/chat", json=body) as r:
                    if r.status_code == 404:
                        raise ModelError("model_not_found", f"Model '{self.cfg.model}' is not installed in Ollama.")
                    if r.status_code >= 400:
                        text = (await r.aread()).decode(errors="replace")[:300]
                        raise ModelError("runtime_error", f"Ollama returned HTTP {r.status_code}: {text}")
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        chunk = json.loads(line)
                        if chunk.get("error"):
                            raise ModelError("runtime_error", str(chunk["error"])[:300])
                        piece = chunk.get("message", {}).get("content", "")
                        if piece:
                            yield piece
            except httpx.ReadTimeout as e:
                raise ModelError("timeout", f"The model did not respond within {int(self.cfg.timeout_s)}s.") from e
            except httpx.ConnectError as e:
                raise ModelError("unreachable", f"Cannot connect to Ollama at {self.base}. Is it running (ollama serve)?") from e
            except httpx.HTTPError as e:
                raise ModelError("unreachable", f"Connection to Ollama failed: {e.__class__.__name__}") from e


class OpenAICompatAdapter(BaseAdapter):
    async def status(self) -> dict:
        info = {"reachable": False, "modelInstalled": False, "availableModels": [],
                "family": None, "isGemma4": None, "verification": "none"}
        async with httpx.AsyncClient(timeout=self._timeout(8.0), headers=self._headers()) as client:
            try:
                r = await client.get(f"{self.base}/v1/models")
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise ModelError("unreachable", f"Cannot reach an OpenAI-compatible server at {self.base}: "
                                                f"{e.__class__.__name__}") from e
        info["reachable"] = True
        ids = [m.get("id") for m in r.json().get("data", [])]
        info["availableModels"] = ids
        info["modelInstalled"] = self.cfg.model in ids
        if info["modelInstalled"]:
            # This API exposes no architecture metadata; only the id can be inspected.
            info["isGemma4"] = _looks_like_gemma4(self.cfg.model)
            info["verification"] = "model-name-only"
        return info

    async def stream_chat(self, messages, schema, max_tokens):
        body = {
            "model": self.cfg.model,
            "messages": messages,
            "stream": True,
            "temperature": 0.2,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "picode_analysis", "schema": schema}},
        }
        async with httpx.AsyncClient(timeout=self._timeout(), headers=self._headers()) as client:
            try:
                async with client.stream("POST", f"{self.base}/v1/chat/completions", json=body) as r:
                    if r.status_code >= 400:
                        text = (await r.aread()).decode(errors="replace")[:300]
                        raise ModelError("runtime_error", f"Server returned HTTP {r.status_code}: {text}")
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        delta = json.loads(data)["choices"][0].get("delta", {})
                        if delta.get("content"):
                            yield delta["content"]
            except httpx.ReadTimeout as e:
                raise ModelError("timeout", f"The model did not respond within {int(self.cfg.timeout_s)}s.") from e
            except httpx.HTTPError as e:
                raise ModelError("unreachable", f"Connection failed: {e.__class__.__name__}") from e


ADAPTERS = {"ollama": OllamaAdapter, "openai": OpenAICompatAdapter}


def make_adapter(cfg: ModelConfig) -> BaseAdapter:
    if cfg.runtime not in ADAPTERS:
        raise ModelError("unsupported_runtime", f"Unknown runtime '{cfg.runtime}'. Use one of {sorted(ADAPTERS)}.")
    return ADAPTERS[cfg.runtime](cfg)
