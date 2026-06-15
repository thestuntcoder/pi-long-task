#!/usr/bin/env python3
"""Coordinate independent Pi RPC sessions for TODO markdown tasks.

Input can be either an existing TODO markdown file path or a raw string. Raw
strings are converted by a Pi RPC session into a temporary TODO.md under the
project `tmp/` directory first (default model `openai-codex/gpt-5.5`, thinking
`xhigh`). The generated TODO directory is removed after all tasks complete
unless `--keep-generated-todo` is used. Task execution sessions use the same
model with thinking `high` by default.

Expected TODO format matches TEST_COVERAGE_TODO.md style:

- A progress list containing lines like: `- [ ] TODO 1 — Task title`
- Per-task sections headed like: `## TODO 1 — Task title`
- Optional per-task `**Status:**` checkbox block

The coordinator sends one task section at a time to a fresh `pi --mode rpc`
session, records each session in TASK_RESULT.md, and optionally commits after
each session while never staging TASK_RESULT.md.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import datetime as dt
import json
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import textwrap
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

TASK_HEADING_RE = re.compile(r"^##\s+TODO\s+(\d+)\s+[—-]\s+(.+?)\s*$")
PROGRESS_RE_TEMPLATE = r"^(?P<prefix>\s*-\s+\[)(?P<mark>[ xX])(?P<suffix>\]\s+TODO\s+{task_id}\b.*)$"
ANY_PROGRESS_RE = re.compile(r"^\s*-\s+\[[ xX]\]\s+TODO\s+(\d+)\b")
CHECKBOX_RE = re.compile(r"^(?P<prefix>\s*-\s+\[)(?P<mark>[ xX])(?P<suffix>\].*)$")
TODO_LINE_RE = re.compile(r"^\s*TODO\s+\d+\s+[—-]\s+(?P<text>.+?)\s*$", re.IGNORECASE)
LIST_ITEM_RE = re.compile(r"^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(?P<text>.+?)\s*$")
TASK_RESULT_BLOCK_RE = re.compile(r"TASK_RESULT\s*:\s*(?P<body>.*)\Z", re.IGNORECASE | re.DOTALL)
STATUS_LINE_RE = re.compile(r"^\s*status\s*:\s*(?P<status>[A-Za-z_-]+)\s*$", re.IGNORECASE | re.MULTILINE)

DONE_STATUSES = {"done", "complete", "completed", "success", "succeeded"}
PARTIAL_STATUSES = {"partial", "incomplete", "blocked", "failed", "failure", "unknown"}

DEFAULT_MODEL = "openai-codex/gpt-5.5"
DEFAULT_TASK_THINKING = "high"
DEFAULT_TODO_THINKING = "xhigh"


@dataclass
class Task:
    task_id: str
    title: str
    section: str
    start_line: int
    end_line: int
    done: bool
    progress_done: Optional[bool]
    status_checkboxes: list[bool] = field(default_factory=list)

    @property
    def label(self) -> str:
        return f"TODO {self.task_id} — {self.title}"


@dataclass
class SessionOutcome:
    task: Task
    attempt: int
    started_at: str
    ended_at: str
    reported_status: str
    assistant_text: str
    session_file: Optional[str]
    context_observations: list[str]
    compaction_events: list[str]
    shutdown_requested: bool
    commit_hash: Optional[str] = None
    commit_error: Optional[str] = None
    pi_exit_code: Optional[int] = None
    error: Optional[str] = None

    @property
    def done(self) -> bool:
        return self.reported_status.lower() in DONE_STATUSES


class TodoParseError(RuntimeError):
    pass


class RpcError(RuntimeError):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


async def resolve_todo_input(args: argparse.Namespace, cwd: Path) -> tuple[Path, bool, Optional[Path]]:
    """Return `(todo_path, generated_from_string, generated_todo_dir)`.

    Existing file paths are used directly. Raw strings are converted into a
    temporary TODO.md under the project tmp/ directory by a separate Pi RPC
    session using xhigh thinking by default.
    """
    raw_input = args.todo_input
    input_mode = args.input_mode

    if input_mode in {"auto", "file"} and raw_input != "-":
        candidate = Path(raw_input).expanduser()
        if candidate.exists():
            return candidate.resolve(), False, None
        if input_mode == "file":
            raise FileNotFoundError(f"TODO file not found: {candidate}")

    if raw_input == "-":
        raw_todo = sys.stdin.read()
    else:
        raw_todo = raw_input

    if not raw_todo.strip():
        raise TodoParseError("Input string is empty; cannot create TODO.md")

    temp_parent = (args.generated_todo_parent.resolve() if args.generated_todo_parent else cwd / "tmp")
    temp_parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="pi-todo-coordinator-", dir=str(temp_parent)))
    todo_path = temp_dir / "TODO.md"
    todo_markdown = await create_todo_markdown_with_pi(
        raw_todo=raw_todo,
        pi_args=build_todo_pi_args(args),
        cwd=cwd,
        verbose=args.verbose,
    )
    write_text(todo_path, todo_markdown)
    return todo_path, True, temp_dir


def todo_markdown_from_string(raw_todo: str) -> str:
    raw_todo = raw_todo.strip()
    lines = raw_todo.splitlines(keepends=True)
    headings: list[tuple[int, str, str]] = []
    has_progress = False

    for idx, line in enumerate(lines):
        stripped = line.rstrip("\n\r")
        heading = TASK_HEADING_RE.match(stripped)
        if heading:
            headings.append((idx, heading.group(1), heading.group(2).strip()))
        if ANY_PROGRESS_RE.match(stripped):
            has_progress = True

    if headings:
        normalized = raw_todo.rstrip() + "\n"
        if has_progress:
            return normalized
        progress = ["# Pi Coordinator TODO", "", "## Progress", ""]
        for _idx, task_id, title in headings:
            progress.append(f"- [ ] TODO {task_id} — {title}")
        progress.extend(["", "---", "", normalized.rstrip(), ""])
        return "\n".join(progress)

    items = task_items_from_string(raw_todo) or [raw_todo]
    return generated_todo_markdown(items)


def task_items_from_string(raw_todo: str) -> list[str]:
    items: list[str] = []
    for line in raw_todo.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = TODO_LINE_RE.match(stripped) or LIST_ITEM_RE.match(stripped)
        if match:
            item = match.group("text").strip()
            if item:
                items.append(item)
    return items if len(items) >= 2 else []


def generated_todo_markdown(items: list[str]) -> str:
    titles = [title_from_string(item) for item in items]
    lines = [
        "# Pi Coordinator TODO",
        "",
        "Created from input string by `pi_todo_coordinator.py`.",
        "",
        "## Progress",
        "",
    ]
    for index, title in enumerate(titles, start=1):
        lines.append(f"- [ ] TODO {index} — {title}")
    lines.extend(["", "---", ""])

    for index, (title, item) in enumerate(zip(titles, items), start=1):
        fence = code_fence_for(item)
        lines.extend(
            [
                f"## TODO {index} — {title}",
                "",
                "**Goal:** Complete the requested work from the input string.",
                "",
                "**Status:**",
                "- [ ] Complete the requested work",
                "- [ ] Verify as practical",
                "- [ ] Report result",
                "",
                "**Request:**",
                "",
                f"{fence}text",
                item.strip(),
                fence,
                "",
                "**Done when:** The request is complete and verified as practical.",
                "",
                "---",
                "",
            ]
        )

    if len(lines) >= 2 and lines[-2] == "---":
        lines = lines[:-2]
    return "\n".join(lines).rstrip() + "\n"


def title_from_string(raw_todo: str) -> str:
    first_line = next((line.strip("# -*\t ") for line in raw_todo.splitlines() if line.strip()), "Task")
    first_line = re.sub(r"\s+", " ", first_line).strip() or "Task"
    if len(first_line) <= 80:
        return first_line
    return first_line[:77].rstrip() + "..."


def code_fence_for(text: str) -> str:
    longest = max((len(match.group(0)) for match in re.finditer(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def parse_tasks(todo_path: Path) -> list[Task]:
    text = read_text(todo_path)
    lines = text.splitlines(keepends=True)
    headings: list[tuple[int, str, str]] = []

    for idx, line in enumerate(lines):
        match = TASK_HEADING_RE.match(line.rstrip("\n\r"))
        if match:
            headings.append((idx, match.group(1), match.group(2).strip()))

    if not headings:
        raise TodoParseError(
            f"No task sections found in {todo_path}. Expected headings like `## TODO 1 — Task title`."
        )

    tasks: list[Task] = []
    for pos, (start_idx, task_id, title) in enumerate(headings):
        end_idx = headings[pos + 1][0] if pos + 1 < len(headings) else len(lines)
        section = "".join(lines[start_idx:end_idx]).rstrip() + "\n"
        progress_done = find_progress_done(lines, task_id)
        status_checkboxes = find_status_checkboxes(lines, start_idx, end_idx)

        if progress_done is not None:
            done = progress_done
        elif status_checkboxes:
            done = all(status_checkboxes)
        else:
            done = False

        tasks.append(
            Task(
                task_id=task_id,
                title=title,
                section=section,
                start_line=start_idx + 1,
                end_line=end_idx,
                done=done,
                progress_done=progress_done,
                status_checkboxes=status_checkboxes,
            )
        )

    return tasks


def find_progress_done(lines: list[str], task_id: str) -> Optional[bool]:
    regex = re.compile(PROGRESS_RE_TEMPLATE.format(task_id=re.escape(task_id)))
    for line in lines:
        match = regex.match(line.rstrip("\n\r"))
        if match:
            return match.group("mark").lower() == "x"
    return None


def find_status_checkboxes(lines: list[str], start_idx: int, end_idx: int) -> list[bool]:
    in_status = False
    seen_checkbox = False
    checkboxes: list[bool] = []

    for idx in range(start_idx, end_idx):
        stripped = lines[idx].strip()
        if stripped == "**Status:**":
            in_status = True
            continue

        if not in_status:
            continue

        checkbox = CHECKBOX_RE.match(lines[idx].rstrip("\n\r"))
        if checkbox:
            seen_checkbox = True
            checkboxes.append(checkbox.group("mark").lower() == "x")
            continue

        if stripped == "":
            continue

        if seen_checkbox:
            break

    return checkboxes


def incomplete_tasks(todo_path: Path) -> list[Task]:
    return [task for task in parse_tasks(todo_path) if not task.done]


def mark_task_done(todo_path: Path, task_id: str) -> None:
    lines = read_text(todo_path).splitlines(keepends=True)
    progress_regex = re.compile(PROGRESS_RE_TEMPLATE.format(task_id=re.escape(task_id)))

    for idx, line in enumerate(lines):
        newline = "\n" if line.endswith("\n") else ""
        raw = line.rstrip("\n\r")
        match = progress_regex.match(raw)
        if match and match.group("mark").lower() != "x":
            lines[idx] = f"{match.group('prefix')}x{match.group('suffix')}{newline}"

    headings: list[tuple[int, str]] = []
    for idx, line in enumerate(lines):
        match = TASK_HEADING_RE.match(line.rstrip("\n\r"))
        if match:
            headings.append((idx, match.group(1)))

    for pos, (start_idx, current_id) in enumerate(headings):
        if current_id != task_id:
            continue
        end_idx = headings[pos + 1][0] if pos + 1 < len(headings) else len(lines)
        mark_status_block_done(lines, start_idx, end_idx)
        break

    write_text(todo_path, "".join(lines))


def mark_status_block_done(lines: list[str], start_idx: int, end_idx: int) -> None:
    in_status = False
    seen_checkbox = False

    for idx in range(start_idx, end_idx):
        stripped = lines[idx].strip()
        if stripped == "**Status:**":
            in_status = True
            continue

        if not in_status:
            continue

        raw = lines[idx].rstrip("\n\r")
        newline = "\n" if lines[idx].endswith("\n") else ""
        checkbox = CHECKBOX_RE.match(raw)
        if checkbox:
            seen_checkbox = True
            if checkbox.group("mark").lower() != "x":
                lines[idx] = f"{checkbox.group('prefix')}x{checkbox.group('suffix')}{newline}"
            continue

        if stripped == "":
            continue

        if seen_checkbox:
            break


def assistant_message_text(message: dict[str, Any]) -> str:
    if message.get("role") != "assistant":
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(str(item.get("text") or ""))
    return "".join(parts)


def last_assistant_text_from_messages(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if isinstance(message, dict):
            text = assistant_message_text(message)
            if text:
                return text
    return ""


def has_task_result(assistant_text: str) -> bool:
    return bool(re.search(r"TASK_RESULT\s*:", assistant_text or "", re.IGNORECASE))


def has_task_result_status(assistant_text: str) -> bool:
    """Return true once a TASK_RESULT block includes a parseable status line."""
    block = TASK_RESULT_BLOCK_RE.search(assistant_text or "")
    if not block:
        return False
    return bool(STATUS_LINE_RE.search(block.group("body")))


def parse_reported_status(assistant_text: str) -> str:
    block = TASK_RESULT_BLOCK_RE.search(assistant_text or "")
    search_text = block.group("body") if block else (assistant_text or "")
    status_match = STATUS_LINE_RE.search(search_text)
    if not status_match:
        return "unknown"
    status = status_match.group("status").strip().lower()
    return status if status in DONE_STATUSES or status in PARTIAL_STATUSES else status


def extract_result_summary(assistant_text: str, limit: int = 8000) -> str:
    text = (assistant_text or "").strip()
    block = TASK_RESULT_BLOCK_RE.search(text)
    if block:
        text = "TASK_RESULT:\n" + block.group("body").strip()
    if len(text) > limit:
        return text[:limit] + "\n\n[truncated by coordinator]\n"
    return text


def append_task_result(result_path: Path, outcome: SessionOutcome) -> None:
    result_path.parent.mkdir(parents=True, exist_ok=True)
    if result_path.exists():
        existing = read_text(result_path)
    else:
        existing = "# Task Results\n\nGenerated by `pi_todo_coordinator.py`. Do not commit this file.\n"

    lines: list[str] = []
    lines.append("\n---\n")
    lines.append(f"\n## Attempt {outcome.attempt} — {outcome.task.label}\n\n")
    lines.append(f"- Started: {outcome.started_at}\n")
    lines.append(f"- Ended: {outcome.ended_at}\n")
    lines.append(f"- Reported status: `{outcome.reported_status}`\n")
    lines.append(f"- Session file: `{outcome.session_file or 'unknown'}`\n")
    lines.append(f"- Context shutdown requested: `{str(outcome.shutdown_requested).lower()}`\n")
    if outcome.pi_exit_code is not None:
        lines.append(f"- Pi exit code: `{outcome.pi_exit_code}`\n")
    if outcome.commit_hash:
        lines.append(f"- Commit: `{outcome.commit_hash}`\n")
    if outcome.commit_error:
        lines.append(f"- Commit error: `{outcome.commit_error}`\n")
    if outcome.error:
        lines.append(f"- Coordinator/session error: `{outcome.error}`\n")

    if outcome.context_observations:
        lines.append("\n### Context observations\n\n")
        for observation in outcome.context_observations:
            lines.append(f"- {observation}\n")

    if outcome.compaction_events:
        lines.append("\n### Compaction events\n\n")
        for event in outcome.compaction_events:
            lines.append(f"- {event}\n")

    lines.append("\n### Assistant result\n\n")
    lines.append("```text\n")
    assistant_summary = extract_result_summary(outcome.assistant_text)
    lines.append(assistant_summary)
    if not assistant_summary.endswith("\n"):
        lines.append("\n")
    lines.append("```\n")

    write_text(result_path, existing.rstrip() + "\n" + "".join(lines))


def previous_attempts_for_task(result_path: Path, task: Task, limit: int = 6000) -> str:
    if not result_path.exists():
        return ""
    text = read_text(result_path)
    chunks = text.split("\n---\n")
    matching = [chunk.strip() for chunk in chunks if task.label in chunk]
    if not matching:
        return ""
    summary = "\n\n---\n\n".join(matching[-3:])
    if len(summary) > limit:
        summary = summary[-limit:]
    return summary


def todo_global_instructions(todo_path: Path, limit: int = 6000) -> str:
    """Return TODO-file instructions before the progress/task list.

    This preserves scope guardrails (for example, "tests only") while still not
    showing the worker other task bodies.
    """
    lines = read_text(todo_path).splitlines()
    selected: list[str] = []
    for line in lines:
        if re.match(r"^##\s+Progress\s*$", line.strip(), re.IGNORECASE):
            break
        if TASK_HEADING_RE.match(line.strip()):
            break
        selected.append(line)

    text = "\n".join(selected).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "\n\n[truncated by coordinator]"
    return text


def build_task_prompt(
    *,
    todo_path: Path,
    task: Task,
    attempt: int,
    commit_requested: bool,
    previous_attempts: str,
    global_instructions: str,
    max_bash_timeout: float,
) -> str:
    commit_text = (
        "The coordinator will commit after your session if needed. Do not run git commit."
        if commit_requested
        else "Do not run git commit. The coordinator was started with commits disabled."
    )

    previous_text = ""
    if previous_attempts:
        previous_text = f"""
Previous attempts for this same assigned task are below. Use them only as continuity for this task:

```text
{previous_attempts}
```
"""

    global_text = ""
    if global_instructions:
        global_text = f"""
Global instructions from the TODO file apply to this task:

```markdown
{global_instructions}
```
"""

    return textwrap.dedent(
        f"""
        You are one Pi RPC worker session assigned to exactly one TODO task.

        Assigned TODO file path: `{todo_path}`
        Assigned task: `{task.label}`
        Attempt: {attempt}

        Rules:
        - Work only on the assigned task below. Do not start or fix other TODO tasks.
        - The coordinator is responsible for marking TODO progress. Do not edit `{todo_path}` unless it is directly necessary for the assigned task implementation itself.
        - Do not edit `TASK_RESULT.md`; the coordinator writes it.
        - {commit_text}
        - If you need to stop because context is high or the work is blocked, leave the repository in a safe state and report `status: partial` or `status: blocked`.
        - Use the repository's AGENTS.md/project instructions.
        - Run focused verification commands when practical.
        - Do not run bash commands with timeout greater than {max_bash_timeout:.0f} seconds. For long full-suite checks, run once with a bounded timeout and report any timeout/failure in TASK_RESULT instead of continuing indefinitely.
        - If TODO-file global instructions restrict scope, obey them strictly. If the task appears to require out-of-scope code changes, stop and report `status: blocked` instead of changing those files.

        {global_text}
        Assigned task content only:

        ```markdown
        {task.section.rstrip()}
        ```
        {previous_text}
        When you are finished, your final assistant message must end with this machine-readable block:

        TASK_RESULT:
        status: done|partial|blocked|failed
        summary: <short summary>
        changes:
        - <changed item or "none">
        verification:
        - <command/result or "not run">
        remaining:
        - <remaining item or "none">

        Only use `status: done` if the assigned task is fully complete and verified as far as practical.
        """
    ).strip()


def build_time_limit_message(seconds: float) -> str:
    return textwrap.dedent(
        f"""
        Coordinator notice: this worker session has reached its {seconds:.0f}s time budget.
        Stop after the current safe point. Do not start more implementation work.
        Finish with the required TASK_RESULT block now.
        Use `status: done` only if the assigned task is actually complete; otherwise use `status: partial`.
        """
    ).strip()


def build_shutdown_message(percent: float) -> str:
    return textwrap.dedent(
        f"""
        Coordinator notice: context usage is {percent:.1f}%, above the 85% shutdown threshold.
        Stop after the current safe point. Do not start more implementation work.
        Leave files in a safe state and finish with the required TASK_RESULT block.
        Use `status: done` only if the assigned task is actually complete; otherwise use `status: partial`.
        """
    ).strip()


def build_compaction_instructions(task: Task) -> str:
    return textwrap.dedent(
        f"""
        Keep only information needed to finish assigned task {task.label}: relevant files inspected,
        edits made, verification run, failures, and remaining steps. Drop unrelated details.
        """
    ).strip()


class PiRpcClient:
    def __init__(self, args: list[str], cwd: Path, verbose: bool = False) -> None:
        self.args = args
        self.cwd = cwd
        self.verbose = verbose
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.stdout_task: Optional[asyncio.Task[Any]] = None
        self.stderr_task: Optional[asyncio.Task[Any]] = None

    async def __aenter__(self) -> "PiRpcClient":
        self.proc = await asyncio.create_subprocess_exec(
            *self.args,
            cwd=str(self.cwd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self.stdout_task = asyncio.create_task(self._read_stdout())
        self.stderr_task = asyncio.create_task(self._read_stderr())
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    async def close(self) -> None:
        proc = self.proc
        if proc is None:
            return
        self.proc = None

        for future in self.pending.values():
            if not future.done():
                future.cancel()
        self.pending.clear()

        if proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError, RuntimeError, asyncio.TimeoutError):
                await asyncio.wait_for(proc.stdin.wait_closed(), timeout=1)

        if proc.returncode is None:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), timeout=1)

        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
        else:
            with contextlib.suppress(Exception):
                await proc.wait()

        reader_tasks = [task for task in [self.stdout_task, self.stderr_task] if task]
        if reader_tasks:
            done, pending = await asyncio.wait(reader_tasks, timeout=1)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                with contextlib.suppress(BaseException):
                    task.result()

        transport = getattr(proc, "_transport", None)
        if transport is not None:
            with contextlib.suppress(Exception):
                transport.close()

    async def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            raw = line.decode("utf-8", errors="replace").rstrip("\n")
            if raw.endswith("\r"):
                raw = raw[:-1]
            if not raw:
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                print(f"[pi-rpc non-json stdout] {raw}", file=sys.stderr)
                continue

            if message.get("type") == "response" and "id" in message:
                future = self.pending.pop(message["id"], None)
                if future and not future.done():
                    future.set_result(message)
            else:
                await self.events.put(message)

        for future in self.pending.values():
            if not future.done():
                future.set_exception(RpcError("Pi RPC stdout closed before a response was received"))
        self.pending.clear()
        await self.events.put({"type": "_process_stdout_end"})

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                print(f"[pi] {text}", file=sys.stderr)

    async def send(self, payload: dict[str, Any]) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise RpcError("Pi RPC process is not running")
        encoded = json.dumps(payload, ensure_ascii=False) + "\n"
        if self.verbose:
            print(f"[rpc ->] {payload.get('type')}", file=sys.stderr)
        self.proc.stdin.write(encoded.encode("utf-8"))
        await self.proc.stdin.drain()

    async def command(self, payload: dict[str, Any], timeout: Optional[float] = 120) -> dict[str, Any]:
        request_id = payload.get("id") or str(uuid.uuid4())
        payload = dict(payload)
        payload["id"] = request_id
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self.pending[request_id] = future
        if self.verbose:
            print(f"[rpc ->] {payload.get('type')} {request_id}", file=sys.stderr)
        await self.send(payload)
        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self.pending.pop(request_id, None)
            raise RpcError(f"Timed out waiting for response to {payload.get('type')}") from exc
        if self.verbose:
            print(f"[rpc <-] {response.get('command')} success={response.get('success')}", file=sys.stderr)
        return response

    async def wait_event(self, timeout: Optional[float] = None) -> dict[str, Any]:
        return await asyncio.wait_for(self.events.get(), timeout=timeout)

    async def returncode(self) -> Optional[int]:
        if self.proc is None:
            return None
        return self.proc.returncode


async def create_todo_markdown_with_pi(
    *,
    raw_todo: str,
    pi_args: list[str],
    cwd: Path,
    verbose: bool,
) -> str:
    print(f"[coordinator] Creating temporary TODO.md with Pi: {' '.join(shlex.quote(part) for part in pi_args)}", file=sys.stderr)
    assistant_text = ""
    async with PiRpcClient(pi_args, cwd, verbose=verbose) as client:
        try:
            await client.command({"type": "set_session_name", "name": "Create coordinator TODO"}, timeout=30)
        except Exception as exc:  # noqa: BLE001 - best-effort metadata only
            if verbose:
                print(f"[coordinator] set_session_name skipped for TODO creation: {exc}", file=sys.stderr)

        response = await client.command({"type": "prompt", "message": build_todo_creation_prompt(raw_todo)}, timeout=60)
        if not response.get("success"):
            raise RpcError(response.get("error") or "TODO creation prompt was rejected")

        while True:
            event = await client.wait_event(timeout=None)
            event_type = event.get("type")
            if event_type == "message_update":
                delta = event.get("assistantMessageEvent") or {}
                if delta.get("type") == "text_delta":
                    print(delta.get("delta", ""), end="", file=sys.stderr, flush=True)
            elif event_type == "message_end":
                message_text = assistant_message_text(event.get("message") or {})
                if message_text:
                    assistant_text = message_text
            elif event_type == "agent_end":
                event_text = last_assistant_text_from_messages(event.get("messages"))
                if event_text:
                    assistant_text = event_text
                print("", file=sys.stderr, flush=True)
                break
            elif event_type == "extension_ui_request":
                await handle_extension_ui_request(client, event)
            elif event_type == "_process_stdout_end":
                raise RpcError("Pi RPC process ended before TODO creation completed")

        try:
            last_text_response = await client.command({"type": "get_last_assistant_text"}, timeout=60)
            assistant_text = ((last_text_response.get("data") or {}).get("text")) or assistant_text
        except Exception as exc:  # noqa: BLE001 - use event-captured text if RPC metadata fails
            if verbose:
                print(f"[coordinator] get_last_assistant_text failed for TODO creation: {exc}", file=sys.stderr)

    markdown = extract_todo_markdown(assistant_text)
    validate_todo_markdown(markdown)
    return markdown


def build_todo_creation_prompt(raw_todo: str) -> str:
    fence = code_fence_for(raw_todo)
    return textwrap.dedent(
        f"""
        Convert the input request into a coordinator TODO markdown file.

        Output only the markdown file content. Do not wrap it in explanations.

        Required format:
        - A `# Pi Coordinator TODO` title.
        - A `## Progress` section with one checkbox line per task:
          `- [ ] TODO N — Short task title`
        - A horizontal rule.
        - One task section per task headed exactly:
          `## TODO N — Short task title`
        - Each task section must include:
          - `**Goal:**`
          - `**Status:**` followed by practical checkboxes
          - `**Steps:**` or task-specific details if useful
          - `**Verify:**` with concrete verification commands/steps where practical
          - `**Done when:**`
        - Split the request into independent tasks that can be run in separate Pi sessions.
        - Keep task boundaries small, but do not invent unrelated work.
        - Use only unchecked boxes.

        Input request:

        {fence}text
        {raw_todo.strip()}
        {fence}
        """
    ).strip()


def extract_todo_markdown(assistant_text: str) -> str:
    text = assistant_text.strip()
    fence_match = re.search(r"```(?:markdown|md)?\s*\n(?P<body>.*?)\n```", text, re.IGNORECASE | re.DOTALL)
    if fence_match:
        text = fence_match.group("body").strip()

    start_candidates = [
        text.find("# Pi Coordinator TODO"),
        text.find("## Progress"),
        text.find("## TODO"),
    ]
    starts = [index for index in start_candidates if index >= 0]
    if starts:
        text = text[min(starts) :].strip()

    return text.rstrip() + "\n"


def validate_todo_markdown(markdown: str) -> None:
    temp_path = Path(tempfile.mkdtemp(prefix="pi-todo-validate-")) / "TODO.md"
    write_text(temp_path, markdown)
    tasks = parse_tasks(temp_path)
    if not tasks:
        raise TodoParseError("Generated TODO markdown did not contain any tasks")
    if not any(ANY_PROGRESS_RE.match(line) for line in markdown.splitlines()):
        raise TodoParseError("Generated TODO markdown did not contain a progress checklist")


def cleanup_generated_todo_dir(generated_todo_dir: Optional[Path], keep: bool) -> None:
    if not generated_todo_dir:
        return
    if keep:
        print(f"[coordinator] Keeping generated TODO directory: {generated_todo_dir}", file=sys.stderr)
        return
    shutil.rmtree(generated_todo_dir, ignore_errors=True)
    print(f"[coordinator] Removed generated TODO directory: {generated_todo_dir}", file=sys.stderr)


async def run_pi_task(
    *,
    pi_args: list[str],
    cwd: Path,
    todo_path: Path,
    task: Task,
    attempt: int,
    commit_requested: bool,
    result_path: Path,
    verbose: bool,
    context_stats_timeout: float,
    task_timeout: float,
    max_bash_timeout: float,
) -> SessionOutcome:
    started_at = now_iso()
    context_observations: list[str] = []
    compaction_events: list[str] = []
    shutdown_requested = False
    assistant_text = ""
    reported_status = "unknown"
    session_file: Optional[str] = None
    error: Optional[str] = None
    deadline = time.monotonic() + task_timeout if task_timeout and task_timeout > 0 else None
    time_limit_requested = False
    next_idle_text_poll = 0.0

    prompt = build_task_prompt(
        todo_path=todo_path,
        task=task,
        attempt=attempt,
        commit_requested=commit_requested,
        previous_attempts=previous_attempts_for_task(result_path, task),
        global_instructions=todo_global_instructions(todo_path),
        max_bash_timeout=max_bash_timeout,
    )

    try:
        async with PiRpcClient(pi_args, cwd, verbose=verbose) as client:
            # Name the session when sessions are enabled. Ignore failures for --no-session or older Pi versions.
            try:
                await client.command({"type": "set_session_name", "name": f"{task.label} attempt {attempt}"}, timeout=30)
            except Exception as exc:  # noqa: BLE001 - best-effort metadata only
                if verbose:
                    print(f"[coordinator] set_session_name skipped: {exc}", file=sys.stderr)

            try:
                state = await client.command({"type": "get_state"}, timeout=30)
                if state.get("success"):
                    session_file = (state.get("data") or {}).get("sessionFile")
            except Exception as exc:  # noqa: BLE001 - non-fatal metadata fetch
                compaction_events.append(f"initial get_state failed: {exc}")

            response = await client.command({"type": "prompt", "message": prompt}, timeout=60)
            if not response.get("success"):
                raise RpcError(response.get("error") or "prompt was rejected")

            turn_count = 0
            current_assistant_text = ""
            task_result_seen = False
            running_bash = False
            while True:
                try:
                    event = await client.wait_event(timeout=5 if deadline is not None else None)
                except asyncio.TimeoutError:
                    now = time.monotonic()
                    if now >= next_idle_text_poll:
                        next_idle_text_poll = now + 15
                        try:
                            last_text_response = await client.command({"type": "get_last_assistant_text"}, timeout=5)
                            latest_text = ((last_text_response.get("data") or {}).get("text")) or ""
                            if latest_text:
                                assistant_text = latest_text
                        except Exception as exc:  # noqa: BLE001 - idle polling must not stop active workers
                            if verbose:
                                print(f"[coordinator] idle get_last_assistant_text unavailable: {exc}", file=sys.stderr)

                    if has_task_result_status(assistant_text):
                        context_observations.append("idle poll: TASK_RESULT status seen; finishing session")
                        print(
                            f"\n[coordinator] {task.label}: TASK_RESULT seen during idle poll; finishing session",
                            file=sys.stderr,
                        )
                        break
                    if deadline is not None and time.monotonic() >= deadline:
                        if running_bash:
                            shutdown_requested = True
                            try:
                                await client.command({"type": "abort_bash"}, timeout=10)
                                compaction_events.append(
                                    f"aborted running bash after task timeout {task_timeout:.0f}s"
                                )
                            except Exception as exc:  # noqa: BLE001
                                compaction_events.append(f"abort_bash after task timeout failed: {exc}")
                            running_bash = False
                        elif not time_limit_requested:
                            time_limit_requested = True
                            shutdown_requested = True
                            try:
                                steer_response = await client.command(
                                    {"type": "steer", "message": build_time_limit_message(task_timeout)}, timeout=30
                                )
                                compaction_events.append(
                                    f"requested graceful shutdown after {task_timeout:.0f}s idle wait "
                                    f"(success={steer_response.get('success')})"
                                )
                            except Exception as exc:  # noqa: BLE001
                                compaction_events.append(f"time-limit shutdown request failed: {exc}")
                        else:
                            error = f"task exceeded {task_timeout:.0f}s after graceful shutdown request"
                            try:
                                await client.command({"type": "abort"}, timeout=10)
                            except Exception as exc:  # noqa: BLE001
                                compaction_events.append(f"abort after task timeout failed: {exc}")
                            break
                    continue

                event_type = event.get("type")

                if event_type == "message_start":
                    if (event.get("message") or {}).get("role") == "assistant":
                        current_assistant_text = ""

                elif event_type == "message_update":
                    delta = (event.get("assistantMessageEvent") or {})
                    if delta.get("type") == "text_delta":
                        text_delta = delta.get("delta", "")
                        current_assistant_text += text_delta
                        assistant_text = current_assistant_text or assistant_text
                        if has_task_result(current_assistant_text):
                            task_result_seen = True
                        print(text_delta, end="", file=sys.stderr, flush=True)

                elif event_type == "message_end":
                    message_text = assistant_message_text(event.get("message") or {})
                    if message_text:
                        assistant_text = message_text
                        task_result_seen = task_result_seen or has_task_result(message_text)
                        if has_task_result_status(message_text):
                            context_observations.append("message_end: TASK_RESULT status seen; finishing session")
                            print(
                                f"\n[coordinator] {task.label}: TASK_RESULT seen at message_end; finishing session",
                                file=sys.stderr,
                            )
                            break

                elif event_type == "turn_end":
                    turn_count += 1
                    message_text = assistant_message_text(event.get("message") or {})
                    if message_text:
                        assistant_text = message_text
                        task_result_seen = task_result_seen or has_task_result(message_text)
                    if task_result_seen or has_task_result(assistant_text):
                        context_observations.append(f"turn {turn_count}: skipped context stats after TASK_RESULT")
                        print(
                            f"\n[coordinator] {task.label} turn {turn_count}: TASK_RESULT seen; finishing session",
                            file=sys.stderr,
                        )
                        break

                    if deadline is not None and time.monotonic() >= deadline:
                        if not time_limit_requested:
                            time_limit_requested = True
                            shutdown_requested = True
                            try:
                                steer_response = await client.command(
                                    {"type": "steer", "message": build_time_limit_message(task_timeout)}, timeout=30
                                )
                                compaction_events.append(
                                    f"turn {turn_count}: requested graceful shutdown after {task_timeout:.0f}s "
                                    f"(success={steer_response.get('success')})"
                                )
                            except Exception as exc:  # noqa: BLE001 - non-fatal shutdown request
                                compaction_events.append(
                                    f"turn {turn_count}: time-limit shutdown request failed: {exc}"
                                )
                        else:
                            error = f"task exceeded {task_timeout:.0f}s after graceful shutdown request"
                            try:
                                await client.command({"type": "abort"}, timeout=10)
                            except Exception as exc:  # noqa: BLE001
                                compaction_events.append(f"abort after task timeout failed: {exc}")
                            break

                    percent, stats_note = await safe_context_percent(client, timeout=context_stats_timeout)
                    if percent is None:
                        context_observations.append(f"turn {turn_count}: {stats_note}")
                        print(
                            f"\n[coordinator] {task.label} turn {turn_count}: {stats_note}; continuing",
                            file=sys.stderr,
                        )
                        continue

                    context_observations.append(f"turn {turn_count}: {percent:.1f}%")
                    print(f"\n[coordinator] {task.label} turn {turn_count}: context {percent:.1f}%", file=sys.stderr)

                    if percent >= 85 and not shutdown_requested:
                        shutdown_requested = True
                        try:
                            steer_response = await client.command(
                                {"type": "steer", "message": build_shutdown_message(percent)}, timeout=30
                            )
                            ok = steer_response.get("success")
                            compaction_events.append(
                                f"turn {turn_count}: requested graceful shutdown at {percent:.1f}% (success={ok})"
                            )
                        except Exception as exc:  # noqa: BLE001 - non-fatal context management
                            compaction_events.append(
                                f"turn {turn_count}: graceful shutdown request at {percent:.1f}% failed: {exc}"
                            )
                    elif percent >= 70:
                        try:
                            compact_response = await client.command(
                                {
                                    "type": "compact",
                                    "customInstructions": build_compaction_instructions(task),
                                },
                                timeout=180,
                            )
                            if compact_response.get("success"):
                                tokens_before = ((compact_response.get("data") or {}).get("tokensBefore"))
                                compaction_events.append(
                                    f"turn {turn_count}: compacted at {percent:.1f}%"
                                    + (f"; tokensBefore={tokens_before}" if tokens_before is not None else "")
                                )
                            else:
                                compaction_events.append(
                                    f"turn {turn_count}: compaction requested at {percent:.1f}% but failed: "
                                    f"{compact_response.get('error', 'unknown error')}"
                                )
                        except Exception as exc:  # noqa: BLE001 - non-fatal context management
                            compaction_events.append(
                                f"turn {turn_count}: compaction request at {percent:.1f}% failed: {exc}"
                            )

                elif event_type == "tool_execution_start":
                    if event.get("toolName") == "bash":
                        running_bash = True
                        args = event.get("args") or {}
                        requested_timeout = args.get("timeout")
                        try:
                            requested_timeout_value = float(requested_timeout) if requested_timeout is not None else None
                        except (TypeError, ValueError):
                            requested_timeout_value = None
                        if deadline is not None and time.monotonic() >= deadline:
                            compaction_events.append(
                                f"aborted bash command because task timeout {task_timeout:.0f}s was already reached"
                            )
                            try:
                                await client.command({"type": "abort_bash"}, timeout=10)
                            except Exception as exc:  # noqa: BLE001 - non-fatal tool guard
                                compaction_events.append(f"abort_bash after task timeout failed: {exc}")
                        elif requested_timeout_value is not None and requested_timeout_value > max_bash_timeout:
                            command = str(args.get("command") or "")
                            compaction_events.append(
                                f"aborted bash command with timeout {requested_timeout_value:.0f}s "
                                f"> max {max_bash_timeout:.0f}s: {command[:160]}"
                            )
                            try:
                                await client.command({"type": "abort_bash"}, timeout=10)
                            except Exception as exc:  # noqa: BLE001 - non-fatal tool guard
                                compaction_events.append(f"abort_bash failed: {exc}")

                elif event_type == "tool_execution_end":
                    if event.get("toolName") == "bash":
                        running_bash = False

                elif event_type == "compaction_end":
                    reason = event.get("reason", "unknown")
                    aborted = event.get("aborted", False)
                    if event.get("result"):
                        tokens_before = event["result"].get("tokensBefore")
                        compaction_events.append(
                            f"compaction_end reason={reason} aborted={aborted} tokensBefore={tokens_before}"
                        )
                    else:
                        compaction_events.append(
                            f"compaction_end reason={reason} aborted={aborted} error={event.get('errorMessage')}"
                        )

                elif event_type == "agent_end":
                    event_text = last_assistant_text_from_messages(event.get("messages"))
                    if event_text:
                        assistant_text = event_text
                    print("", file=sys.stderr, flush=True)
                    break

                elif event_type == "extension_ui_request":
                    await handle_extension_ui_request(client, event)

                elif event_type == "_process_stdout_end":
                    raise RpcError("Pi RPC process ended before agent_end")

                elif event_type == "extension_error":
                    compaction_events.append(f"extension_error: {event.get('error')}")

            if not has_task_result(assistant_text):
                try:
                    last_text_response = await client.command({"type": "get_last_assistant_text"}, timeout=30)
                    assistant_text = ((last_text_response.get("data") or {}).get("text")) or assistant_text
                except Exception as exc:  # noqa: BLE001
                    compaction_events.append(f"get_last_assistant_text failed: {exc}")

            try:
                state = await client.command({"type": "get_state"}, timeout=30)
                if state.get("success"):
                    session_file = (state.get("data") or {}).get("sessionFile") or session_file
            except Exception as exc:  # noqa: BLE001 - non-fatal metadata fetch
                compaction_events.append(f"final get_state failed: {exc}")

            pi_exit_code = await client.returncode()

    except Exception as exc:  # noqa: BLE001 - coordinator must summarize failures
        error = str(exc)
        pi_exit_code = None

    if error and not has_task_result(assistant_text):
        assistant_text = textwrap.dedent(
            f"""
            TASK_RESULT:
            status: partial
            summary: Coordinator stopped the session before the worker produced a final result.
            changes:
            - unknown; inspect git diff and session file
            verification:
            - not completed by worker
            remaining:
            - Coordinator/session error: {error}
            """
        ).strip()

    reported_status = parse_reported_status(assistant_text)
    ended_at = now_iso()
    return SessionOutcome(
        task=task,
        attempt=attempt,
        started_at=started_at,
        ended_at=ended_at,
        reported_status=reported_status,
        assistant_text=assistant_text,
        session_file=session_file,
        context_observations=context_observations,
        compaction_events=compaction_events,
        shutdown_requested=shutdown_requested,
        pi_exit_code=pi_exit_code,
        error=error,
    )


async def handle_extension_ui_request(client: PiRpcClient, event: dict[str, Any]) -> None:
    """Auto-cancel extension UI dialogs in headless mode, ignore notifications."""
    method = event.get("method")
    request_id = event.get("id")
    if not request_id:
        return
    if method in {"select", "input", "editor"}:
        await client.send({"type": "extension_ui_response", "id": request_id, "cancelled": True})
    elif method == "confirm":
        await client.send({"type": "extension_ui_response", "id": request_id, "confirmed": False})


async def safe_context_percent(client: PiRpcClient, timeout: float = 15) -> tuple[Optional[float], str]:
    """Best-effort context usage check that never aborts the worker session."""
    try:
        stats_response = await client.command({"type": "get_session_stats"}, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - context checks must be non-fatal
        return None, f"context stats unavailable ({exc})"

    percent = extract_context_percent(stats_response)
    if percent is None:
        if not stats_response.get("success"):
            return None, f"context stats unavailable ({stats_response.get('error', 'unknown error')})"
        return None, "context usage unavailable"
    return percent, f"{percent:.1f}%"


def extract_context_percent(stats_response: dict[str, Any]) -> Optional[float]:
    if not stats_response.get("success"):
        return None
    data = stats_response.get("data") or {}
    usage = data.get("contextUsage") or {}
    percent = usage.get("percent")
    if percent is None:
        return None
    try:
        return float(percent)
    except (TypeError, ValueError):
        return None


def git_root(cwd: Path) -> Optional[Path]:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(cwd),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
    except subprocess.CalledProcessError:
        return None
    return Path(result.stdout.strip()).resolve()


def rel_to_root(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root))
    except ValueError:
        return str(path)


def git_dirty_paths(cwd: Path, *exclude_paths: Path) -> set[str]:
    root = git_root(cwd)
    if root is None:
        return set()
    excluded = {rel_to_root(path, root) for path in exclude_paths}
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=str(root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
    except subprocess.CalledProcessError:
        return set()

    dirty: set[str] = set()
    entries = result.stdout.decode("utf-8", errors="replace").split("\0")
    for entry in entries:
        if not entry:
            continue
        path = entry[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        if path and path not in excluded:
            dirty.add(path)
    return dirty


def unstage_paths(root: Path, paths: set[str]) -> None:
    if not paths:
        return
    path_list = sorted(paths)
    for command in (["git", "restore", "--staged", "--"], ["git", "reset", "--"]):
        subprocess.run(
            [*command, *path_list],
            cwd=str(root),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )


def should_commit_outcome(outcome: SessionOutcome) -> bool:
    if outcome.error:
        return False
    status = outcome.reported_status.lower()
    return status in {"done", "complete", "completed", "success", "succeeded", "partial", "blocked"}


def commit_after_session(
    cwd: Path,
    result_path: Path,
    outcome: SessionOutcome,
    pre_existing_dirty_paths: Optional[set[str]] = None,
) -> tuple[Optional[str], Optional[str]]:
    root = git_root(cwd)
    if root is None:
        return None, "not inside a git repository"

    result_rel = rel_to_root(result_path, root)
    message_prefix = "Complete" if outcome.done else "Progress"
    commit_message = f"{message_prefix} {outcome.task.label}"

    try:
        subprocess.run(["git", "add", "-A"], cwd=str(root), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # Never commit TASK_RESULT.md, even if it was already tracked. Also avoid
        # committing files that were already dirty before this worker session.
        excluded_paths = {result_rel}
        excluded_paths.update(pre_existing_dirty_paths or set())
        unstage_paths(root, excluded_paths)

        diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(root))
        if diff.returncode == 0:
            return None, None

        commit = subprocess.run(
            ["git", "commit", "-m", commit_message],
            cwd=str(root),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        rev = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(root),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return rev.stdout.strip(), None
    except subprocess.CalledProcessError as exc:
        return None, (exc.stderr or exc.stdout or str(exc)).strip()


def build_pi_args(args: argparse.Namespace) -> list[str]:
    return build_rpc_args(
        pi_cmd=args.pi_cmd,
        provider=args.provider,
        model=args.model,
        thinking=args.thinking,
        no_session=args.no_session,
        session_dir=args.session_dir,
        extra_args=args.pi_arg or [],
    )


def build_todo_pi_args(args: argparse.Namespace) -> list[str]:
    return build_rpc_args(
        pi_cmd=args.pi_cmd,
        provider=args.todo_provider or args.provider,
        model=args.todo_model or args.model,
        thinking=args.todo_thinking,
        no_session=True,
        session_dir=args.session_dir,
        extra_args=args.todo_pi_arg or args.pi_arg or [],
    )


def build_rpc_args(
    *,
    pi_cmd: str,
    provider: Optional[str],
    model: Optional[str],
    thinking: Optional[str],
    no_session: bool,
    session_dir: Optional[str],
    extra_args: list[str],
) -> list[str]:
    pi_args = [pi_cmd, "--mode", "rpc"]
    if provider:
        pi_args += ["--provider", provider]
    if model:
        pi_args += ["--model", model]
    if thinking:
        pi_args += ["--thinking", thinking]
    if no_session:
        pi_args.append("--no-session")
    if session_dir:
        pi_args += ["--session-dir", session_dir]
    for extra in extra_args:
        pi_args += shlex.split(extra)
    return pi_args


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one fresh Pi RPC session per TODO.md task until all tasks are checked off.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "todo_input",
        help=(
            "Existing TODO markdown file path, raw TODO/task string, or '-' to read a raw string from stdin. "
            "Raw strings are converted into a temporary TODO.md."
        ),
    )
    parser.add_argument(
        "--input-mode",
        choices=["auto", "file", "string"],
        default="auto",
        help="How to interpret todo_input. Auto uses an existing path as a file, otherwise a raw string.",
    )
    parser.add_argument(
        "--generated-todo-parent",
        type=Path,
        default=None,
        help="Parent directory for TODO.md generated from string input. Defaults to ./tmp.",
    )
    parser.add_argument(
        "--keep-generated-todo",
        action="store_true",
        help="Keep the temporary TODO.md directory after generated-string tasks complete.",
    )
    parser.add_argument(
        "--commit",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Commit after each session. TASK_RESULT.md is never staged or committed.",
    )
    parser.add_argument("--result-file", type=Path, default=None, help="Summary file path")
    parser.add_argument("--pi-cmd", default="pi", help="Pi executable")
    parser.add_argument("--provider", default=None, help="Pi provider option for task sessions")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Pi model option for task sessions")
    parser.add_argument("--thinking", default=DEFAULT_TASK_THINKING, help="Pi thinking level for task sessions")
    parser.add_argument("--todo-provider", default=None, help="Pi provider option for TODO creation from string input")
    parser.add_argument(
        "--todo-model",
        default=None,
        help="Pi model option for TODO creation from string input. Defaults to --model.",
    )
    parser.add_argument(
        "--todo-thinking",
        default=DEFAULT_TODO_THINKING,
        help="Pi thinking level for TODO creation from string input.",
    )
    parser.add_argument("--no-session", action="store_true", help="Pass --no-session to Pi")
    parser.add_argument("--session-dir", default=None, help="Pass --session-dir to Pi")
    parser.add_argument(
        "--pi-arg",
        action="append",
        default=[],
        help="Additional shell-split argument(s) for task Pi sessions. May be repeated.",
    )
    parser.add_argument(
        "--todo-pi-arg",
        action="append",
        default=[],
        help="Additional shell-split argument(s) for TODO-creation Pi session. Defaults to --pi-arg when omitted.",
    )
    parser.add_argument(
        "--max-attempts-per-task",
        type=int,
        default=3,
        help="Stop if a task is not done after this many attempts. Use 0 for unlimited.",
    )
    parser.add_argument(
        "--context-stats-timeout",
        type=float,
        default=10.0,
        help="Seconds to wait for each best-effort context usage check before continuing.",
    )
    parser.add_argument(
        "--task-timeout",
        type=float,
        default=900.0,
        help="Per-task wall-clock seconds before requesting a graceful TASK_RESULT shutdown. Use 0 to disable.",
    )
    parser.add_argument(
        "--max-bash-timeout",
        type=float,
        default=300.0,
        help="Abort model-requested bash tool calls whose declared timeout exceeds this many seconds.",
    )
    parser.add_argument("--verbose", action="store_true", help="Verbose RPC logging")
    return parser.parse_args(argv)


async def async_main(argv: list[str]) -> int:
    args = parse_args(argv)
    cwd = Path.cwd().resolve()
    try:
        todo_path, generated_todo, generated_todo_dir = await resolve_todo_input(args, cwd)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    result_path = (
        args.result_file.resolve()
        if args.result_file
        else (cwd / "TASK_RESULT.md" if generated_todo else todo_path.parent / "TASK_RESULT.md")
    )
    pi_args = build_pi_args(args)

    print(f"[coordinator] TODO file: {todo_path}", file=sys.stderr)
    if generated_todo:
        print(f"[coordinator] Created temporary TODO.md from input string in: {todo_path.parent}", file=sys.stderr)
    print(f"[coordinator] Result file: {result_path}", file=sys.stderr)
    print(f"[coordinator] Commit mode: {args.commit}", file=sys.stderr)
    print(f"[coordinator] Pi command: {' '.join(shlex.quote(part) for part in pi_args)}", file=sys.stderr)

    attempts: dict[str, int] = {}

    while True:
        tasks = incomplete_tasks(todo_path)
        if not tasks:
            final = read_text(result_path) if result_path.exists() else "# Task Results\n\nNo sessions were needed.\n"
            print(final)
            cleanup_generated_todo_dir(generated_todo_dir, args.keep_generated_todo)
            return 0

        task = tasks[0]
        attempts[task.task_id] = attempts.get(task.task_id, 0) + 1
        attempt = attempts[task.task_id]
        if args.max_attempts_per_task and attempt > args.max_attempts_per_task:
            message = (
                f"Task {task.label} exceeded max attempts ({args.max_attempts_per_task}). "
                "Stopping to avoid an infinite loop."
            )
            print(f"[coordinator] {message}", file=sys.stderr)
            append_task_result(
                result_path,
                SessionOutcome(
                    task=task,
                    attempt=attempt,
                    started_at=now_iso(),
                    ended_at=now_iso(),
                    reported_status="failed",
                    assistant_text=message,
                    session_file=None,
                    context_observations=[],
                    compaction_events=[],
                    shutdown_requested=False,
                    error=message,
                ),
            )
            print(read_text(result_path))
            if generated_todo_dir:
                print(
                    f"[coordinator] Leaving generated TODO directory for inspection: {generated_todo_dir}",
                    file=sys.stderr,
                )
            return 1

        pre_existing_dirty_paths = git_dirty_paths(cwd, result_path) if args.commit else set()
        if pre_existing_dirty_paths and args.commit:
            print(
                "[coordinator] Commit mode: will not include files that were already dirty before this session: "
                + ", ".join(sorted(pre_existing_dirty_paths)),
                file=sys.stderr,
            )

        print(f"[coordinator] Starting {task.label} (attempt {attempt})", file=sys.stderr)
        outcome = await run_pi_task(
            pi_args=pi_args,
            cwd=cwd,
            todo_path=todo_path,
            task=task,
            attempt=attempt,
            commit_requested=args.commit,
            result_path=result_path,
            verbose=args.verbose,
            context_stats_timeout=args.context_stats_timeout,
            task_timeout=args.task_timeout,
            max_bash_timeout=args.max_bash_timeout,
        )

        if outcome.done:
            mark_task_done(todo_path, task.task_id)
            # Refresh the task snapshot for accurate result/commit labels after marking done.
            refreshed = next((candidate for candidate in parse_tasks(todo_path) if candidate.task_id == task.task_id), task)
            outcome.task = refreshed

        append_task_result(result_path, outcome)

        if args.commit:
            if should_commit_outcome(outcome):
                commit_hash, commit_error = commit_after_session(cwd, result_path, outcome, pre_existing_dirty_paths)
                outcome.commit_hash = commit_hash
                outcome.commit_error = commit_error
                if commit_hash or commit_error:
                    with result_path.open("a", encoding="utf-8") as result_file:
                        result_file.write("\n### Commit note\n\n")
                        if commit_hash:
                            result_file.write(f"Committed non-result changes as `{commit_hash}`.\n")
                        if commit_error:
                            result_file.write(f"Commit error: `{commit_error}`\n")
            else:
                with result_path.open("a", encoding="utf-8") as result_file:
                    result_file.write("\n### Commit note\n\n")
                    result_file.write(
                        "Skipped commit because the session did not finish with a successful "
                        "machine-readable TASK_RESULT status.\n"
                    )

        if outcome.error:
            print(f"[coordinator] Session error for {task.label}: {outcome.error}", file=sys.stderr)
        print(f"[coordinator] Finished {task.label}: {outcome.reported_status}", file=sys.stderr)


def main() -> int:
    try:
        return asyncio.run(async_main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        return 130
    except (TodoParseError, RpcError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
