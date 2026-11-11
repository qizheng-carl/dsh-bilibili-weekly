#!/usr/bin/env python3
"""把 DSH 会话日志（.jsonl.zstd）清洗成纯对话文本。

只保留 user/message 与 assistant/message 的 text 部分；
丢掉 tool-call / tool-result / 运行时上下文注入。

用法：
  python3 tools/extract-dialogue.py <会话目录> [-o 输出.txt]
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

NOISE_PREFIXES = (
    "Current runtime context.",
    "Current working directory:",
    "<system-reminder>",
    "Browser time zone",
)


def clean(text: str) -> str:
    if not text:
        return ""
    for marker in ("\n\nCurrent runtime context.", "\nCurrent runtime context."):
        idx = text.find(marker)
        if idx > 0:
            text = text[:idx]
    text = "\n".join(l for l in text.splitlines()
                     if not any(l.startswith(p) for p in NOISE_PREFIXES))
    return text.strip()


def texts(content) -> list:
    out = []
    for part in content or []:
        if isinstance(part, dict) and part.get("type") == "text":
            t = clean(part.get("text", ""))
            if t:
                out.append(t)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()

    src = args.session_dir / "session.v4.jsonl.zstd"
    if not src.exists():
        sys.exit(f"找不到 {src}")

    raw = subprocess.run(["zstd", "-dc", str(src)],
                         capture_output=True, check=True).stdout.decode("utf-8", "replace")

    lines, title = [], None
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type")
        data = ev.get("data") or {}
        if t == "session/title":
            title = title or data.get("title")
        elif t == "user/message":
            if (data.get("source") or {}).get("kind") != "user":
                continue
            for chunk in texts(data.get("content")):
                lines.append(f"## 用户\n\n{chunk}\n")
        elif t == "assistant/message":
            for chunk in texts((data.get("message") or {}).get("content")):
                lines.append(f"### 助手\n\n{chunk}\n")

    out = args.output or (args.session_dir / "dialogue.txt")
    body = f"# 会话：{title or args.session_dir.name}\n\n" + "\n".join(lines)
    out.write_text(body, encoding="utf-8")

    print(f"输出 {out}")
    print(f"用户条目 {body.count('## 用户')} · 助手条目 {body.count('### 助手')} · {len(body):,} 字符")


if __name__ == "__main__":
    main()
