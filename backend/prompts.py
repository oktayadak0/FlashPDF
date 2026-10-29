"""Prompt construction and output-schema handling for PiCODE.

The output schema lives in schema/analysis.schema.json and is shared with the
frontend validator. This module turns it into per-task JSON schemas, renders the
compact context package into a prompt, and performs a structural validation of
the model's answer (the frontend additionally checks page references and
evidence against the real PDF text).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "analysis.schema.json"
_SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
TASKS = tuple(_SCHEMA["tasks"].keys())


def task_schema(task: str) -> dict:
    """JSON schema for one task: only the keys that task must return."""
    keys = _SCHEMA["tasks"][task]
    return {
        "type": "object",
        "properties": {k: _SCHEMA["properties"][k] for k in keys},
        "required": list(keys),
    }


def validate(value, schema: dict, path: str = "$") -> list[str]:
    """Minimal JSON-schema subset validator (type/required/properties/items/enum/minimum).

    maxItems / maxLength are not errors here; they are enforced by truncation in
    `normalize` so a slightly verbose model answer is still usable.
    """
    errors: list[str] = []
    t = schema.get("type")
    if t == "object":
        if not isinstance(value, dict):
            return [f"{path}: expected object"]
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key}: missing")
        for key, sub in schema.get("properties", {}).items():
            if key in value:
                errors += validate(value[key], sub, f"{path}.{key}")
    elif t == "array":
        if not isinstance(value, list):
            return [f"{path}: expected array"]
        for i, item in enumerate(value):
            errors += validate(item, schema.get("items", {}), f"{path}[{i}]")
    elif t == "string":
        if not isinstance(value, str):
            errors.append(f"{path}: expected string")
        elif "enum" in schema and value not in schema["enum"]:
            errors.append(f"{path}: must be one of {schema['enum']}")
    elif t == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            errors.append(f"{path}: expected integer")
        elif "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: must be >= {schema['minimum']}")
    return errors


def normalize(value, schema: dict):
    """Truncate arrays/strings to schema limits and drop unknown keys."""
    t = schema.get("type")
    if t == "object" and isinstance(value, dict):
        props = schema.get("properties", {})
        return {k: normalize(v, props[k]) for k, v in value.items() if k in props}
    if t == "array" and isinstance(value, list):
        items = value[: schema.get("maxItems", len(value))]
        return [normalize(v, schema.get("items", {})) for v in items]
    if t == "string" and isinstance(value, str):
        return value.strip()[: schema.get("maxLength", len(value))]
    return value


LANGUAGE_NAMES = {"tr": "Turkish (Türkçe)", "en": "English"}

SYSTEM_PROMPT = """You are PiCODE, a study-notes assistant. You receive excerpts of the PDF \
pages the reader actually read, and a summary of how they read them. Write ONE study note as JSON. \
The app shows it as a single, scannable block: the highlight bullets first, then a summary made \
of the "overview" and one short sub-headed part per section, in page order.

Importance tags (strongest first):
- CRITICAL_IMPORTANCE: text the reader selected with the mouse. Highest weight. Every critical \
passage MUST get its own highlight bullet (importance "CRITICAL_IMPORTANCE") and must be explained \
first and most thoroughly in its page's section.
- HIGH_RELEVANCE: lines the reader scrolled back up to read again. Second highest weight. Give \
each its own highlight bullet (importance "HIGH_RELEVANCE") and explain it in detail.
- Then returns to a page, then reading time. Fast scrolling and stays under one second were \
already removed; pages that were not read are not included.

Structure:
- "title": a short title for the note.
- "highlights": 3-8 bullet points, most important first: all CRITICAL_IMPORTANCE passages, then \
HIGH_RELEVANCE passages, then the most important other ideas as "KEY_POINT". Each "text" is one \
clear sentence stating the idea (not a quote); "evidence" is the supporting quote.
- "overview": 2-3 sentences (at most 60 words): what the read part of the document is about and \
how its ideas connect.
- "sections": exactly one section per excerpt, in page order. "heading" is a clear sub-heading of \
2-6 words that names the topic (it is shown as a sub-heading). "content" is made of paragraphs \
of at most 2-3 sentences each, separated by a blank line; plain text — no markdown, no bullet \
lists, no page labels. Each paragraph stays short; the DEPTH decides HOW MANY paragraphs a \
section gets, so deep sections are long in total. Put the important facts in "keyPoints" \
(short phrases, shown as bullets under the paragraphs).
- "reviewLater": pages worth another look, each tied to an observed signal; "reason" is a short \
full sentence in the note's language (e.g. what was re-read and what to practise), never just a label.
- "questions": 3-4 self-test questions with short answers.

Depth — follow the DEPTH given for each excerpt; it is computed from the signals above:
- deep: the most important part of the note — never shorter than a standard section. 3-4 \
paragraphs, 120-180 words in total: start with the CRITICAL / HIGH passages of that page, \
define the concepts, explain why and how, give the studies, numbers and examples from the text. \
4-6 keyPoints.
- standard: the main idea in 40-70 words as 1-2 short paragraphs. 2-3 keyPoints.
- brief: one sentence (10-25 words). 0-1 keyPoints.

Grounding rules:
1. Use only facts from the excerpts. Do not add outside knowledge.
2. "page" must be a page number that appears in the excerpts.
3. "evidence" must be copied verbatim from that page's excerpt (at most 25 words). Never paraphrase it.
4. Interaction data is observational. Describe it only as behaviour ("you selected this passage", \
"you scrolled back to re-read these lines", "you returned to this page twice"). \
Never claim the reader was confused, struggled, understood, liked or felt anything.
5. "readerNote" + "signal": only when the interaction data lists a signal for that page; then \
write one sentence that names the observation and gives a concrete study tip. Otherwise \
readerNote is "" and signal is "none".
6. reviewLater items must cite a signal recorded for that page; if there is none, return [].
7. Write everything in the requested language."""

DEPTH_LABELS = {"deep": "DEEP", "standard": "STANDARD", "brief": "BRIEF"}
# Repeated next to each excerpt: inline length targets are followed far more reliably than global ones.
DEPTH_TARGETS = {
    "deep": "write 3-4 paragraphs of 2-3 sentences each (120-180 words in total), plus 4-6 keyPoints",
    "standard": "write 1-2 paragraphs of 2-3 sentences (40-70 words in total), plus 2-3 keyPoints",
    "brief": "write one sentence, 0-1 keyPoints",
}

TASK_INSTRUCTIONS = {
    "note": "Write the single study note now: highlights first (CRITICAL_IMPORTANCE, then HIGH_RELEVANCE, "
            "then KEY_POINT), then one section per excerpt in page order with the depth as marked.",
}


def render_context(ctx: dict) -> str:
    """Render the validated context package as compact plain text for the model."""
    doc, prog = ctx["document"], ctx["progress"]
    language = LANGUAGE_NAMES.get(doc.get("language") or "", "the same language as the document")
    lines = [
        f"DOCUMENT: {doc['title']} ({doc['pageCount']} pages)",
        f"WRITE THE NOTE IN: {language}",
        f"READING PROGRESS: current page {prog['currentPage']}, {prog['pagesVisited']} pages visited "
        f"({prog['percentVisited']}%), about {round(prog['totalReadingSeconds'] / 60, 1)} minutes of reading.",
        "",
    ]

    # Highest-weight material first, so the model sees it before the excerpts.
    if ctx["criticalPassages"]:
        lines.append("CRITICAL_IMPORTANCE — passages the reader SELECTED (highest weight) [signal: selection]:")
        for c in ctx["criticalPassages"]:
            times = f", selected {c['count']} times" if c["count"] > 1 else ""
            lines.append(f"- page {c['page']}{times}: selected \"{c['text']}\"")
            if c.get("block") and c["block"] != c["text"]:
                lines.append(f"  in the paragraph: \"{c['block']}\"")
        lines.append("")
    if ctx["highRelevancePassages"]:
        lines.append("HIGH_RELEVANCE — passages the reader RE-READ by scrolling back up [signal: reread]:")
        for h in ctx["highRelevancePassages"]:
            times = f" ({h['count']} times)" if h["count"] > 1 else ""
            lines.append(f"- page {h['page']}{times}: \"{h['text']}\"")
        lines.append("")

    lines.append("EXCERPTS:")
    for ex in ctx["excerpts"]:
        tags = ", ".join(ex["reasons"]) or "not read closely"
        attention = f", ~{round(ex['attentionSeconds'])}s of attention" if ex.get("attentionSeconds") else ""
        lines.append(f"[page {ex['page']}] DEPTH: {DEPTH_LABELS[ex['depth']]} ({tags}{attention}) — "
                     f"{DEPTH_TARGETS[ex['depth']]}\n{ex['text']}\n")

    # Weaker signals; each line names the exact "signal" value to use for it.
    signals = []
    for p in ctx["pageSignals"]:
        if p["revisits"]:
            signals.append(f"- page {p['page']} [signal: revisit]: returned to the page {p['revisits']} times")
        if p["dwellSeconds"] >= 20:
            signals.append(f"- page {p['page']} [signal: dwell]: ~{round(p['dwellSeconds'])}s of reading time on the page")
    lines.append("OTHER OBSERVATIONS (lower weight; use the bracketed signal value):")
    lines += signals or ["- none recorded"]

    if ctx["existingNotes"]:
        lines.append("\nREADER'S EXISTING NOTES (shared by the reader):")
        for n in ctx["existingNotes"]:
            where = f"page {n['page']}" if n.get("page") else "general"
            lines.append(f"- ({where}) {n['text']}")

    lines.append(f"\nTASK: {TASK_INSTRUCTIONS[ctx['task']]}")
    return "\n".join(lines)


def build_messages(ctx: dict) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": render_context(ctx)},
    ]


MIN_DEEP_WORDS = 90  # a "deep" section shorter than this gets one expansion request

_LIST_LINE = re.compile(r"^\s*(?:[-•*·]|\d+[.)])\s+")
_LABEL_LINE = re.compile(r"^\s*(?:key\s*points?|keypoints|önemli noktalar|anahtar noktalar|notes?)\s*:?\s*$", re.IGNORECASE)


def clean_prose(text: str) -> str:
    """Section "content" is plain prose: drop bullet/numbered lines and stray labels such as
    "keyPoints:" that models sometimes append, and tidy blank lines."""
    kept = [line for line in text.splitlines() if not _LIST_LINE.match(line) and not _LABEL_LINE.match(line)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def clean_note(note: dict) -> dict:
    for sec in note.get("sections", []):
        cleaned = clean_prose(sec.get("content", ""))
        if cleaned:
            sec["content"] = cleaned
    return note

EXPAND_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "properties": {"page": {"type": "integer", "minimum": 1}, "content": {"type": "string", "maxLength": 3000}},
                "required": ["page", "content"],
            },
        }
    },
    "required": ["sections"],
}


def short_deep_sections(ctx: dict, note: dict) -> list[dict]:
    """Sections on pages the reader focused on (depth "deep") that came back too short."""
    deep_pages = {e["page"] for e in ctx["excerpts"] if e.get("depth") == "deep"}
    return [s for s in note.get("sections", [])
            if s.get("page") in deep_pages and len(s.get("content", "").split()) < MIN_DEEP_WORDS]


def expand_messages(ctx: dict, sections: list[dict]) -> list[dict]:
    """One follow-up request: rewrite only the too-short deep sections at full depth."""
    listing = "\n".join(f"- page {s['page']} (\"{s.get('heading', '')}\"): {s.get('content', '')}" for s in sections)
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": render_context(ctx)},
        {"role": "user", "content": (
            "These sections are marked DEEP — the reader focused on them — but they are too short:\n"
            f"{listing}\n\n"
            "Rewrite the \"content\" of each one: 3-4 paragraphs of 2-3 sentences each, 120-180 words in total, "
            "paragraphs separated by a blank line, plain prose only — no lists, no key points, no labels. "
            "Use only that page's excerpt, start with its "
            "CRITICAL / HIGH passages, explain the concepts, studies, numbers and examples. Same language. "
            "Return JSON {\"sections\": [{\"page\": n, \"content\": \"...\"}]} for exactly these pages.")},
    ]


def repair_messages(ctx: dict, bad_output: str, errors: list[str]) -> list[dict]:
    """One controlled repair attempt after invalid JSON / schema errors."""
    problem = "; ".join(errors[:8]) or "output was not valid JSON"
    return build_messages(ctx) + [
        {"role": "assistant", "content": bad_output[:6000]},
        {"role": "user", "content": f"That answer was invalid ({problem}). Return only corrected JSON "
                                    "that matches the required schema. No commentary."},
    ]
