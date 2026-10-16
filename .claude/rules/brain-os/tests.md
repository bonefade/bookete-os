---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/__tests__/**"
  - "tests/**"
  - "test/**"
  - "e2e/**"
---
<!-- Synced from brain-os (plugins/brain-ai-factory/rules/). Only the paths: globs may be changed here; record that in .brain-manifest.md. -->

# Tests

- **Bug fixes start with a failing test.** Write the test that reproduces
  the bug, watch it fail, then fix. The test stays as the regression
  guard.
- **(class 2) Prove a test can fail.** Break the code, watch the test go red, then
  trust it. A wrong argument overload once made two suites assert
  nothing while staying green.
- **Test the write path directly.** A business rule test calls the
  committing function, bypassing the layer that offers choices.
- **Tests agree with bugs.** A test written by the same author as the
  code can share its blind spot. Derive expected values independently.
