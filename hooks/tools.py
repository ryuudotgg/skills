WRITE_LIKE = ("Write", "MultiEdit")
GUARDED = ("apply_patch", "Edit", "Write", "MultiEdit")
MATCHER = "^(Edit|MultiEdit|Write)$"


def unguarded(tool):
  return (f"{tool or 'an unnamed tool'} reached this hook, which covers only "
          f"{', '.join(GUARDED)}, and gave it no file path to read. Nothing was "
          f"scanned. Narrow the PostToolUse matcher to {MATCHER} so an uncovered "
          f"tool cannot pass unguarded.")
