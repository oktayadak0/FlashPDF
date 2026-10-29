# Contributing to PiCODE

Thanks for helping! PiCODE is intentionally small: vanilla HTML/CSS/JS in the browser, a minimal FastAPI backend, no build step.

## Setup

Follow the [Quick start](README.md#quick-start). You don't need a GPU to contribute: everything except live analysis works in **demo mode**, and the backend tests use a fake model.

## Before opening a pull request

- Run the backend tests: `python -m unittest discover -s backend/tests -t .` (from the project root, using the venv's Python).
- Open `http://127.0.0.1:8000/tests/` and make sure every browser test passes.
- Try the demo flow from the README once in the app.
- Keep PRs focused; describe *what* and *why*, and add a screenshot for UI changes.

## Conventions

- **No frameworks or bundlers** in the frontend. Native browser APIs first. New runtime dependencies need a clear reason in the PR.
- **Untrusted text is text.** Model output and PDF content must be inserted with `textContent` / the `h()` helper in `js/dom.js` — never `innerHTML`.
- **Privacy is a feature.** Don't add network requests to third parties, analytics, or new kinds of tracked data. Any new signal must be aggregated, disclosed in the consent dialog, the Privacy dialog and the README, and covered by pause/clear/delete.
- **Signals are observations.** Don't write UI copy or prompts that claim a reader was confused, interested, etc.
- **Grounding stays mandatory.** Anything the model says about the document must pass `validateAndGround()` before it is rendered.
- **Schema changes** go in `schema/analysis.schema.json` (shared by backend and frontend); update the README and tests with them.
- Keep modules single-purpose; pure logic (aggregation, context building, validation) must stay free of DOM access so it remains testable.

## Good first issues

Each of these is self-contained. Comment on (or open) an issue before starting so work isn't duplicated.

1. **Add real screenshots to the README.** Replace the screenshot placeholder with `docs/screenshot-desktop.png` and `docs/screenshot-session.png` taken from the demo flow (light theme).
2. **Keyboard shortcut overlay.** Show the shortcuts from the Help dialog when pressing `?` in the viewer (`js/app.js`).
3. **Remember zoom per document.** Store the last zoom level with the document record in IndexedDB (`js/local-storage.js`, `js/pdf-reader.js`) and restore it on open.
4. **Search result list.** Below the search box, list matches with a short snippet and page number; clicking jumps to the match (`PdfReader#search` already returns page + occurrence).
5. **Export a single session as JSON.** Add a button in the Session tab that downloads the aggregated session (`ReadingAggregator#toJSON`) for the user's own records.
6. **Precise highlights.** Highlight only the matched characters instead of whole text-layer spans (wrap the matched range in `<mark>` inside the span) in `PdfReader#_applyHighlight`.
7. **Test: context builder edge cases.** Add browser tests for empty documents, documents with fewer pages than `LIMITS.maxExcerpts`, and selections spanning pages (`tests/run-tests.js`).
8. **Backend test for the OpenAI-compatible adapter.** Mock `/v1/models` and a streamed `/v1/chat/completions` response with `httpx.MockTransport` and check `status()` and `stream_chat()` (`backend/model_adapter.py`).
9. **Translate the UI strings to Turkish.** Extract user-facing strings into a small dictionary module and add a language switch; keep English as default.
10. **Reduced-motion audit.** Make sure every animation/transition respects `prefers-reduced-motion` and document it.

## Reporting bugs

Include the browser and OS, the runtime and model (`Model` dialog → *Test connection* shows it), steps to reproduce, and — if relevant — the browser console output. **Do not attach private PDFs**; reproduce with the sample or a public-domain document.
