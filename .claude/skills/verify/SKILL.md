---
name: verify
description: Run the full CI validation pipeline locally (lint, typecheck, build, test) to catch issues before pushing.
---

Run the full local validation pipeline matching CI order:

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

Report results clearly:
- If all steps pass, confirm success with a one-line summary.
- If any step fails, show the failure output and stop — do not continue to later steps.
