#!/bin/bash
# Write daily-debug 16406 (both OS slots) and the bridge's tier-3 loader to the WebTV CF card.
# Only these three sector ranges change; everything else on the card is left as it is.
set -e
DEV=/dev/rdisk4
IMG="$(cd "$(dirname "$0")/.." && pwd)/data/box-cf-16406.bin"
diskutil info disk4 | grep -q "2079350784 Bytes" || { echo "disk4 is not the 2.08 GB WebTV card: stopping"; exit 1; }
for r in "1027 7680" "17411 7680" "34312 12"; do
  set -- $r
  echo "writing LBA $1, $2 sectors"
  dd if="$IMG" of=$DEV bs=512 skip=$1 seek=$1 count=$2 2>/dev/null
done
sync
for r in "1027 7680" "17411 7680" "34312 12"; do
  set -- $r
  dd if=$DEV bs=512 skip=$1 count=$2 2>/dev/null | cmp -s - <(dd if="$IMG" bs=512 skip=$1 count=$2 2>/dev/null)     && echo "LBA $1: verified" || { echo "LBA $1: MISMATCH"; exit 1; }
done
diskutil eject disk4
echo "done: the card can go back in the box"
