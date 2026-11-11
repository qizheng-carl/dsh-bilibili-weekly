#!/bin/bash
# 每周认知盲区简报 —— 编排脚本
#   1. 增量采集会话（只取上次之后有更新的）
#   2. 输出待分析素材，交给 DSH 会话做分析
#   3. 结果由调用方（DSH 定时任务）写入 ~/Documents/cognitive-brief/briefs/
set -euo pipefail

TOOLS="$HOME/dev/proj-plugin/tools"
KB="$HOME/Documents/cognitive-brief"
STAMP=$(date +%Y-%m-%d)
STAGE="$KB/state/inbox-$STAMP"

mkdir -p "$KB/briefs" "$KB/state" "$KB/logs"
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "[1/2] 采集会话..."
python3 "$TOOLS/collect-sessions.py" --outdir "$STAGE" > "$KB/logs/collect-$STAMP.log" 2>&1
cat "$KB/logs/collect-$STAMP.log"

N=$(python3 -c "
import json,glob
try:
    d=json.load(open('$STAGE/_summary.json'))
    print(d['sessions'])
except Exception:
    print(0)
")

if [ "$N" -eq 0 ]; then
  echo "[2/2] 本周无新增会话，跳过分析。"
  rm -rf "$STAGE"
  exit 0
fi

echo "[2/2] 待分析素材已就绪：$STAGE"
echo "      会话数 $N"
echo
echo "下一步：让 DSH 会话按以下提示词分析 $STAGE 下的 .txt 文件，"
echo "        结果写入 $KB/briefs/$STAMP-weekly.md"
echo "        提示词：$TOOLS/analyze-brief.md"
ls -S "$STAGE"/*.txt 2>/dev/null | head -5 | xargs -n1 basename 2>/dev/null
