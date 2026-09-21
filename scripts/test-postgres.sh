#!/usr/bin/env bash
# Run the test suite against a REAL Postgres server, the way production runs.
#
#   scripts/test-postgres.sh                       # uses PGHOST/PGPORT below
#   PGURL=postgres://user:pw@host/db scripts/test-postgres.sh
#
# `npm test` on its own uses the embedded Postgres and needs no server; this
# script is the extra check that the network driver, pooling and transactions
# behave against the real thing.
set -euo pipefail

ADMIN_URL="${PGURL:-postgres://postgres@127.0.0.1:55432/postgres}"
BASE="${ADMIN_URL%/*}"

fail=0
for file in test/*.test.js; do
  # One database per file: they'd otherwise collide on unique constraints.
  name="fscl_$(basename "$file" .test.js)"
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $name;" -c "CREATE DATABASE $name;"

  echo "── $file → $name"
  if ! DATABASE_URL="$BASE/$name" DATABASE_SSL=false node --no-warnings --test "$file"; then
    fail=1
  fi
done

exit "$fail"
