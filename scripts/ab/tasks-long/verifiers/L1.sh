#!/usr/bin/env bash
out=$(node --test test/*.test.mjs 2>&1)
printf '%s\n' "$out" | grep -E '^# (tests|pass|fail)' || true
p=$(printf '%s\n' "$out" | sed -n 's/^# pass \([0-9]*\)$/\1/p')
f=$(printf '%s\n' "$out" | sed -n 's/^# fail \([0-9]*\)$/\1/p')
echo "SCORE ${p:-0}/48"
[ "${f:-1}" = "0" ]
