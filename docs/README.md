# docs/

| Doc | Status | What it covers |
|---|---|---|
| [OCR.md](OCR.md) | **Current** | Pencilmark-mode pipeline (5 passes + post-processing), preprocessing order and why, PSM mode findings, rejected experiments, accuracy on the `tests/` corpus |
| [superpowers/specs/2026-05-13-pencilmark-ocr-design.md](superpowers/specs/2026-05-13-pencilmark-ocr-design.md) | Historical | Original pencilmark design. Proposed `PSM.SPARSE_TEXT` and a 40% bbox threshold; the code switched to `SINGLE_BLOCK` and 45%, and added passes 2–5 |
| [superpowers/plans/2026-05-13-pencilmark-ocr.md](superpowers/plans/2026-05-13-pencilmark-ocr.md) | Historical | Task-by-task implementation plan for that spec. Line numbers and snippets are stale |

Related:

- [`../CLAUDE.md`](../CLAUDE.md): commands, architecture, public API, gotchas, cross-repo contracts
- [`../plans/IMPROVEMENTS.md`](../plans/IMPROVEMENTS.md): prioritized improvement backlog
- `../tests/*_truth.txt`: ground truth for the accuracy corpus. There are 9 rows of 9 comma-separated
  tokens; each token is a digit, `0`, or `{a,b,...}` for pencilmarks. Score with
  `bun run tests/evaluate-truth.ts`.
