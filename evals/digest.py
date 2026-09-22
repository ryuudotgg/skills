#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path


def read_events(raw):
  for line in raw.splitlines():
    if not line.strip():
      continue

    try:
      event = json.loads(line)
    except json.JSONDecodeError:
      continue

    if isinstance(event, dict):
      yield event


def blocks(event):
  message = event.get("message")
  if not isinstance(message, dict):
    return

  content = message.get("content")
  if isinstance(content, str):
    yield {"type": "text", "text": content}
  elif isinstance(content, list):
    for block in content:
      if isinstance(block, dict):
        yield block


def content_text(content):
  if isinstance(content, str):
    return content

  if isinstance(content, list):
    return "\n".join(content_text(block) for block in content)

  if isinstance(content, dict):
    if content.get("type") == "thinking":
      return ""
    if "text" in content:
      return content_text(content["text"])
    if "content" in content:
      return content_text(content["content"])

  return "" if content is None else json.dumps(content, ensure_ascii=False)


def clipped(value, head=2000, tail=1000):
  text = content_text(value)
  dropped = len(text) - head - tail
  if dropped <= 0:
    return text

  marker = f"[dropped {dropped} characters]"
  return f"{text[:head]}\n{marker}\n{text[-tail:]}\n{marker}"


def prefix(event):
  return "[sub] " if event.get("parent_tool_use_id") is not None else ""


def digest(events, path):
  print(f"Full transcript: {path.resolve()}")
  tools = {
    block.get("id"): block.get("name", "unknown")
    for event in events for block in blocks(event)
    if block.get("type") == "tool_use"
  }
  final = next((event for event in reversed(events)
                if event.get("type") == "result"
                and event.get("parent_tool_use_id") is None), None)

  for event in events:
    label = prefix(event)
    if event.get("type") == "system":
      if event.get("subtype") == "permission_denied":
        tool = event.get("tool_name", event.get("tool", "unknown"))
        print(f"{label}permission_denied {tool}")
      continue

    for block in blocks(event):
      kind = block.get("type")
      if kind == "text" and event.get("type") == "assistant":
        print(f"{label}{content_text(block.get('text'))}")
      elif kind == "tool_use":
        fields = [f"{label}tool_use {block.get('name', 'unknown')}",
                  f"id={block.get('id', '')}"]
        inputs = block.get("input")
        if isinstance(inputs, dict):
          for key in ("subagent_type", "description", "command", "file_path"):
            if key in inputs:
              value = clipped(inputs[key], head=1000, tail=1000)
              fields.append(f"{key}={json.dumps(value, ensure_ascii=False)}")

        print(" ".join(fields))
      elif kind == "tool_result":
        tool_id = block.get("tool_use_id", "")
        error = " is_error=true" if block.get("is_error") else ""
        print(f"{label}tool_result {tools.get(tool_id, 'unknown')} "
              f"tool_use_id={tool_id}{error}\n{clipped(block.get('content'))}")

    if event is final:
      print("Agent's final reply:")
      print(content_text(event.get("result")))


MISSING = re.compile(r"command not found|not found|No such file or directory")


def reachable_paths(result, command, name, known):
  found = []
  for line in result.splitlines():
    candidate = line.strip().strip("'\"")
    if not candidate.startswith("/") or candidate in command:
      continue

    path = Path(candidate)
    if path.name != name or path.is_dir():
      continue

    if candidate in known or not path.exists() or os.access(candidate, os.X_OK):
      found.append(candidate)

  return found


def hide_check(events, hide_path, canary_path):
  names = [line.strip()
           for line in hide_path.read_text().splitlines() if line.strip()]
  canaries = [line for line in canary_path.read_text().splitlines()
              if Path(line).is_absolute()]
  results = {}
  commands = []

  for event in events:
    for block in blocks(event):
      if block.get("type") == "tool_result":
        results.setdefault(block.get("tool_use_id"), []).append(block)
      elif block.get("type") == "tool_use" and block.get("name") == "Bash":
        inputs = block.get("input")
        command = inputs.get("command") if isinstance(inputs, dict) else None
        if isinstance(command, str):
          commands.append((block.get("id"), command))

  for name in names:
    name_pattern = re.compile(r"(?<![\w.-])" + re.escape(name) + r"(?![\w.-])")
    invocation_pattern = re.compile(r"(?:^|;|&&|\|\||\||\n)[ \t]*"
                                    + re.escape(name) + r"(?=$|[\s;|&<>])")
    known = {path for path in canaries if Path(path).name == name}
    leaked = []
    hidden = False
    probes = []

    for tool_id, command in commands:
      invoked = invocation_pattern.search(command)
      lookup = (re.search(r"\bcommand\s+-v\b|\bwhich\b", command)
                and name_pattern.search(command))
      if not invoked and not lookup:
        continue

      paired = results.get(tool_id, [])
      if not paired:
        continue

      result = "\n".join(content_text(block.get("content")) for block in paired)
      probes.append((command, result))
      leaked.extend(reachable_paths(result, command, name, known))

      if lookup:
        hidden = True
      elif any(name_pattern.search(line) and MISSING.search(line)
               for line in result.splitlines()):
        hidden = True

    status = "LEAKED" if leaked else "HIDDEN" if hidden else "UNCHECKED"
    print(f"{status} {name}")

    for path in sorted(set(leaked)):
      print(f"  reachable at: {path}")

    for command, result in probes:
      print(f"  command: {command}")
      print(f"  result: {result[:200]}")


def main():
  sys.stdout.reconfigure(errors="replace")
  parser = argparse.ArgumentParser()
  parser.add_argument("--hide-check", nargs=2, type=Path,
                      metavar=("HIDE", "CANARY"))
  parser.add_argument("transcript", type=Path)
  args = parser.parse_args()
  raw = args.transcript.read_text(encoding="utf-8")
  events = list(read_events(raw))

  if args.hide_check:
    hide_check(events, *args.hide_check)
  else:
    digest(events, args.transcript)


if __name__ == "__main__":
  main()
