# Tests

## Browser tests (`tests/index.html`)

Dependency-free tests for the frontend modules, run in a real browser so IndexedDB, `fetch` and scrolling are available:

1. Start the app server (see the main README).
2. Open http://127.0.0.1:8000/tests/

Covers:
- **Noise filtering:** stays under 1 s never reach page data; elapsed time measured exactly; fast scrolling ignored; idle cap (3 min without scrolling/selecting); hidden tab.
- **Signals:** selections tagged `CRITICAL_IMPORTANCE` with their paragraph; re-reads tagged `HIGH_RELEVANCE`; revisits; event schema; snapshot round-trips (old snapshots lose pointer-derived data).
- **Tracker (real DOM):** registers **no** mouse/pointer/wheel/hover listeners (only `scroll` and `selectionchange`); a re-read needs a ≥ 1 s stay; small scroll wobbles are ignored; fast scrolling is flagged; paragraph expansion of a selection.
- **Context:** selections and re-reads force `deep`, weights (selection > re-read > reading time), critical passages listed before high-relevance ones, unread pages left out, size limits, excerpt centring (Turkish-safe).
- **Validation & grounding:** schema (including rejected pointer signals), Turkish-aware quote matching, highlight labels downgraded when the behaviour wasn't observed, missing selections added as critical bullets, measured depth, reader-note checks, the demo note against the real Turkish sample PDF.
- **Storage & export:** IndexedDB notes and per-document deletion; one-time migration from the pre-rename `focusnote` database; Markdown export as one block (highlights → sub-headed summary of short paragraphs → sources).
- **UI:** the Summary accordion (open by default, `aria-expanded`/`inert` toggling, smooth grid-row transition, state kept across re-renders), short-paragraph splitting, and branding (PiCODE title and wordmark, no model-status pill, no leftover "FocusNote").

Tests use a throw-away IndexedDB database (`picode-test-…`) and never touch your real data.

## Backend tests (`backend/tests/`)

```bash
python -m unittest discover -s backend/tests -t .
```

Run from the project root with the virtual environment's Python. They use a fake model adapter, so no model or network is needed. Covers the v3 schema (highlights, no pointer signals), prompt order (CRITICAL_IMPORTANCE → HIGH_RELEVANCE → excerpts → weaker observations), validation/normalization, the one-shot JSON repair, error propagation, context limits and tag validation, remote-endpoint consent, Host/Origin protection, and that backend files and API keys are never served.
