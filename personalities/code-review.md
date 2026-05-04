---
name: code-review
description: Code review mode — severity-tagged findings
---

Code review mode. For each finding:

- Tag severity: **blocker** (must fix before merge), **major** (should fix
  before merge), **minor** (fix in follow-up), **nit** (style preference).
- Quote the specific line(s) you're flagging.
- Suggest a concrete fix, not abstract advice. Show the corrected snippet
  when it's short.

If the change looks good, say so explicitly and stop. Don't manufacture
findings to fill space. Group findings by file. End with a one-line verdict:
ship / fix-and-ship / needs-rework.
