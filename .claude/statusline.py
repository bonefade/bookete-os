#!/usr/bin/env python3
"""brain-os statusline: <folder> | <model> | <ctx used/size> | <5h window>.

Claude Code pipes a JSON status object to stdin; the first stdout line becomes
the statusline. Every segment degrades gracefully — a missing field drops the
segment, never the line (rate_limits e.g. only exists for Pro/Max sessions
after the first API response).

Folder name resolution (sandbox/mount aware):
  1. $BRAIN_STATUSLINE_NAME
  2. .claude/statusline-name in the project dir (one line) — for container/VM
     setups where the mount path's basename is not the repo name
  3. repo name parsed from the project dir's .git/config [remote "origin"]
     url — another container/VM case, where the mount basename isn't the
     repo name but there's no statusline-name file either
  4. basename of workspace.current_dir (fallback: cwd)
"""

import json
import os
import sys
from datetime import datetime

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"


def load_color(pct):
    if pct >= 80:
        return RED
    if pct >= 60:
        return YELLOW
    return GREEN


def fmt_tokens(n):
    if n >= 1_000_000:
        s = f"{n / 1_000_000:.1f}M"
        return s.replace(".0M", "M")
    if n >= 1_000:
        return f"{round(n / 1_000)}k"
    return str(n)


def repo_name_from_git_config(project_dir):
    """Best-effort repo name from .git/config's [remote "origin"] url.

    Handles https://host/owner/name.git and git@host:owner/name.git forms.
    Returns None on any failure (missing/unparseable config, worktree's
    .git file instead of dir, no origin remote, etc.) — never raises.
    """
    try:
        with open(os.path.join(project_dir, ".git", "config")) as f:
            lines = f.readlines()
    except OSError:
        return None

    in_origin = False
    url = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            in_origin = stripped.lower() == '[remote "origin"]'
            continue
        if in_origin and stripped.startswith("url"):
            _, _, value = stripped.partition("=")
            url = value.strip()
            break

    if not url:
        return None

    path = url.rstrip("/")
    if "://" in path:
        path = path.split("://", 1)[1]
    path = path.split(":")[-1] if "@" in path else path
    name = path.rstrip("/").split("/")[-1]
    if name.endswith(".git"):
        name = name[: -len(".git")]
    return name or None


def folder_segment(data):
    name = os.environ.get("BRAIN_STATUSLINE_NAME", "").strip()
    workspace = data.get("workspace") or {}
    project_dir = workspace.get("project_dir") or data.get("cwd") or ""
    if not name and project_dir:
        try:
            with open(os.path.join(project_dir, ".claude", "statusline-name")) as f:
                name = f.read().strip()
        except OSError:
            pass
    if not name and project_dir:
        name = repo_name_from_git_config(project_dir) or ""
    if not name:
        current = workspace.get("current_dir") or data.get("cwd") or ""
        name = os.path.basename(current.rstrip("/"))
    return f"{BOLD}{name}{RESET}" if name else None


def model_segment(data):
    name = (data.get("model") or {}).get("display_name")
    return f"{CYAN}{name}{RESET}" if name else None


def context_segment(data):
    cw = data.get("context_window") or {}
    used = cw.get("total_input_tokens")
    size = cw.get("context_window_size")
    if used is None or not size:
        return None
    pct = cw.get("used_percentage")
    if pct is None:
        pct = used / size * 100
    color = load_color(pct)
    return f"{color}{fmt_tokens(used)}/{fmt_tokens(size)} ({round(pct)}%){RESET}"


def five_hour_segment(data):
    window = (data.get("rate_limits") or {}).get("five_hour") or {}
    pct = window.get("used_percentage")
    if pct is None:
        return None
    seg = f"{load_color(pct)}5h {round(pct)}%{RESET}"
    resets_at = window.get("resets_at")
    if resets_at:
        seg += f"{DIM} ↻{datetime.fromtimestamp(resets_at).strftime('%H:%M')}{RESET}"
    return seg


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        data = {}
    segments = [
        folder_segment(data),
        model_segment(data),
        context_segment(data),
        five_hour_segment(data),
    ]
    print(f"{DIM} | {RESET}".join(s for s in segments if s))


if __name__ == "__main__":
    main()
