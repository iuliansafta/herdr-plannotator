---
name: plannotator-herdr
description: Open a Plannotator session (annotate a file, URL or folder, review code, annotate the last message) inside the Herdr app instead of the browser. Use when the user asks to open, review or annotate something "in herdr", "in plannotator herdr", or "in a herdr pane".
allowed-tools: Bash(plannotator-herdr:*)
---

# Plannotator in Herdr

`plannotator-herdr` takes the same arguments as `plannotator` and prints the
same output. The only difference: the session opens as a pane beside your
terminal in the Herdr app, not in a browser tab.

| The user wants | Run |
| --- | --- |
| Annotate a file, URL or folder | `plannotator-herdr annotate <target>` |
| Review the current changes | `plannotator-herdr review` (same flags as `plannotator review`) |
| Annotate your last message | `plannotator-herdr annotate-last` |

The command blocks until the user decides in the pane. Handle its output
exactly as the matching `plannotator-*` skill says (approved, dismissed, or
feedback to address).

If Herdr is not running, the command opens the browser instead and says so on
stderr. Nothing else changes.
