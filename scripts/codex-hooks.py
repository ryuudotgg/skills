#!/usr/bin/env python3
import argparse
import json
import math
import os
import shlex
import stat
import sys
import tempfile


ENTRIES = (
    ("SessionStart", "startup|resume|clear|compact", "hook session-start"),
    ("PreToolUse", "^Bash$", "commit-guard.sh"),
    ("PostToolUse", "^(Edit|MultiEdit|Write)$", "no-em-dash.sh"),
    ("PostToolUse", "^(Edit|MultiEdit|Write)$", "no-comments.sh"),
    ("Stop", None, "reply-guard.sh"),
)

RETIRED = (("session-brief.sh", "hook session-start"),)


def command_for(target, hooks_dir, agents_dir):
    if target.endswith(".sh"):
        return os.path.join(hooks_dir, target)

    return shlex.quote(os.path.join(agents_dir, "playbook", "bin", "skills")) + " " + target


def owned_entries(data, hooks_dir, personal):
    hooks = data.get("hooks") if isinstance(data, dict) else None
    owned = []

    for retired, target in RETIRED:
        if retired in personal:
            continue

        event = next(event for event, _, name in ENTRIES if name == target)
        groups = hooks.get(event) if isinstance(hooks, dict) else None
        if not isinstance(groups, list):
            continue

        old = os.path.join(hooks_dir, retired)
        for group in groups:
            entries = group.get("hooks") if isinstance(group, dict) else None
            if not isinstance(entries, list):
                continue

            for entry in entries:
                if isinstance(entry, dict) and entry.get("command") == old:
                    owned.append((event, target, group, entry, old))

    return owned


def replace_retired(data, owned, hooks_dir, agents_dir, unwired):
    changes = []
    absent = {(event, command) for event, _, command in missing_entries(data, hooks_dir, agents_dir)}

    for event, target, group, entry, old in owned:
        if target in unwired:
            continue

        new = command_for(target, hooks_dir, agents_dir)
        if (event, new) in absent:
            entry["command"] = new
            absent.remove((event, new))
            changes.append(f"codex  replace {event} {old} with {new}")
        else:
            group["hooks"].remove(entry)
            if not group["hooks"]:
                data["hooks"][event].remove(group)
            changes.append(f"codex  drop {event} {old}")

    return changes


def unique_object(pairs):
    result = {}

    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key: {key}")
        result[key] = value

    return result


def reject_constant(name):
    raise ValueError(f"{name} is not JSON")


def exact_float(text):
    value = float(text)

    if not math.isfinite(value) or repr(value) != text:
        raise ValueError(f"number {text} would change on a rewrite")

    return value


def missing_entries(data, hooks_dir, agents_dir, unwired=()):
    hooks = data.get("hooks") if isinstance(data, dict) else None
    missing = []

    for event, matcher, script in ENTRIES:
        if script in unwired:
            continue

        command = command_for(script, hooks_dir, agents_dir)
        groups = hooks.get(event) if isinstance(hooks, dict) else None
        found = False

        if isinstance(groups, list):
            for group in groups:
                entries = group.get("hooks") if isinstance(group, dict) else None
                if isinstance(entries, list) and any(
                    isinstance(entry, dict) and entry.get("command") == command
                    for entry in entries
                ):
                    found = True
                    break

        if not found:
            missing.append((event, matcher, command))

    return missing


def add_entries(data, missing):
    hooks = data.setdefault("hooks", {})

    for event in dict.fromkeys(event for event, _, _ in missing):
        rows = [row for row in missing if row[0] == event]
        groups = hooks.setdefault(event, [])

        for matcher in dict.fromkeys(matcher for _, matcher, _ in rows):
            commands = [command for _, current, command in rows if current == matcher]
            group = {"hooks": [{"type": "command", "command": command} for command in commands]}
            if matcher is not None:
                group = {"matcher": matcher, **group}
            groups.append(group)


def skip(path, reason, missing, owned=()):
    if not missing:
        print(f"skip   {path} ({reason})")
        return

    hand_add = {"hooks": {}}
    add_entries(hand_add, missing)
    print(f"skip   {path} ({reason}), Codex runs none of the missing skills hooks until you add them:")
    print(json.dumps(hand_add, indent=2, ensure_ascii=False))

    for event, _, _, _, old in owned:
        print(f"codex  remove {event} {old} by hand")


def keep_group_and_xattrs(source, target):
    try:
        os.chown(target, -1, os.stat(source).st_gid)
    except OSError:
        pass

    try:
        names = os.listxattr(source)
    except (AttributeError, OSError):
        return

    for name in names:
        try:
            os.setxattr(target, name, os.getxattr(source, name))
        except OSError:
            pass


def write_atomic(real, content, mode):
    temp_fd, temp_path = tempfile.mkstemp(prefix=f".{os.path.basename(real)}.", dir=os.path.dirname(real))

    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())

        if os.path.exists(real):
            keep_group_and_xattrs(real, temp_path)

        os.chmod(temp_path, mode)
        os.replace(temp_path, real)

        try:
            dir_fd = os.open(os.path.dirname(real), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def main(path, hooks_dir, agents_dir, unwired, personal=(), no_cli=False):
    real = os.path.realpath(path)
    data = {"hooks": {}}
    owned = []

    if no_cli:
        unwired.update(target for _, _, target in ENTRIES if not target.endswith(".sh"))

    for _, _, script in ENTRIES:
        if script in unwired:
            print(f"skip   {script} Codex entry (the repo's {script} is not what runs, so none is added)")

    all_missing = missing_entries(data, hooks_dir, agents_dir, unwired)

    if os.path.islink(path) and not os.path.exists(path):
        skip(path, "dangling symlink or symlink loop", all_missing, owned)
        return

    if os.path.isdir(real):
        skip(path, "is a directory", all_missing, owned)
        return

    directory = os.path.dirname(real)
    if not os.path.isdir(directory):
        skip(path, "parent directory does not exist", all_missing, owned)
        return

    exists = os.path.exists(real)
    if exists:
        mode = os.stat(real).st_mode
        if not stat.S_ISREG(mode):
            skip(path, "is not a regular file", all_missing, owned)
            return
        if not os.access(real, os.R_OK) or not mode & 0o444:
            skip(path, "is not readable", all_missing, owned)
            return
        try:
            with open(real, encoding="utf-8") as source:
                data = json.load(
                    source,
                    object_pairs_hook=unique_object,
                    parse_constant=reject_constant,
                    parse_float=exact_float,
                )
        except UnicodeDecodeError:
            skip(path, "is not UTF-8", all_missing, owned)
            return
        except json.JSONDecodeError as error:
            skip(path, f"invalid JSON: {error}", all_missing, owned)
            return
        except ValueError as error:
            skip(path, str(error), all_missing, owned)
            return
        except RecursionError:
            skip(path, "nested too deeply to parse", all_missing, owned)
            return
        except OSError as error:
            skip(path, f"cannot read: {error.strerror}", all_missing, owned)
            return

    personal_targets = {}
    for _, target, _, _, old in owned_entries(data, hooks_dir, ()):
        if os.path.basename(old) in personal:
            personal_targets[target] = old

    for target, old in personal_targets.items():
        unwired.add(target)
        print(f"skip   {target} Codex entry ({path} already runs {old}, which this repo did not install)")

    owned = [entry for entry in owned_entries(data, hooks_dir, personal) if entry[1] not in unwired]
    missing = missing_entries(data, hooks_dir, agents_dir, unwired)
    unfiltered = missing_entries(data, hooks_dir, agents_dir)
    for _, _, script in ENTRIES:
        if script.endswith(".sh") and script in unwired and not any(command == command_for(script, hooks_dir, agents_dir) for _, _, command in unfiltered):
            print(f"codex  {path} already runs {script}, which this repo did not install; remove that entry by hand if you do not want it")

    if not isinstance(data, dict):
        skip(path, "top level is not an object", missing, owned)
        return

    hooks = data.get("hooks")
    if "hooks" in data and not isinstance(hooks, dict):
        skip(path, "hooks is not an object", missing, owned)
        return

    if isinstance(hooks, dict):
        for event in dict.fromkeys(event for event, _, _ in missing):
            if event in hooks and not isinstance(hooks[event], list):
                skip(path, f"{event} is not a list", missing, owned)
                return

    wanted = missing
    changes = replace_retired(data, owned, hooks_dir, agents_dir, unwired)
    missing = missing_entries(data, hooks_dir, agents_dir, unwired)
    if not missing and not changes:
        print(f"codex  {path} already holds every skills hook")
        return

    if exists and (not os.access(real, os.W_OK) or not mode & 0o222):
        skip(path, "is not writable", wanted, owned)
        return

    if exists and os.stat(real).st_uid != os.geteuid():
        skip(path, "is owned by another user", wanted, owned)
        return

    if exists and os.stat(real).st_nlink > 1:
        skip(path, "has hard links a rewrite would split", wanted, owned)
        return

    if not os.access(directory, os.W_OK) or not os.stat(directory).st_mode & 0o222:
        skip(path, "parent directory is not writable", wanted, owned)
        return

    add_entries(data, missing)
    try:
        content = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        content.encode("utf-8")
    except UnicodeEncodeError:
        skip(path, "cannot encode as UTF-8", wanted, owned)
        return

    if exists:
        target_mode = mode & 0o7777
    else:
        mask = os.umask(0)
        os.umask(mask)
        target_mode = 0o666 & ~mask

    try:
        write_atomic(real, content, target_mode)
    except OSError as error:
        skip(path, f"cannot write: {error.strerror}", wanted, owned)
        return

    for change in changes:
        print(change)
    for event, _, command in missing:
        print(f"codex  add {event} {command}")
    if missing or any(change.startswith("codex  replace ") for change in changes):
        print(f"codex  {path} (open codex, run /hooks, trust the new entries once)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("hooks_dir")
    parser.add_argument("agents_dir")
    parser.add_argument("names", nargs="*")
    parser.add_argument("--personal", action="append", default=[])
    parser.add_argument("--no-cli", action="store_true")
    args = parser.parse_intermixed_args()
    main(args.path, args.hooks_dir, args.agents_dir, set(args.names), args.personal, args.no_cli)
