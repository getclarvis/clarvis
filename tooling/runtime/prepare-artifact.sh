#!/bin/sh
set -eu

expected_sha256="$1"
expected_size="$2"
archive=/incoming/clarvis-kernel.tar.gz
payload=/artifact/payload

if [ "${3:-prepare}" = verify ]; then
  test ! -L /artifact/ready
  test -f /artifact/ready
  test "$(cat /artifact/ready)" = "$expected_sha256"
  test "$(stat -c %a /artifact/ready)" = 444
  test -f "$payload/manifest.json"
  test -x "$payload/bin/clarvis-kernel"
  test -f /artifact/checksums
  test -f /artifact/inventory
  (cd /artifact && sha256sum -c checksums)
  find "$payload" -mindepth 1 -printf '%y %m %p\n' | LC_ALL=C sort > /incoming/inventory
  cmp /artifact/inventory /incoming/inventory
  exit 0
fi

test ! -e /artifact/ready
cat > "$archive"
test "$(wc -c < "$archive")" = "$expected_size"
echo "$expected_sha256  $archive" | sha256sum -c -
test ! -e "$payload"
mkdir -m 0755 /artifact/payload.tmp
tar -xzf "$archive" -C /artifact/payload.tmp --no-same-owner --no-same-permissions
test -f /artifact/payload.tmp/manifest.json
test -x /artifact/payload.tmp/bin/clarvis-kernel
find /artifact/payload.tmp -type d -exec chmod 0555 '{}' +
find /artifact/payload.tmp -type f -exec chmod 0444 '{}' +
chmod 0555 /artifact/payload.tmp/bin/clarvis-kernel
mv /artifact/payload.tmp "$payload"
(cd /artifact && find payload -type f | LC_ALL=C sort | xargs sha256sum > checksums.tmp)
find "$payload" -mindepth 1 -printf '%y %m %p\n' | LC_ALL=C sort > /artifact/inventory.tmp
chmod 0444 /artifact/checksums.tmp /artifact/inventory.tmp
mv /artifact/checksums.tmp /artifact/checksums
mv /artifact/inventory.tmp /artifact/inventory
printf '%s\n' "$expected_sha256" > /artifact/ready.tmp
chmod 0444 /artifact/ready.tmp
mv /artifact/ready.tmp /artifact/ready
