#!/bin/bash
# Copy non-TS assets to lib directory after build

# Copy auth credentials for each agent
for dir in src/agents/*/auth/; do
  agent_name=$(basename "$(dirname "$dir")")
  mkdir -p "lib/agents/${agent_name}/auth"
  cp "${dir}"*.json "lib/agents/${agent_name}/auth/" 2>/dev/null || true
done

# Copy SKILL.md files
for dir in src/agents/calendar/skills/*/; do
  skill_name=$(basename "$dir")
  if [ -f "${dir}SKILL.md" ]; then
    mkdir -p "lib/agents/calendar/skills/${skill_name}"
    cp "${dir}SKILL.md" "lib/agents/calendar/skills/${skill_name}/"
  fi
done

for dir in src/agents/drive/skills/*/; do
  skill_name=$(basename "$dir")
  if [ -f "${dir}SKILL.md" ]; then
    mkdir -p "lib/agents/drive/skills/${skill_name}"
    cp "${dir}SKILL.md" "lib/agents/drive/skills/${skill_name}/"
  fi
done

# Copy shared SKILL.md files
for dir in src/skills/shared/*/; do
  skill_name=$(basename "$dir")
  if [ -f "${dir}SKILL.md" ]; then
    mkdir -p "lib/skills/shared/${skill_name}"
    cp "${dir}SKILL.md" "lib/skills/shared/${skill_name}/"
  fi
done
