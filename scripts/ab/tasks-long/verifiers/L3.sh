#!/usr/bin/env bash
out=$(node --test test/*.test.mjs 2>&1)
printf '%s\n' "$out" | grep -E '^# (tests|pass|fail)' || true
p=$(printf '%s\n' "$out" | sed -n 's/^# pass \([0-9]*\)$/\1/p')
f=$(printf '%s\n' "$out" | sed -n 's/^# fail \([0-9]*\)$/\1/p')
g=0; [ "${f:-1}" = "0" ] && [ "${p:-0}" = "16" ] && g=1
r=0; grep -q fetchRecord src/api.js && grep -q listRecordsV2 src/api.js && grep -q fetchRecord src/index.js && r=1
m=0; grep -q validateRecord src/store.js && [ ! -f src/validate.js ] && m=1
s=$((g + r + m))
echo "SCORE $s/3"
[ "$s" -eq 3 ]
