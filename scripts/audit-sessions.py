#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, NamedTuple


PLANS_DO = re.compile(
  r"/plans\s+do\b|plans</command-name>\s*<command-args>\s*do\b")
CODEX_ARM = re.compile(
    r"""(?<![\w/-])codex(?:\s+-[-\w]+(?:=(?:"[^"]*"|'[^']*'|\S*)|\s+(?:"[^"]*"|'[^']*'|\S+))?)*\s+(?:exec|review)\b"""
)
BACKGROUND_TASK = re.compile(r"Command running in background with ID: (\w+)")
NOTIFIED_TASK = re.compile(r"<task-id>(\w+)</task-id>")
NOTIFIED_TOOL_USE = re.compile(r"<tool-use-id>([^<]+)</tool-use-id>")
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
SPAWN_TOOLS = {"Agent", "Task"}
REVIEW_ONLY_AGENTS = {"codex-reviewer", "comment-sicko", "Explore", "Plan"}
IMPLEMENTING_BRIEF = re.compile(r"[Ii]mplement")
WINDOW_MIN_MINUTES = 5.0
WINDOW_MAX_MINUTES = 120.0
RESUMED_ROLLOUT_MINUTES = 720.0
EFFORTS = ("XS", "S", "M", "L", "unknown")
HISTOGRAM_BINS = (
    ("<10m", 10.0),
    ("10-20m", 20.0),
    ("20-30m", 30.0),
    ("30-45m", 45.0),
    ("45-60m", 60.0),
    ("60-120m", 120.0),
    (">120m", math.inf),
)
READ_NOTES: dict[str, list[str]] = {"tasks": [], "windows": [], "codex": []}


class Task(NamedTuple):
  project: str
  task_id: str
  effort: str
  started_at: datetime
  ended_at: datetime


class TranscriptEvent(NamedTuple):
  timestamp: datetime
  event_type: str
  text: str
  blocks: tuple[dict[str, Any], ...]
  model: str | None
  usage: dict[str, Any] | None
  is_meta: bool


class Window(NamedTuple):
  prompt: str
  events: tuple[TranscriptEvent, ...]


class Subagent(NamedTuple):
  agent_type: str
  started_at: datetime
  ended_at: datetime
  assistant_messages: int


class CodexRun(NamedTuple):
  model: str
  effort: str
  started_at: datetime
  ended_at: datetime
  originator: str


def note(section: str, message: str) -> None:
  if message not in READ_NOTES[section]:
    READ_NOTES[section].append(message)


def parse_timestamp(value: object) -> datetime | None:
  if not isinstance(value, str):
    return None

  try:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
  except ValueError:
    return None

  if parsed.tzinfo is None:
    return parsed.replace(tzinfo=timezone.utc)

  return parsed.astimezone(timezone.utc)


def iso_timestamp(value: datetime) -> str:
  return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def percentile(sorted_values: list[float], probability: float) -> float | None:
  if not sorted_values:
    return None

  index = math.ceil(probability * len(sorted_values)) - 1
  index = max(0, min(index, len(sorted_values) - 1))
  return sorted_values[index]


def histogram(values: list[float]) -> dict[str, int]:
  counts = {label: 0 for label, _ in HISTOGRAM_BINS}

  for value in values:
    for label, upper_bound in HISTOGRAM_BINS:
      if value < upper_bound:
        counts[label] += 1
        break

  return counts


def records_from_file(path: Path, section: str) -> list[dict[str, Any]]:
  records: list[dict[str, Any]] = []

  try:
    with path.open("r", encoding="utf-8") as handle:
      for line in handle:
        try:
          record = json.loads(line)
        except (json.JSONDecodeError, TypeError, ValueError):
          continue

        if isinstance(record, dict):
          records.append(record)
  except (OSError, UnicodeError):
    note(section, f"{path} is unavailable")

  return records


def effort_index(plans_dir: Path) -> dict[tuple[str, str], str]:
  efforts: dict[tuple[str, str], str] = {}

  try:
    projects = list(plans_dir.iterdir())
  except OSError:
    note("tasks", f"{plans_dir} is unavailable")
    return efforts

  for project in projects:
    if not project.is_dir():
      continue

    index_path = project / "index.tsv"
    if not index_path.is_file():
      continue

    try:
      with index_path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
          task_id = row.get("id")
          effort = row.get("effort")
          if not isinstance(task_id, str) or not isinstance(effort, str):
            continue

          efforts[(project.name.casefold(), task_id)] = effort
    except (OSError, UnicodeError, csv.Error):
      note("tasks", f"{index_path} is unavailable")

  return efforts


def read_tasks(plans_dir: Path, cutoff: datetime) -> list[Task]:
  efforts = effort_index(plans_dir)
  log_path = plans_dir / "log.tsv"
  opened: dict[tuple[str, str], datetime] = {}
  tasks: list[Task] = []

  try:
    with log_path.open("r", encoding="utf-8", newline="") as handle:
      rows = list(csv.DictReader(handle, delimiter="\t"))
  except (OSError, UnicodeError, csv.Error):
    note("tasks", f"{log_path} is unavailable")
    return tasks

  for row in rows:
    timestamp = parse_timestamp(row.get("ts"))
    project = row.get("project")
    task_id = row.get("id")
    event = row.get("event")
    if timestamp is None or not isinstance(project, str) or not isinstance(task_id, str):
      continue

    key = (project.casefold(), task_id)
    if event == "start":
      opened[key] = timestamp
      continue

    if event not in {"handback", "handoff", "handover", "done"}:
      continue

    started_at = opened.pop(key, None)
    if started_at is None or started_at < cutoff:
      continue

    effort = efforts.get(key, "unknown")
    if effort not in EFFORTS:
      effort = "unknown"

    tasks.append(Task(project, task_id, effort, started_at, timestamp))

  return tasks


def extracted_text(content: object) -> str:
  if isinstance(content, str):
    return content

  if not isinstance(content, list):
    return ""

  texts: list[str] = []
  for block in content:
    if not isinstance(block, dict) or block.get("type") != "text":
      continue

    text = block.get("text")
    if isinstance(text, str):
      texts.append(text)

  return "".join(texts)


def transcript_event(record: dict[str, Any]) -> TranscriptEvent | None:
  timestamp = parse_timestamp(record.get("timestamp"))
  event_type = record.get("type")
  message = record.get("message")
  if timestamp is None or event_type not in {"user", "assistant", "system"}:
    return None
  if not isinstance(message, dict):
    return None

  content = message.get("content")
  blocks: list[dict[str, Any]] = []
  if isinstance(content, list):
    for block in content:
      if isinstance(block, dict):
        blocks.append(block)

  model = message.get("model")
  if not isinstance(model, str):
    model = None

  usage = message.get("usage")
  if not isinstance(usage, dict):
    usage = None

  return TranscriptEvent(
      timestamp, event_type, extracted_text(content), tuple(
        blocks), model, usage, bool(record.get("isMeta"))
  )


def is_human_prompt(event: TranscriptEvent) -> bool:
  if event.event_type != "user" or event.is_meta or not event.text.strip():
    return False

  return "task-notification" not in event.text


def is_plans_do(prompt: str) -> bool:
  return PLANS_DO.search(prompt) is not None


def merged_seconds(intervals: list[tuple[datetime, datetime]]) -> float:
  if not intervals:
    return 0.0

  ordered = sorted(intervals)
  total = 0.0
  current_start, current_end = ordered[0]

  for start, end in ordered[1:]:
    if start > current_end:
      total += (current_end - current_start).total_seconds()
      current_start, current_end = start, end
      continue

    current_end = max(current_end, end)

  return total + (current_end - current_start).total_seconds()


def recent_files(pattern: str, root: Path, cutoff: datetime, section: str) -> list[Path]:
  if not root.is_dir():
    note(section, f"{root} is unavailable")
    return []

  paths: list[Path] = []
  for name in glob.glob(pattern):
    path = Path(name)
    try:
      modified_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    except (OSError, OverflowError, ValueError):
      note(section, f"{path} is unavailable")
      continue

    if modified_at >= cutoff:
      paths.append(path)

  return paths


def windows_from_events(events: list[TranscriptEvent]) -> list[Window]:
  windows: list[Window] = []
  current: list[TranscriptEvent] = []

  for event in sorted(events, key=lambda item: item.timestamp):
    if is_human_prompt(event):
      if current:
        windows.append(Window(current[0].text, tuple(current)))
      current = [event]
      continue

    if current:
      current.append(event)

  if current:
    windows.append(Window(current[0].text, tuple(current)))

  return [window for window in windows if len(window.events) > 3 and is_plans_do(window.prompt)]


def subagent_from_records(records: list[dict[str, Any]]) -> Subagent | None:
  timestamps: list[datetime] = []
  agent_type = "unknown"
  assistant_messages = 0

  for record in records:
    timestamp = parse_timestamp(record.get("timestamp"))
    if timestamp is not None:
      timestamps.append(timestamp)

    candidate = record.get("attributionAgent") or record.get("agentType")
    if isinstance(candidate, str) and candidate:
      agent_type = candidate

    if record.get("type") == "assistant":
      assistant_messages += 1

  if not timestamps:
    return None

  return Subagent(agent_type, min(timestamps), max(timestamps), assistant_messages)


def read_windows(cutoff: datetime) -> tuple[list[Window], list[Subagent]]:
  root = Path.home() / ".claude" / "projects"
  main_pattern = str(root / "*" / "*.jsonl")
  subagent_pattern = str(root / "*" / "*" / "subagents" / "*.jsonl")
  windows: list[Window] = []
  subagents: list[Subagent] = []

  for path in recent_files(main_pattern, root, cutoff, "windows"):
    events = [event for record in records_from_file(
      path, "windows") if (event := transcript_event(record))]
    windows.extend(w for w in windows_from_events(
      events) if w.events[0].timestamp >= cutoff)

  for path in recent_files(subagent_pattern, root, cutoff, "windows"):
    subagent = subagent_from_records(records_from_file(path, "windows"))
    if subagent is not None and subagent.started_at >= cutoff:
      subagents.append(subagent)

  return windows, subagents


def setting(values: set[str]) -> str:
  if not values:
    return "unknown"
  if len(values) > 1:
    return "mixed"

  return next(iter(values))


def read_codex_runs(cutoff: datetime) -> list[CodexRun]:
  root = Path.home() / ".codex" / "sessions"
  pattern = str(root / "*" / "*" / "*" / "rollout-*.jsonl")
  runs: list[CodexRun] = []
  mixed = 0

  for path in recent_files(pattern, root, cutoff, "codex"):
    timestamps: list[datetime] = []
    models: set[str] = set()
    efforts: set[str] = set()
    originator = "unknown"

    for record in records_from_file(path, "codex"):
      timestamp = parse_timestamp(record.get("timestamp"))
      if timestamp is not None:
        timestamps.append(timestamp)

      payload = record.get("payload")
      if not isinstance(payload, dict):
        continue

      if record.get("type") == "turn_context":
        candidate_model = payload.get("model")
        candidate_effort = payload.get("effort")
        collaboration_mode = payload.get("collaboration_mode")
        if (not isinstance(candidate_effort, str) or not candidate_effort) and isinstance(
            collaboration_mode, dict
        ):
          settings = collaboration_mode.get("settings")
          if isinstance(settings, dict):
            candidate_effort = settings.get("reasoning_effort")

        if isinstance(candidate_model, str) and candidate_model:
          models.add(candidate_model)
        if isinstance(candidate_effort, str) and candidate_effort:
          efforts.add(candidate_effort)

      if record.get("type") == "session_meta":
        candidate_originator = payload.get("originator")
        if isinstance(candidate_originator, str) and candidate_originator:
          originator = candidate_originator

    if not timestamps or min(timestamps) < cutoff:
      continue

    if len(models) > 1 or len(efforts) > 1:
      mixed += 1

    runs.append(
        CodexRun(setting(models), setting(efforts), min(
          timestamps), max(timestamps), originator)
    )

  if mixed:
    note(
      "codex", f"{mixed} rollout(s) changed model or effort mid run and are grouped as mixed")

  return runs


def summarize_tasks(tasks: list[Task]) -> dict[str, Any]:
  durations = sorted(
    (task.ended_at - task.started_at).total_seconds() / 60 for task in tasks)
  by_effort: dict[str, list[float]] = {effort: [] for effort in EFFORTS}

  for task in tasks:
    duration = (task.ended_at - task.started_at).total_seconds() / 60
    by_effort[task.effort].append(duration)

  effort_summary: dict[str, dict[str, int | float | None]] = {}
  for effort in EFFORTS:
    values = sorted(by_effort[effort])
    median = percentile(values, 0.5)
    if median is not None:
      median = round(median, 2)
    effort_summary[effort] = {"n": len(values), "median_minutes": median}

  median = percentile(durations, 0.5)
  p75 = percentile(durations, 0.75)
  if median is not None:
    median = round(median, 2)
  if p75 is not None:
    p75 = round(p75, 2)

  return {
      "n": len(tasks),
      "median_minutes": median,
      "p75_minutes": p75,
      "histogram": histogram(durations),
      "by_effort": effort_summary,
  }


def tool_name(block: dict[str, Any]) -> str:
  name = block.get("name")
  if not isinstance(name, str):
    return "unknown"

  if name.startswith("mcp__"):
    return name.rsplit("__", 1)[-1]

  return name


def is_edit(block: dict[str, Any]) -> bool:
  if block.get("type") != "tool_use":
    return False

  name = tool_name(block)
  if name in EDIT_TOOLS:
    return True

  tool_input = block.get("input")
  if not isinstance(tool_input, dict):
    return False

  try:
    encoded_input = json.dumps(tool_input, sort_keys=True)
  except (TypeError, ValueError):
    return False

  if "workspace-write" in encoded_input:
    return True

  if name not in SPAWN_TOOLS or tool_input.get("subagent_type") in REVIEW_ONLY_AGENTS:
    return False

  return IMPLEMENTING_BRIEF.search(encoded_input) is not None


def window_metrics(window: Window) -> dict[str, float | None]:
  events = window.events
  t0 = events[0].timestamp
  t_end = events[-1].timestamp
  active_s = 0.0
  model_s = 0.0
  subagent_wait_s = 0.0
  codex_wait_intervals: list[tuple[datetime, datetime]] = []
  tool_intervals: defaultdict[str,
                              list[tuple[datetime, datetime]]] = defaultdict(list)
  tool_starts: dict[str, tuple[str, datetime]] = {}
  codex_arm_tool_use_ids: set[str] = set()
  codex_background_task_ids: set[str] = set()
  task_output_starts: dict[str, tuple[str, datetime]] = {}
  first_edit: datetime | None = None
  last_edit: datetime | None = None
  last_tool_result: datetime | None = None

  for index, event in enumerate(events):
    if index:
      gap = (event.timestamp - events[index - 1].timestamp).total_seconds()
      if 0 < gap <= 600:
        active_s += gap
      if event.event_type == "user" and "task-notification" in event.text and gap > 0:
        notified_task = NOTIFIED_TASK.search(event.text)
        notified_tool_use = NOTIFIED_TOOL_USE.search(event.text)
        if (notified_task is not None and notified_task.group(1) in codex_background_task_ids) or (
            notified_tool_use is not None and notified_tool_use.group(
              1) in codex_arm_tool_use_ids
        ):
          codex_wait_intervals.append(
            (events[index - 1].timestamp, event.timestamp))
        else:
          subagent_wait_s += gap

    if event.event_type == "assistant" and last_tool_result is not None:
      gap = (event.timestamp - last_tool_result).total_seconds()
      if 0 < gap < 1800:
        model_s += gap
      last_tool_result = None

    for block in event.blocks:
      if is_edit(block):
        if first_edit is None:
          first_edit = event.timestamp
        last_edit = event.timestamp

      if block.get("type") == "tool_use":
        tool_use_id = block.get("id")
        if isinstance(tool_use_id, str):
          tool_starts[tool_use_id] = (tool_name(block), event.timestamp)

          tool_input = block.get("input")
          if tool_name(block) == "Bash" and isinstance(tool_input, dict):
            command = tool_input.get("command")
            if isinstance(command, str) and CODEX_ARM.search(command) is not None:
              codex_arm_tool_use_ids.add(tool_use_id)

          if tool_name(block) == "TaskOutput" and isinstance(tool_input, dict):
            task_id = tool_input.get("task_id")
            if isinstance(task_id, str) and task_id in codex_background_task_ids:
              task_output_starts[tool_use_id] = (task_id, event.timestamp)

      if block.get("type") == "tool_result":
        tool_use_id = block.get("tool_use_id")
        if isinstance(tool_use_id, str):
          if tool_use_id in codex_arm_tool_use_ids:
            background_task = BACKGROUND_TASK.search(
              extracted_text(block.get("content")))
            if background_task is not None:
              codex_background_task_ids.add(background_task.group(1))

          task_output_start = task_output_starts.pop(tool_use_id, None)
          if task_output_start is not None and event.timestamp > task_output_start[1]:
            codex_wait_intervals.append((task_output_start[1], event.timestamp))

          tool_start = tool_starts.pop(tool_use_id, None)
          if tool_start is not None:
            name, started_at = tool_start
            if event.timestamp > started_at:
              tool_intervals[name].append((started_at, event.timestamp))
        last_tool_result = event.timestamp

  to_first_edit_s: float | None = None
  tail_s: float | None = None
  if first_edit is not None and last_edit is not None:
    to_first_edit_s = (first_edit - t0).total_seconds()
    tail_s = (t_end - last_edit).total_seconds()

  return {
      "duration_s": max(0.0, (t_end - t0).total_seconds()),
      "active_s": active_s,
      "to_first_edit_s": to_first_edit_s,
      "tail_s": tail_s,
      "model_s": model_s,
      "bash_s": merged_seconds(tool_intervals["Bash"]),
      "question_s": merged_seconds(tool_intervals["AskUserQuestion"]),
      "subagent_wait_s": subagent_wait_s,
      "codex_wait_s": merged_seconds(codex_wait_intervals),
  }


def summarize_windows(windows: list[Window], subagents: list[Subagent]) -> dict[str, Any]:
  metrics = [window_metrics(window) for window in windows]
  kept = [
      metric
      for metric in metrics
      if WINDOW_MIN_MINUTES <= float(metric["duration_s"]) / 60 <= WINDOW_MAX_MINUTES
  ]
  durations = sorted(float(metric["duration_s"]) / 60 for metric in kept)
  first_edits = sorted(
      float(metric["to_first_edit_s"])
      for metric in kept
      if metric["to_first_edit_s"] is not None
  )
  tails = sorted(float(metric["tail_s"])
                 for metric in kept if metric["tail_s"] is not None)
  total_duration = sum(float(metric["duration_s"]) for metric in kept)
  subagent_walls: list[float] = []
  subagents_by_type: defaultdict[str, list[float]] = defaultdict(list)

  for subagent in subagents:
    wall_s = max(0.0, (subagent.ended_at - subagent.started_at).total_seconds())
    subagent_walls.append(wall_s)
    subagents_by_type[subagent.agent_type].append(wall_s / 60)

  subagent_breakdown: list[dict[str, int | str | float | None]] = []
  for agent_type, values in subagents_by_type.items():
    median = percentile(sorted(values), 0.5)
    if median is not None:
      median = round(median, 2)
    subagent_breakdown.append(
        {"agent_type": agent_type, "n": len(
          values), "median_wall_minutes": median}
    )

  subagent_breakdown.sort(
    key=lambda row: (-int(row["n"]), str(row["agent_type"])))

  def rounded_stat(values: list[float], probability: float) -> float | None:
    value = percentile(values, probability)
    if value is None:
      return None
    return round(value, 2)

  def pooled_share(field: str) -> float:
    if not total_duration:
      return 0.0
    return round(100 * sum(float(metric[field]) for metric in kept) / total_duration, 2)

  return {
      "found": len(windows),
      "kept": len(kept),
      "median_duration_minutes": rounded_stat(durations, 0.5),
      "p75_duration_minutes": rounded_stat(durations, 0.75),
      "median_to_first_edit_seconds": rounded_stat(first_edits, 0.5),
      "median_tail_seconds": rounded_stat(tails, 0.5),
      "p75_tail_seconds": rounded_stat(tails, 0.75),
      "no_edit": sum(1 for metric in kept if metric["to_first_edit_s"] is None),
      "shares_percent": {
          "model_round_trips": pooled_share("model_s"),
          "bash": pooled_share("bash_s"),
          "subagent_wait": pooled_share("subagent_wait_s"),
          "codex_wait": pooled_share("codex_wait_s"),
          "questions": pooled_share("question_s"),
      },
      "subagents": {
          "n": len(subagents),
          "total_wall_hours": round(sum(subagent_walls) / 3600, 2),
          "by_agent_type": subagent_breakdown,
      },
  }


def summarize_codex_runs(runs: list[CodexRun]) -> dict[str, Any]:
  groups: defaultdict[tuple[str, str], list[float]] = defaultdict(list)
  by_originator: defaultdict[tuple[str, str, str],
                             list[float]] = defaultdict(list)
  resumed = 0

  for run in runs:
    wall_minutes = max(
      0.0, (run.ended_at - run.started_at).total_seconds() / 60)
    if wall_minutes > RESUMED_ROLLOUT_MINUTES:
      resumed += 1
      continue

    groups[(run.model, run.effort)].append(wall_minutes)
    by_originator[(run.originator, run.model, run.effort)].append(wall_minutes)

  if resumed:
    note("codex", f"{resumed} rollout(s) spanning over {RESUMED_ROLLOUT_MINUTES / 60:.0f}h treated as resumed and excluded")

  def wall_summary(values: list[float]) -> tuple[int, float | None, float | None]:
    sorted_values = sorted(values)
    median = percentile(sorted_values, 0.5)
    p75 = percentile(sorted_values, 0.75)
    if median is not None:
      median = round(median, 2)
    if p75 is not None:
      p75 = round(p75, 2)
    return len(values), median, p75

  summary_groups: list[dict[str, int | str | float | None]] = []
  for (model, effort), values in groups.items():
    n, median, p75 = wall_summary(values)
    summary_groups.append(
        {
            "model": model,
            "effort": effort,
            "n": n,
            "median_wall_minutes": median,
            "p75_wall_minutes": p75,
        }
    )

  summary_groups.sort(
    key=lambda row: (-int(row["n"]), str(row["model"]), str(row["effort"])))
  originator_groups: list[dict[str, int | str | float | None]] = []
  for (originator, model, effort), values in by_originator.items():
    n, median, p75 = wall_summary(values)
    originator_groups.append(
        {
            "originator": originator,
            "model": model,
            "effort": effort,
            "n": n,
            "median_wall_minutes": median,
            "p75_wall_minutes": p75,
        }
    )

  originator_groups.sort(
      key=lambda row: (-int(row["n"]), str(row["originator"]),
                       str(row["model"]), str(row["effort"]))
  )
  return {
      "n": len(runs),
      "resumed_excluded": resumed,
      "groups": summary_groups,
      "by_originator": originator_groups,
  }


def display(value: object) -> str:
  if value is None:
    return "n/a"
  if isinstance(value, float):
    return f"{value:.2f}"
  return str(value)


def text_table(headers: tuple[str, ...], rows: list[tuple[object, ...]]) -> str:
  rendered_rows = [tuple(display(value) for value in row) for row in rows]
  widths = [len(header) for header in headers]
  for row in rendered_rows:
    for index, value in enumerate(row):
      widths[index] = max(widths[index], len(value))

  lines = ["  ".join(header.ljust(widths[index])
                     for index, header in enumerate(headers))]
  lines.extend("  ".join(value.ljust(
    widths[index]) for index, value in enumerate(row)) for row in rendered_rows)
  return "\n".join(lines)


def render(result: dict[str, Any]) -> str:
  tasks = result["tasks"]
  windows = result["windows"]
  codex = result["codex"]
  task_effort_rows = [
      (effort, values["n"], values["median_minutes"])
      for effort, values in tasks["by_effort"].items()
  ]
  task_histogram_rows = list(tasks["histogram"].items())
  phase_rows = [
      (
          windows["found"],
          windows["kept"],
          windows["median_duration_minutes"],
          windows["p75_duration_minutes"],
          windows["median_to_first_edit_seconds"],
          windows["median_tail_seconds"],
          windows["p75_tail_seconds"],
          windows["no_edit"],
      )
  ]
  share_rows = [
      ("model round trips", windows["shares_percent"]["model_round_trips"]),
      ("Bash", windows["shares_percent"]["bash"]),
      ("waiting on subagents", windows["shares_percent"]["subagent_wait"]),
      ("waiting on Codex arms", windows["shares_percent"]["codex_wait"]),
      ("questions", windows["shares_percent"]["questions"]),
  ]
  subagents = windows["subagents"]
  subagent_rows = [
      (row["agent_type"], row["n"], row["median_wall_minutes"])
      for row in subagents["by_agent_type"]
  ]
  codex_rows = [
      (row["model"], row["effort"], row["n"],
       row["median_wall_minutes"], row["p75_wall_minutes"])
      for row in codex["groups"]
  ]
  codex_originator_rows = [
      (
          row["originator"],
          row["model"],
          row["effort"],
          row["n"],
          row["median_wall_minutes"],
          row["p75_wall_minutes"],
      )
      for row in codex["by_originator"]
  ]

  parts = [
      f"Session audit, last {result['days']} days through {result['generated_at']}",
      "Task durations from the plans trail",
      text_table(
          ("n", "median minutes", "p75 minutes"),
          [(tasks["n"], tasks["median_minutes"], tasks["p75_minutes"])],
      ),
      "Histogram",
      text_table(("duration bin", "n"), task_histogram_rows),
      "By effort",
      text_table(("effort", "n", "median minutes"), task_effort_rows),
  ]
  parts.extend(f"Note: {message}" for message in tasks["notes"])
  parts.extend(
      [
          "Phase split of /plans do windows",
          text_table(
              (
                  "found",
                  "kept",
                  "median duration minutes",
                  "p75 duration minutes",
                  "median first edit seconds",
                  "median tail seconds",
                  "p75 tail seconds",
                  "no edit",
              ),
              phase_rows,
          ),
          "Pooled shares of summed duration",
          text_table(("phase", "percent"), share_rows),
          "Subagents",
          text_table(("n", "total wall hours"), [
                     (subagents["n"], subagents["total_wall_hours"])]),
          text_table(("agent type", "n", "median wall minutes"), subagent_rows),
      ]
  )
  parts.extend(f"Note: {message}" for message in windows["notes"])
  parts.extend(
      [
          "Codex runs grouped by model and effort",
          text_table(("overall n",), [(codex["n"],)]),
          text_table(("model", "effort", "n", "median wall minutes",
                     "p75 wall minutes"), codex_rows),
          "Codex runs grouped by originator, model and effort",
          text_table(
              ("originator", "model", "effort", "n",
               "median wall minutes", "p75 wall minutes"),
              codex_originator_rows,
          ),
      ]
  )
  parts.extend(f"Note: {message}" for message in codex["notes"])
  return "\n\n".join(parts)


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Report task timing from local session stores.")
  parser.add_argument("--days", type=int, default=14)
  parser.add_argument("--json", action="store_true")
  args = parser.parse_args()
  if args.days < 0:
    parser.error("--days must be zero or greater")

  for messages in READ_NOTES.values():
    messages.clear()

  generated_at = datetime.now(timezone.utc)
  cutoff = generated_at - timedelta(days=args.days)
  plans_dir = Path(os.environ.get(
    "PLANS_DIR", str(Path.home() / "Plans"))).expanduser()
  tasks = read_tasks(plans_dir, cutoff)
  windows, subagents = read_windows(cutoff)
  codex_runs = read_codex_runs(cutoff)
  task_summary = summarize_tasks(tasks)
  window_summary = summarize_windows(windows, subagents)
  codex_summary = summarize_codex_runs(codex_runs)
  task_summary["notes"] = READ_NOTES["tasks"]
  window_summary["notes"] = READ_NOTES["windows"]
  codex_summary["notes"] = READ_NOTES["codex"]
  result = {
      "days": args.days,
      "generated_at": iso_timestamp(generated_at),
      "tasks": task_summary,
      "windows": window_summary,
      "codex": codex_summary,
  }

  if args.json:
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))
    return 0

  print(render(result))
  return 0


if __name__ == "__main__":
  sys.exit(main())
