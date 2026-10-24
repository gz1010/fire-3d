# Brief 4 H5 fix (Forensic review fixes): progress

- 2026-10-24: started. Read BRIEF-4, PLAN-4 (all, §11), CONTRACT §15 (H2 and H5 as built), HANDOFF, H2 and H5
  reports. No earlier H5-fix attempt (no progress file, no uncommitted edits in Forensic files). Servers: API 8734,
  Vite 5194. Findings to handle: H5-DF-1..7, H5-B1, H5-M1, H5-m1..m4.
- Reproduced every finding (scratch h5fix/widths.mjs, layout.mjs, empty.mjs; screenshots at 360-1440 px). Also found at
  768-900 px: the view dock's scale off the left edge and the timeline's range tabs over the time (fixed with DF-1).
- Fixed: tablet/phone bar (view pill on a second row counted in the header's box), phone 44 px targets (::before hit
  areas; Hide panels to the second row), MiniBar specificity + shrinking name, no-fire fixed copy footer (+ test),
  pill lift to 1399 px, place/dates wrap + "Fire-3d" word hidden ≤ 1400 px, NOW beside the knob, weather sub line +
  foot separator, experimental tags in the Forensic forecast legend and Analysis tab.
- Checks: overlap scan clean at 25 sizes; MiniBar "Panels H" reachable and restoring at 320-1440 px; 44 px hit squares
  at 360/390/430 px; no-fire copy at 7 sizes. Gates green (lint 55, tests 1383 + 2 skipped). Screenshots
  brief4-h5-fix-*.png viewed. CONTRACT 15.5 "Review fixes" and reports/brief4-h5-fix.json written. Finished.
