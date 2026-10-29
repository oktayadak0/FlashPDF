"""PiCODE backend: serves the static frontend and is the only component
that talks to the model runtime.

Why a backend at all? Browsers must load PDF.js modules over http (not file://),
the model endpoint and any API key stay out of frontend code, and the backend
enforces context-size limits and the "remote endpoint needs consent" rule.

Run (from the project root):
    .venv\\Scripts\\python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import time
from pathlib import Path
from typing import Literal, Optional

# Ensure correct MIME types on Windows (where .mjs is often mapped to text/plain)
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import prompts
from .model_adapter import ADAPTERS, ModelConfig, ModelError, is_local_url, make_adapter

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = Path(__file__).resolve().parent / "picode.config.json"  # git-ignored
LEGACY_CONFIG_FILE = CONFIG_FILE.with_name("focusnote.config.json")  # name used before the rename
MAX_CONTEXT_CHARS = 18000
MAX_OUTPUT_TOKENS = {"note": 2600}  # enough tokens so JSON is never truncated
MAX_BODY_BYTES = 200_000


# ---------------------------------------------------------------- configuration

def env(name: str, default: str) -> str:
    """PICODE_<name>, falling back to the pre-rename FOCUSNOTE_<name>."""
    return os.getenv(f"PICODE_{name}") or os.getenv(f"FOCUSNOTE_{name}") or default


def load_config() -> ModelConfig:
    cfg = ModelConfig(
        runtime=env("RUNTIME", "ollama"),
        base_url=env("MODEL_BASE_URL", "http://127.0.0.1:11434"),
        model=env("MODEL", "gemma4:e2b"),
        timeout_s=float(env("TIMEOUT", "300")),
        num_ctx=int(env("NUM_CTX", "4096")),
        api_key=env("API_KEY", ""),
    )
    source = CONFIG_FILE if CONFIG_FILE.exists() else LEGACY_CONFIG_FILE
    if source.exists():  # values saved from the settings dialog
        try:
            saved = json.loads(source.read_text(encoding="utf-8"))
            cfg.runtime = saved.get("runtime", cfg.runtime)
            cfg.base_url = saved.get("baseUrl", cfg.base_url)
            cfg.model = saved.get("model", cfg.model)
        except (OSError, ValueError):
            pass
    return cfg


CONFIG = load_config()


def public_config() -> dict:
    return {"runtime": CONFIG.runtime, "baseUrl": CONFIG.base_url, "model": CONFIG.model,
            "isLocal": is_local_url(CONFIG.base_url), "timeoutSeconds": CONFIG.timeout_s,
            "runtimes": sorted(ADAPTERS)}


# ---------------------------------------------------------------- request models

Task = Literal["note"]


class DocInfo(BaseModel):
    title: str = Field(max_length=200)
    pageCount: int = Field(ge=1, le=20000)
    language: Optional[str] = Field(default=None, max_length=8)


class Progress(BaseModel):
    currentPage: int = Field(ge=1)
    pagesVisited: int = Field(ge=0)
    percentVisited: float = Field(ge=0, le=100)
    totalReadingSeconds: float = Field(ge=0)


class Excerpt(BaseModel):
    page: int = Field(ge=1)
    text: str = Field(max_length=2600)
    reasons: list[str] = Field(default_factory=list, max_length=6)
    depth: Literal["deep", "standard", "brief"] = "standard"
    attentionSeconds: float = Field(default=0, ge=0)


class CriticalPassage(BaseModel):
    """Text the reader selected (click + drag), with the paragraph around it."""
    page: int = Field(ge=1)
    text: str = Field(max_length=600)
    block: str = Field(default="", max_length=1600)
    count: int = Field(ge=1, default=1)
    importance: Literal["CRITICAL_IMPORTANCE"] = "CRITICAL_IMPORTANCE"


class HighRelevancePassage(BaseModel):
    """Lines the reader scrolled back up over to read again."""
    page: int = Field(ge=1)
    text: str = Field(max_length=500)
    count: int = Field(ge=1, default=1)
    relevance: Literal["HIGH_RELEVANCE"] = "HIGH_RELEVANCE"


class PageSignal(BaseModel):
    page: int = Field(ge=1)
    visits: int = Field(ge=0)
    revisits: int = Field(ge=0)
    dwellSeconds: float = Field(ge=0)
    rereads: int = Field(default=0, ge=0)


class ExistingNote(BaseModel):
    page: Optional[int] = None
    text: str = Field(max_length=500)


class ContextPackage(BaseModel):
    task: Task
    document: DocInfo
    progress: Progress
    excerpts: list[Excerpt] = Field(min_length=1, max_length=14)
    criticalPassages: list[CriticalPassage] = Field(default_factory=list, max_length=12)
    highRelevancePassages: list[HighRelevancePassage] = Field(default_factory=list, max_length=12)
    pageSignals: list[PageSignal] = Field(default_factory=list, max_length=80)
    existingNotes: list[ExistingNote] = Field(default_factory=list, max_length=10)


class AnalyzeRequest(BaseModel):
    context: ContextPackage
    allowRemote: bool = False


class ConfigUpdate(BaseModel):
    runtime: str = Field(max_length=20)
    baseUrl: str = Field(max_length=300, pattern=r"^https?://")
    model: str = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------- app

app = FastAPI(title="PiCODE", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def local_only_guard(request: Request, call_next):
    """Block cross-site requests and DNS-rebinding against the local API.

    Without this, any website open in the browser could POST to
    http://127.0.0.1:8000/api/config and redirect analysis data elsewhere.
    """
    if request.url.path.startswith("/api/"):
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if host not in {"127.0.0.1", "localhost", "[::1]"}:
            return JSONResponse({"error": "forbidden_host"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != f"{request.url.scheme}://{request.headers.get('host')}":
            return JSONResponse({"error": "forbidden_origin"}, status_code=403)
        if int(request.headers.get("content-length") or 0) > MAX_BODY_BYTES:
            return JSONResponse({"error": "payload_too_large"}, status_code=413)
    response = await call_next(request)
    # Force revalidation so browsers never hold stale cached JavaScript modules or MIME types.
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    if request.url.path.endswith(".mjs") or request.url.path.endswith(".js"):
        response.headers["Content-Type"] = "application/javascript; charset=utf-8"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/config")
async def get_config():
    return public_config()


@app.post("/api/config")
async def set_config(update: ConfigUpdate):
    if update.runtime not in ADAPTERS:
        return JSONResponse({"error": "unsupported_runtime", "message": f"Use one of {sorted(ADAPTERS)}"},
                            status_code=400)
    CONFIG.runtime, CONFIG.base_url, CONFIG.model = update.runtime, update.baseUrl.rstrip("/"), update.model
    try:
        CONFIG_FILE.write_text(json.dumps({"runtime": CONFIG.runtime, "baseUrl": CONFIG.base_url,
                                           "model": CONFIG.model}, indent=2), encoding="utf-8")
    except OSError:
        pass  # still applied for this process
    return public_config()


@app.get("/api/status")
async def status():
    """Real connection check against the configured runtime (never faked)."""
    result = {**public_config(), "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    try:
        result.update(await make_adapter(CONFIG).status())
        result["ok"] = result["reachable"] and result["modelInstalled"]
        if result["reachable"] and not result["modelInstalled"]:
            result["error"] = {"code": "model_not_found",
                               "message": f"'{CONFIG.model}' is not available on this runtime."}
    except ModelError as e:
        result.update(ok=False, reachable=False, modelInstalled=False,
                      error={"code": e.code, "message": e.message})
    return result


def _ndjson(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


async def _collect(adapter, messages, schema, max_tokens) -> str:
    return "".join([piece async for piece in adapter.stream_chat(messages, schema, max_tokens)])


async def _expand(adapter, ctx: dict, short: list[dict]) -> list[int]:
    """One expansion request for too-short deep sections; replaces their content in place.
    Any failure keeps the original note. Returns the pages that were expanded."""
    try:
        raw = await _collect(adapter, prompts.expand_messages(ctx, short), prompts.EXPAND_SCHEMA, 600)
        data, errors = _parse(raw, prompts.EXPAND_SCHEMA)
    except ModelError:
        return []
    if data is None:
        return []
    by_page = {s["page"]: s for s in short}
    done = []
    for item in data["sections"]:
        sec = by_page.get(item["page"])
        content = prompts.clean_prose(item["content"])
        if sec is not None and len(content.split()) > len(sec.get("content", "").split()):
            sec["content"] = content
            done.append(item["page"])
    return sorted(set(done))


def _parse(raw: str, schema: dict) -> tuple[Optional[dict], list[str]]:
    raw_str = raw.strip()
    if raw_str.startswith("```"):
        raw_str = re.sub(r"^```(?:json)?\s*", "", raw_str, flags=re.IGNORECASE)
        raw_str = re.sub(r"\s*```$", "", raw_str)
    try:
        data = json.loads(raw_str)
    except ValueError as e:
        m = re.search(r"(\{.*\})", raw_str, flags=re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(1))
            except ValueError:
                return None, [f"invalid JSON ({e.msg})"]
        else:
            return None, [f"invalid JSON ({e.msg})"]
    errors = prompts.validate(data, schema)
    return (prompts.normalize(data, schema), []) if not errors else (None, errors)


@app.post("/api/analyze")
async def analyze(raw_request: Request):
    try:
        req = AnalyzeRequest.model_validate(await raw_request.json())
    except (ValidationError, ValueError) as e:
        msg = e.errors()[0]["msg"] if isinstance(e, ValidationError) else "Body must be JSON."
        return JSONResponse({"error": "invalid_context", "message": msg}, status_code=422)

    ctx = req.context.model_dump()
    rendered = prompts.render_context(ctx)
    if len(rendered) > MAX_CONTEXT_CHARS:
        return JSONResponse({"error": "context_too_large",
                             "message": f"Context is {len(rendered)} chars; limit is {MAX_CONTEXT_CHARS}."},
                            status_code=413)
    if not is_local_url(CONFIG.base_url) and not req.allowRemote:
        return JSONResponse({"error": "remote_not_confirmed",
                             "message": "The model endpoint is not on this computer. Confirm before sending."},
                            status_code=409)

    schema = prompts.task_schema(ctx["task"])
    max_tokens = MAX_OUTPUT_TOKENS[ctx["task"]]
    adapter = make_adapter(CONFIG)

    async def run():
        started = time.monotonic()
        yield _ndjson({"type": "status", "phase": "sent", "model": CONFIG.model,
                       "promptChars": len(rendered)})
        try:
            # Streaming lets the UI show live progress; first chunk may take a while if the model is cold.
            out = []
            count = 0
            async for piece in adapter.stream_chat(prompts.build_messages(ctx), schema, max_tokens):
                out.append(piece)
                count += 1
                if count == 1 or count % 8 == 0:
                    yield _ndjson({"type": "progress", "chunks": count})
            raw = "".join(out)
            data, errors = _parse(raw, schema)
            repaired = False
            if data is None:
                yield _ndjson({"type": "status", "phase": "repairing", "errors": errors[:5]})
                raw2 = await _collect(adapter, prompts.repair_messages(ctx, raw, errors), schema, max_tokens)
                data, errors = _parse(raw2, schema)
                repaired = True
            if data is None:
                yield _ndjson({"type": "error", "code": "invalid_response",
                               "message": "The model returned output that does not match the schema, "
                                          "even after one repair attempt.", "details": errors[:5]})
                return
            prompts.clean_note(data.get("studyNote", {}))
            # Depth guarantee: pages the reader focused on must not come back as a one-liner.
            expanded = []
            short = prompts.short_deep_sections(ctx, data.get("studyNote", {}))
            if short:
                yield _ndjson({"type": "status", "phase": "expanding", "pages": [s["page"] for s in short]})
                expanded = await _expand(adapter, ctx, short)
            yield _ndjson({"type": "result", "task": ctx["task"], "analysis": data,
                           "meta": {"runtime": CONFIG.runtime, "model": CONFIG.model,
                                    "durationSeconds": round(time.monotonic() - started, 1),
                                    "repaired": repaired, "expandedPages": expanded, "promptChars": len(rendered),
                                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}})
        except ModelError as e:
            yield _ndjson({"type": "error", "code": e.code, "message": e.message})

    return StreamingResponse(run(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- static frontend
# Only these folders are served; backend source, .venv and config stay private.
for folder in ("js", "styles", "vendor", "samples", "schema", "tests", "assets"):
    if (ROOT / folder).is_dir():
        app.mount(f"/{folder}", StaticFiles(directory=ROOT / folder, html=folder == "tests"), name=folder)


@app.get("/")
async def index():
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-cache"})
