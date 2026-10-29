"""Backend tests (standard library unittest; no model required).

Run from the project root:
    .venv\\Scripts\\python -m unittest discover -s backend/tests -t .
"""

import json
import unittest

from fastapi.testclient import TestClient

from backend import app as app_module
from backend import prompts
from backend.model_adapter import ModelError, is_local_url

HOST = {"host": "127.0.0.1:8000"}


def context(task="note"):
    return {
        "task": task,
        "document": {"title": "Örnek", "pageCount": 3, "language": "tr"},
        "progress": {"currentPage": 2, "pagesVisited": 2, "percentVisited": 66.7, "totalReadingSeconds": 90},
        "excerpts": [
            {"page": 1, "text": "Aralıklı çalışma akılda tutmayı artırır.", "reasons": ["CRITICAL_IMPORTANCE"],
             "depth": "deep", "attentionSeconds": 180},
            {"page": 2, "text": "Kısa bir sayfa.", "reasons": [], "depth": "brief", "attentionSeconds": 0},
        ],
        "criticalPassages": [{"page": 1, "text": "akılda tutmayı artırır", "count": 2,
                              "block": "Aralıklı çalışma akılda tutmayı artırır.", "importance": "CRITICAL_IMPORTANCE"}],
        "highRelevancePassages": [],
        "pageSignals": [{"page": 1, "visits": 2, "revisits": 1, "dwellSeconds": 40}],
        "existingNotes": [],
    }


VALID_NOTE = {"studyNote": {
    "title": "Not", "overview": "Aralıklı çalışma hakkında.",
    "highlights": [{"text": "Aralıklı çalışma kalıcıdır.", "page": 1, "importance": "CRITICAL_IMPORTANCE",
                    "evidence": "Aralıklı çalışma akılda tutmayı artırır."}],
    "sections": [{"heading": "Aralıklama", "page": 1, "depth": "deep",
                  "content": "Aralıklı çalışma uzun süreli akılda tutmayı artırır. " * 20,   # long enough for "deep"
                  "keyPoints": ["a", "b"], "evidence": "Aralıklı çalışma akılda tutmayı artırır.",
                  "readerNote": "Bu cümleyi iki kez seçtiniz.", "signal": "selection"}],
    "reviewLater": [], "questions": [],
}}


def note_with_short_deep_section():
    note = json.loads(json.dumps(VALID_NOTE))
    note["studyNote"]["sections"][0]["content"] = "Kısa bir açıklama."
    return note


class FakeAdapter:
    """Replays canned outputs instead of calling a model."""

    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = 0

    async def stream_chat(self, messages, schema, max_tokens):
        self.calls += 1
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        for i in range(0, len(out), 7):
            yield out[i:i + 7]


def events(response):
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


class PromptTests(unittest.TestCase):
    def test_task_schema_is_a_single_study_note(self):
        s = prompts.task_schema("note")
        self.assertEqual(s["required"], ["studyNote"])
        note = s["properties"]["studyNote"]
        self.assertEqual(note["required"], ["title", "highlights", "overview", "sections", "reviewLater", "questions"])
        self.assertEqual(note["properties"]["sections"]["items"]["properties"]["depth"]["enum"], ["deep", "standard", "brief"])
        self.assertEqual(note["properties"]["highlights"]["items"]["properties"]["importance"]["enum"],
                         ["CRITICAL_IMPORTANCE", "HIGH_RELEVANCE", "KEY_POINT"])
        # No pointer-derived signals remain.
        signals = note["properties"]["sections"]["items"]["properties"]["signal"]["enum"]
        self.assertNotIn("cursor_region", signals)
        self.assertNotIn("active_reading", signals)

    def test_valid_note_passes(self):
        self.assertEqual(prompts.validate(VALID_NOTE, prompts.task_schema("note")), [])

    def test_validate_detects_missing_wrong_types_and_enums(self):
        s = prompts.task_schema("note")
        bad = {"studyNote": {"title": 3, "overview": "x", "reviewLater": [], "highlights": [],
                             "questions": [{"question": "q", "answer": "a", "page": 0, "evidence": "e"}],
                             "sections": [{"heading": "h", "page": "1", "depth": "huge", "content": "c",
                                           "keyPoints": [1], "evidence": "e", "readerNote": "", "signal": "mood"}]}}
        errs = prompts.validate(bad, s)
        for fragment in ("title: expected string", "page: expected integer", "depth: must be one of",
                         "keyPoints[0]: expected string", "signal: must be one of", "page: must be >= 1"):
            self.assertTrue(any(fragment in e for e in errs), fragment)
        self.assertTrue(prompts.validate({"studyNote": {}}, s))

    def test_normalize_truncates_and_drops_unknown(self):
        s = prompts.task_schema("note")
        note = json.loads(json.dumps(VALID_NOTE))
        note["extra"] = 1
        note["studyNote"]["sections"] *= 20
        out = prompts.normalize(note, s)
        self.assertNotIn("extra", out)
        self.assertEqual(len(out["studyNote"]["sections"]), 12)

    def test_render_context_marks_depth_language_and_observations(self):
        text = prompts.render_context(context())
        self.assertIn("WRITE THE NOTE IN: Turkish", text)
        self.assertIn("[page 1] DEPTH: DEEP (CRITICAL_IMPORTANCE, ~180s of attention) — write 3-4 paragraphs of 2-3 sentences each (120-180 words in total)", text)
        self.assertIn("[page 2] DEPTH: BRIEF (not read closely) — write one sentence", text)
        self.assertIn("[signal: revisit]: returned to the page 1 times", text)
        self.assertIn("lower weight", text)

    def test_critical_then_high_relevance_come_first(self):
        ctx = context()
        ctx["highRelevancePassages"] = [{"page": 1, "text": "Aralıklı çalışma", "count": 2, "relevance": "HIGH_RELEVANCE"}]
        text = prompts.render_context(ctx)
        critical = text.index("CRITICAL_IMPORTANCE — passages the reader SELECTED")
        selected = text.index('- page 1, selected 2 times: selected "akılda tutmayı artırır"')
        block = text.index('in the paragraph: "Aralıklı çalışma akılda tutmayı artırır."')
        high = text.index('HIGH_RELEVANCE — passages the reader RE-READ')
        high_line = text.index('- page 1 (2 times): "Aralıklı çalışma"')
        excerpts = text.index("EXCERPTS:")
        self.assertLess(critical, selected)
        self.assertLess(selected, block)
        self.assertLess(block, high)
        self.assertLess(high, high_line)
        self.assertLess(high_line, excerpts)
        for phrase in ("CRITICAL_IMPORTANCE", "HIGH_RELEVANCE", "KEY_POINT", "sub-heading", "HOW MANY paragraphs", "You are PiCODE"):
            self.assertIn(phrase, prompts.SYSTEM_PROMPT)

    def test_context_rejects_pointer_data_shapes(self):
        ctx = context()
        ctx["criticalPassages"][0]["importance"] = "LOW"
        r = TestClient(app_module.app).post("/api/analyze", json={"context": ctx}, headers=HOST)
        self.assertEqual(r.status_code, 422)

    def test_env_prefers_picode_and_accepts_legacy_names(self):
        import os
        keys = ("PICODE_MODEL", "FOCUSNOTE_MODEL")
        saved = {k: os.environ.pop(k, None) for k in keys}
        try:
            self.assertEqual(app_module.env("MODEL", "default"), "default")
            os.environ["FOCUSNOTE_MODEL"] = "legacy:tag"
            self.assertEqual(app_module.env("MODEL", "default"), "legacy:tag")
            os.environ["PICODE_MODEL"] = "new:tag"
            self.assertEqual(app_module.env("MODEL", "default"), "new:tag")
        finally:
            for k, v in saved.items():
                os.environ.pop(k, None)
                if v is not None:
                    os.environ[k] = v
        self.assertEqual(app_module.app.title, "PiCODE")

    def test_is_local_url(self):
        self.assertTrue(is_local_url("http://127.0.0.1:11434"))
        self.assertTrue(is_local_url("http://localhost:1234/v1"))
        self.assertTrue(is_local_url("http://[::1]:11434"))
        self.assertFalse(is_local_url("https://api.example.com"))
        self.assertFalse(is_local_url("http://192.168.1.20:11434"))


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app_module.app)
        self._orig_make = app_module.make_adapter
        self._orig_url = app_module.CONFIG.base_url
        app_module.CONFIG.base_url = "http://127.0.0.1:11434"

    def tearDown(self):
        app_module.make_adapter = self._orig_make
        app_module.CONFIG.base_url = self._orig_url

    def use(self, adapter):
        app_module.make_adapter = lambda cfg: adapter

    def post(self, body, **headers):
        return self.client.post("/api/analyze", json=body, headers={**HOST, **headers})

    def test_valid_result(self):
        fake = FakeAdapter([json.dumps(VALID_NOTE)])
        self.use(fake)
        evs = events(self.post({"context": context()}))
        result = evs[-1]
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["analysis"]["studyNote"]["sections"][0]["depth"], "deep")
        self.assertFalse(result["meta"]["repaired"])
        self.assertEqual(fake.calls, 1)

    def test_invalid_json_is_repaired_once(self):
        fake = FakeAdapter(['{"studyNote": {"title": "cut off', json.dumps(VALID_NOTE)])
        self.use(fake)
        evs = events(self.post({"context": context()}))
        self.assertTrue(any(e.get("phase") == "repairing" for e in evs))
        self.assertEqual(evs[-1]["type"], "result")
        self.assertTrue(evs[-1]["meta"]["repaired"])
        self.assertEqual(fake.calls, 2)

    def test_too_short_deep_section_is_expanded_once(self):
        long_text = "Geri çağırma belleği güçlendirir. " * 30
        fake = FakeAdapter([json.dumps(note_with_short_deep_section()),
                            json.dumps({"sections": [{"page": 1, "content": long_text}]})])
        self.use(fake)
        evs = events(self.post({"context": context()}))
        self.assertTrue(any(e.get("phase") == "expanding" and e.get("pages") == [1] for e in evs))
        result = evs[-1]
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["analysis"]["studyNote"]["sections"][0]["content"], long_text.strip())
        self.assertEqual(result["meta"]["expandedPages"], [1])
        self.assertEqual(fake.calls, 2)

    def test_section_prose_is_cleaned_of_lists_and_labels(self):
        text = "Birinci paragraf.\n\nİkinci paragraf.\n\nkeyPoints: \n- madde bir\n- madde iki\n1. numaralı"
        self.assertEqual(prompts.clean_prose(text), "Birinci paragraf.\n\nİkinci paragraf.")
        self.assertEqual(prompts.clean_prose("Önemli noktalar:\n• x"), "")
        long_text = "Geri çağırma belleği güçlendirir. " * 30
        fake = FakeAdapter([json.dumps(note_with_short_deep_section()),
                            json.dumps({"sections": [{"page": 1, "content": long_text + "\n\nkeyPoints:\n- leaked"}]})])
        self.use(fake)
        content = events(self.post({"context": context()}))[-1]["analysis"]["studyNote"]["sections"][0]["content"]
        self.assertNotIn("keyPoints", content)
        self.assertNotIn("leaked", content)

    def test_failed_expansion_keeps_the_original_note(self):
        fake = FakeAdapter([json.dumps(note_with_short_deep_section()), "not json"])
        self.use(fake)
        result = events(self.post({"context": context()}))[-1]
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["analysis"]["studyNote"]["sections"][0]["content"], "Kısa bir açıklama.")
        self.assertEqual(result["meta"]["expandedPages"], [])

    def test_brief_sections_are_never_expanded(self):
        note = note_with_short_deep_section()
        note["studyNote"]["sections"][0]["page"] = 2   # page 2 is "brief" in the context
        fake = FakeAdapter([json.dumps(note)])
        self.use(fake)
        self.assertEqual(events(self.post({"context": context()}))[-1]["type"], "result")
        self.assertEqual(fake.calls, 1)

    def test_gives_up_after_one_repair(self):
        fake = FakeAdapter(["not json", '{"studyNote": {"title": 1}}'])
        self.use(fake)
        evs = events(self.post({"context": context()}))
        self.assertEqual(evs[-1]["type"], "error")
        self.assertEqual(evs[-1]["code"], "invalid_response")
        self.assertEqual(fake.calls, 2)

    def test_model_errors_are_reported(self):
        self.use(FakeAdapter([ModelError("timeout", "too slow")]))
        evs = events(self.post({"context": context()}))
        self.assertEqual(evs[-1], {"type": "error", "code": "timeout", "message": "too slow"})

    def test_context_limits_enforced(self):
        ctx = context()
        ctx["excerpts"][0]["text"] = "x" * 5000
        self.assertEqual(self.post({"context": ctx}).status_code, 422)

    def test_remote_endpoint_requires_confirmation(self):
        self.use(FakeAdapter([json.dumps(VALID_NOTE)]))
        app_module.CONFIG.base_url = "https://inference.example.com"
        r = self.post({"context": context()})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["error"], "remote_not_confirmed")
        r = self.post({"context": context(), "allowRemote": True})
        self.assertEqual(r.status_code, 200)

    def test_cross_origin_and_foreign_host_rejected(self):
        r = self.post({"context": context()}, origin="https://evil.example")
        self.assertEqual(r.status_code, 403)
        r = self.client.get("/api/config", headers={"host": "attacker.example"})
        self.assertEqual(r.status_code, 403)

    def test_config_never_exposes_api_key(self):
        app_module.CONFIG.api_key = "secret-test-key"
        try:
            body = self.client.get("/api/config", headers=HOST).text
            self.assertNotIn("secret-test-key", body)
        finally:
            app_module.CONFIG.api_key = ""

    def test_backend_source_not_served(self):
        self.assertEqual(self.client.get("/backend/app.py", headers=HOST).status_code, 404)
        self.assertEqual(self.client.get("/.venv/pyvenv.cfg", headers=HOST).status_code, 404)
        self.assertEqual(self.client.get("/", headers=HOST).status_code, 200)


if __name__ == "__main__":
    unittest.main()
