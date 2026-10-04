#!/usr/bin/env bash
# Blocks until the host is quiet enough to benchmark, checking once per
# interval, then exits 0. On this class of laptop (hybrid P/E cores,
# intel_pstate) throughput follows CPU frequency, and a busy neighbour process
# moves results by tens of percent, so measurements start only on an idle box.
#
# Idle means: over a 60 s window the whole machine is less than BUSY_MAX %
# busy (from /proc/stat), and the 1-minute load average is below LOAD_MAX.
set -euo pipefail

interval=${1:-3600}
busy_max=${BUSY_MAX:-10}
load_max=${LOAD_MAX:-1.5}

# Prints the busy percentage of all CPUs over the next 60 seconds.
busy_percent() {
  local a b
  read -r -a a < <(grep '^cpu ' /proc/stat)
  sleep 60
  read -r -a b < <(grep '^cpu ' /proc/stat)
  # Fields: user nice system idle iowait irq softirq steal.
  local total=0 idle i
  for i in 1 2 3 4 5 6 7 8; do
    total=$((total + b[i] - a[i]))
  done
  idle=$((b[4] - a[4] + b[5] - a[5]))
  echo $(((total - idle) * 100 / total))
}

while true; do
  busy=$(busy_percent)
  load=$(cut -d' ' -f1 /proc/loadavg)
  stamp=$(date -Is)
  if [[ $busy -lt $busy_max ]] && awk -v l="$load" -v m="$load_max" 'BEGIN { exit !(l < m) }'; then
    echo "$stamp idle: busy=${busy}% load=${load}"
    exit 0
  fi
  echo "$stamp busy: busy=${busy}% load=${load}; next check in ${interval}s"
  sleep "$interval"
done
