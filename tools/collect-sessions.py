#!/usr/bin/env python3
"""扫描全部 DSH 会话，按增量筛选后输出待分析素材。

- 状态文件记录每个会话上次分析时的时间戳
- 只输出「有新增发言」的会话
- 产物：一个 JSON（元数据）+ 每个工作区一份纯对话文本
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SESSIONS = Path.home() / ".dsh" / "sessions"
STATE = Path.home() / "Documents" / "cognitive-brief" / "state" / "analyzed.json"


def decode(path: Path) -> str:
    if not path.exists():
        return ""
    r = subprocess.run(["zstd", "-dc", str(path)], capture_output=True)
    return r.stdout.decode("utf-8", "replace")


def workspace_of(dirname: str) -> str:
    """--Users-x-dev-proj-3d-- -> /Users/x/dev/proj_3d 的可读近似。"""
    s = dirname.strip("-")
    s = s.replace("~0020", " ").replace("-", "/")
    return "/" + s if s else s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", type=Path, required=True)
    ap.add_argument("--full", action="store_true", help="忽略增量状态，全量分析")
    args = ap.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)

    seen = {}
    if STATE.exists() and not args.full:
        seen = json.loads(STATE.read_text(encoding="utf-8"))

    picked, meta = {}, []
    for wsdir in sorted(SESSIONS.iterdir()):
        if not wsdir.is_dir():
            continue
        chunks = []
        for sdir in sorted(wsdir.iterdir()):
            src = sdir / "session.v4.jsonl.zstd"
            if not src.is_file():
                continue
            key = f"{wsdir.name}/{sdir.name}"
            mtime = src.stat().st_mtime
            if key in seen and mtime <= seen[key]:
                continue  # 上次分析后无更新

            raw = decode(src)
            title, lines = None, []
            for line in raw.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t, data = ev.get("type"), ev.get("data") or {}
                if t == "session/title":
                    title = title or data.get("title")
                elif t == "user/message":
                    if (data.get("source") or {}).get("kind") != "user":
                        continue
                    for p in data.get("content") or []:
                        if isinstance(p, dict) and p.get("type") == "text":
                            txt = p.get("text", "")
                            # 子 agent 派发提示：不是用户本人说的话
                            # 子 agent 派发提示：不是用户本人说的话
                            _dispatch = (
                                "Your parent agent id is" in txt
                                or txt.startswith(("You are researching", "你是一名", "你是一个", "你在分析", "你要为"))
                                or txt.startswith(("中文撰写，按", "每节包含", "每节给出", "严格区分", "只报告", "查不到", "输出为 Markdown", "全部用中文"))
                            )
                            if _dispatch:
                                continue
                            cut = txt.find("\n\nCurrent runtime context.")
                            if cut > 0:
                                txt = txt[:cut]
                            txt = "\n".join(
                                l for l in txt.splitlines()
                                if not l.startswith(("Current runtime context.",
                                                     "Current working directory:",
                                                     "<system-reminder>",
                                                     "Browser time zone",
                                                     "[Channel context",
                                                     "[DeepSeek Harness",
                                                     "channel:", "tenant:",
                                                     "chat_type:", "scope:",
                                                     "bridge_profile:", "adapter:",
                                                     "available_channel_tools:",
                                                     "language_policy:", "per-viewer", "plain=bilingual"))) 
                            if txt.strip():
                                lines.append(txt.strip())
                                meta.append({"ws": wsdir.name, "session": sdir.name,
                                             "title": title, "mtime": mtime})
            if lines:
                if title and "Channel context" in title:
                    title = None
                chunks.append(f"\n### 会话：{title or sdir.name}\n\n"
                              + "\n\n".join(f"- {l}" for l in lines))
        if chunks:
            name = wsdir.name
            (args.outdir / f"{name}.txt").write_text(
                f"# 工作区 {workspace_of(name)}\n" + "\n".join(chunks), encoding="utf-8")
            picked[name] = len(chunks)

    # 存状态
    seen.update({f"{m['ws']}/{m['session']}": m["mtime"] for m in meta})
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(seen, indent=1), encoding="utf-8")

    summary = {"generatedAt": datetime.now(timezone.utc).isoformat(),
               "workspaces": picked, "sessions": len(meta)}
    (args.outdir / "_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1),
                                               encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
