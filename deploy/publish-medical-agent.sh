#!/bin/bash
# 发布「医疗管家」智能体到云端商店（postgres 直插 + 已上传的配置包）
set -e
set -a; . /opt/pet/backend/.env; set +a
export PGPASSWORD="$DB_PASSWORD"
PSQL="psql -h 127.0.0.1 -U postgres -d desktop_pet_platform"

echo "--- 现有用户（取 author_id 用）---"
$PSQL -tAc "SELECT id || ' ' || username || ' ' || role FROM users ORDER BY created_at LIMIT 10;"

AUTHOR=$($PSQL -tAc "SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1;")
[ -n "$AUTHOR" ] || AUTHOR=$($PSQL -tAc "SELECT id FROM users ORDER BY created_at LIMIT 1;")
echo "author_id = $AUTHOR"

CFG=$(jq -c '{name, kind, version, domainTags, role, style, greeting, exampleQuestions, systemPrompt}' /opt/pet/backend/uploads/agent-medical.json)

$PSQL <<SQL
INSERT INTO agent_assets (
  name, description, author_id, type, config_schema, dependencies, file_url,
  preview_url, version, downloads, rating, status, created_at, updated_at
) VALUES (
  '医疗管家',
  '宠物医疗健康管家：症状护理、用药与剂量参考、疫苗/驱虫/复诊日程提醒；实时感知当前日期时间，紧急危险信号引导就医。',
  '$AUTHOR',
  'chat',
  '$CFG'::jsonb,
  '[]'::jsonb,
  '/uploads/agent-medical.json',
  NULL, '1.0.0', 0, 0, 'approved', now(), now()
) RETURNING id;
SQL