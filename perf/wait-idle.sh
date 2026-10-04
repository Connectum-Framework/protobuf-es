#!/usr/bin/env bash
# Blocks until the host is quiet enough to benchmark, checking once per
# interval, then exits 0. On this class of laptop (hybrid P/E cores,
# intel_pstate) throughput follows CPU frequency, and a busy neighbour process
# moves results by tens of percent, so measurements start only on an idle box.
#
# Idle means, over a 60 s window: the whole machine is less than BUSY_MAX %
# busy, each CPU listed in CPUS (the benchmark CPU and its hyperthread
# sibling) is less than CPU_BUSY_MAX % busy, and the 1-minute load average is
# below LOAD_MAX. A single busy process is ~7 % of this 14-CPU machine, so the
# whole-machine figure alone would let it through; the per-CPU check is what
# keeps it off the cores the benchmark runs on.
set -euo pipefail

interval=${1:-3600}
busy_max=${BUSY_MAX:-10}
cpu_busy_max=${CPU_BUSY_MAX:-5}
load_max=${LOAD_MAX:-1.5}
read -r -a watched <<< "${CPUS:-}"

# Busy percentage of one /proc/stat line between two snapshots.
# Fields after the name: user nice system idle iowait irq softirq steal.
busy_between() {
  local -a a b
  read -r -a a <<< "$1"
  read -r -a b <<< "$2"
  local total=0 idle i
  for i in 1 2 3 4 5 6 7 8; do
    total=$((total + b[i] - a[i]))
  done
  idle=$((b[4] - a[4] + b[5] - a[5]))
  if [[ $total -eq 0 ]]; then echo 0; else echo $(((total - idle) * 100 / total)); fi
}

while true; do
  before=$(cat /proc/stat)
  sleep 60
  after=$(cat /proc/stat)
  busy=$(busy_between "$(grep '^cpu ' <<< "$before")" "$(grep '^cpu ' <<< "$after")")
  ok=1
  detail="busy=${busy}%"
  [[ $busy -lt $busy_max ]] || ok=0
  for c in "${watched[@]}"; do
    b=$(busy_between "$(grep "^cpu$c " <<< "$before")" "$(grep "^cpu$c " <<< "$after")")
    detail+=" cpu$c=${b}%"
    [[ $b -lt $cpu_busy_max ]] || ok=0
  done
  load=$(cut -d' ' -f1 /proc/loadavg)
  detail+=" load=${load}"
  awk -v l="$load" -v m="$load_max" 'BEGIN { exit !(l < m) }' || ok=0
  if [[ $ok -eq 1 ]]; then
    echo "$(date -Is) idle: $detail"
    exit 0
  fi
  echo "$(date -Is) busy: $detail; next check in ${interval}s"
  sleep "$interval"
done
