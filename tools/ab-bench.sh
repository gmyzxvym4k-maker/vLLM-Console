#!/bin/bash
# A/B 统一基准：ab-bench.sh <tag>  → /home/ll/deploy/bench-<tag>.txt
TAG=$1
OUT=/home/ll/deploy/bench-$TAG.txt
B=http://127.0.0.1:18420
{
echo "TAG=$TAG $(date '+%F %T')"
echo "== metrics snapshot(before) =="
curl -s --max-time 5 $B/metrics | grep -E '^vllm:(prefix_cache_(hits|queries)_total|spec_decode_num_(drafts|draft_tokens|accepted_tokens)_total|generation_tokens_total|prompt_tokens_total)' | head -20
for ctx in 32768 131072 262144; do
  echo "== bench ctx=$ctx out=512 =="
  python3 /home/ll/deploy/fnx-bench.py --base $B --ctx $ctx --out 512 --timeout 1800 2>&1
done
echo "== quality probe (标点复述) =="
curl -s --max-time 180 $B/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-flash-next","messages":[{"role":"user","content":"请把下面这句话原样复述一遍，注意保留所有标点：今天，气温26℃；小明说：“我们要么现在走，要么等雨停——总之不能拖了。”"}],"max_tokens":2048,"temperature":0.3}' \
  | python3 -c "import json,sys
d=json.load(sys.stdin)
m=d['choices'][0]['message']
print('CONTENT:', (m.get('content') or '')[:400])
print('REASONING_HEAD:', (m.get('reasoning_content') or '')[:150])" 2>&1
echo "== metrics snapshot(after) =="
curl -s --max-time 5 $B/metrics | grep -E '^vllm:(prefix_cache_(hits|queries)_total|spec_decode_num_(drafts|draft_tokens|accepted_tokens)_total)' | head -12
echo DONE
} > "$OUT" 2>&1
