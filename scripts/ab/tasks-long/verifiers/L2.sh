#!/usr/bin/env bash
out=$(bash build.sh 2>&1)
rc=$?
printf '%s\n' "$out" | grep -E 'STAGE_|BUILD_OK|ERROR' | tail -8 || true
s=0
printf '%s\n' "$out" | grep -q STAGE_COMPILE_OK && s=$((s + 1))
printf '%s\n' "$out" | grep -q STAGE_LINK_OK && s=$((s + 1))
printf '%s\n' "$out" | grep -q STAGE_PACKAGE_OK && s=$((s + 1))
echo "SCORE $s/3"
[ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^BUILD_OK$'
