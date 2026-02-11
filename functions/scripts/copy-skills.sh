#!/bin/bash
# Copy SKILL.md files to lib directory after build

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
