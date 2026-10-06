#!/usr/bin/env bash
# Time comes from src/lib/clock.ts and identifiers from src/lib/ids.ts. Nowhere else.
# Golden scenarios compare output exactly; one stray Date.now() makes that impossible.
set -euo pipefail

ALLOWED='^src/lib/(clock|ids)\.ts:'
PATTERN='Date\.now\(|new Date\(\s*\)|Math\.random\(|randomUUID\('

hits=$(grep -rnE "$PATTERN" src --include='*.ts' --include='*.tsx' | grep -vE "$ALLOWED" || true)

if [[ -n "$hits" ]]; then
  echo "✗ time or identifiers created outside src/lib/clock.ts and src/lib/ids.ts:"
  echo "$hits" | sed 's/^/    /'
  exit 1
fi
echo "✓ time and identifiers come only from src/lib/clock.ts and src/lib/ids.ts"
