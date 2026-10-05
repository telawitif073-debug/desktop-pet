#!/usr/bin/env bash
# 部署验证：登录 → 同步数据解密 → 智能体资源文件
set -euo pipefail
B=http://127.0.0.1/api

TOKEN=$(curl -s -m 8 -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"identifier":"synctest","password":"sync-test-123"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')
echo "login: token ok (${#TOKEN} chars)"

curl -s -m 8 $B/sync/config -H "Authorization: Bearer $TOKEN" | python3 -c '
import json,sys
d=json.load(sys.stdin)
c=d.get("config") or {}
profs=c.get("llmProfiles") or []
print("sync/config: profiles=%d, agent=%s" % (len(profs), bool(c.get("installedAgentConfig"))))
k=(profs[0].get("key","") if profs else "")
print("first profile key decrypted:", k[:6] + "..." if k else "(empty)")'

curl -s -m 8 $B/agents | python3 -c '
import json,sys
d=json.load(sys.stdin)
agents=d if isinstance(d,list) else d.get("items") or []
print("agents:", len(agents))
if agents:
    a=agents[0]
    print("first agent fileUrl:", a.get("fileUrl"))' > /tmp/agents.out
cat /tmp/agents.out
URL=$(grep -o 'http[^ ]*' /tmp/agents.out | head -1)
if [ -n "$URL" ]; then
  REL=${URL#*uploads/}
  curl -s -o /dev/null -w "asset download: %{http_code} %{size_download}\n" "$B/../uploads/$REL" || true
fi
