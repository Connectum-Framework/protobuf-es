#!/usr/bin/env bash
# Reserves one physical core (CPU 2 and its hyperthread sibling CPU 3) for
# benchmarks and pins its frequency, until `off` or the next reboot. Needs
# root: run as `sudo perf/isolate.sh on|off|status`.
#
# Why: on this laptop the benchmark core is otherwise shared with the desktop,
# IDEs and other containers (measured 19-44 % busy around the clock), and
# throughput follows a frequency that wanders between 2.3 and 4.1 GHz under a
# single-core load. Both move results by more than the effects being measured.
#
# How: with the systemd cgroup driver Docker places containers under
# system.slice, so the reserved CPUs are taken away from user.slice and
# system.slice (everything users and services run, including other
# containers) and given to pbbench.slice alone; perf/run.sh --isolated starts
# the benchmark container there. All settings are --runtime: they live under
# /run and vanish on reboot. Per-CPU kernel threads and interrupts are not
# covered by cgroups and still run on the reserved CPUs; perf/run.sh records
# per-pass CPU time to show them.
set -uo pipefail

bench_cpus=${PERF_BENCH_CPUS:-2-3}
freq_khz=${PERF_FREQ_KHZ:-2400000}

# One CPU number per line from a cpuset list ("0-1,4-13" or "0-1 4-13").
expand_cpus() {
  tr ', ' '\n\n' <<< "$1" | awk -F- 'NF { hi = (NF == 2 ? $2 : $1); for (i = $1; i <= hi; i++) print i }'
}
mapfile -t reserved < <(expand_cpus "$bench_cpus")
# Every online CPU except the reserved ones, as a comma-separated list.
other_cpus=$(expand_cpus "$(cat /sys/devices/system/cpu/online)" \
  | grep -vxF -f <(printf '%s\n' "${reserved[@]}") | paste -sd,)

cpufreq() { echo "/sys/devices/system/cpu/cpu$1/cpufreq/$2"; }

status() {
  local unit c
  for unit in user.slice system.slice pbbench.slice; do
    printf '%-14s AllowedCPUs=%-12s effective=%s\n' "$unit" \
      "$(systemctl show "$unit" -p AllowedCPUs --value)" \
      "$(cat "/sys/fs/cgroup/$unit/cpuset.cpus.effective" 2>/dev/null || echo '(no cgroup yet)')"
  done
  for c in "${reserved[@]}"; do
    echo "cpu$c scaling_min_freq=$(cat "$(cpufreq "$c" scaling_min_freq)") scaling_max_freq=$(cat "$(cpufreq "$c" scaling_max_freq)") cur=$(cat "$(cpufreq "$c" scaling_cur_freq)")"
  done
}

# Exit status 0 if any reserved CPU is still in the effective cpuset of the
# given slice. systemd applies cpusets asynchronously and only logs a failed
# write, so success of set-property proves nothing; the kernel's view does.
slice_has_reserved() {
  local effective c
  effective=$(cat "/sys/fs/cgroup/$1/cpuset.cpus.effective")
  for c in "${reserved[@]}"; do
    if expand_cpus "$effective" | grep -qx "$c"; then return 0; fi
  done
  return 1
}

on() {
  local c slice i
  set -e
  systemctl set-property --runtime pbbench.slice AllowedCPUs="$bench_cpus"
  systemctl set-property --runtime user.slice AllowedCPUs="$other_cpus"
  systemctl set-property --runtime system.slice AllowedCPUs="$other_cpus"
  # scaling_min_freq and scaling_max_freq are independent requests that the
  # kernel clamps against each other, so the write order does not matter.
  for c in "${reserved[@]}"; do
    echo "$freq_khz" > "$(cpufreq "$c" scaling_max_freq)"
    echo "$freq_khz" > "$(cpufreq "$c" scaling_min_freq)"
  done
  set +e
  for slice in user.slice system.slice; do
    for i in 1 2 3 4 5 6 7 8 9 10; do
      slice_has_reserved "$slice" || continue 2
      sleep 0.5
    done
    echo "reservation not effective: $slice still has CPUs from $bench_cpus" >&2
    status
    exit 1
  done
  status
}

# Every step runs even if an earlier one fails, so a single error cannot
# leave the frequency pinned or a slice restricted; the exit status reports
# whether everything was restored.
off() {
  local c slice rc=0
  for slice in user.slice system.slice pbbench.slice; do
    systemctl set-property --runtime "$slice" AllowedCPUs= || rc=1
  done
  # Restored to the hardware limits rather than to values saved at `on`:
  # those could have been a temporary clamp (thermal, a crashed earlier run)
  # that would then stay in force until reboot.
  for c in "${reserved[@]}"; do
    cat "$(cpufreq "$c" cpuinfo_min_freq)" > "$(cpufreq "$c" scaling_min_freq)" || rc=1
    cat "$(cpufreq "$c" cpuinfo_max_freq)" > "$(cpufreq "$c" scaling_max_freq)" || rc=1
  done
  sleep 1
  for slice in user.slice system.slice; do
    if ! slice_has_reserved "$slice"; then
      echo "$slice still excludes CPUs from $bench_cpus" >&2
      rc=1
    fi
  done
  status
  return "$rc"
}

case ${1:-} in
  on) on ;;
  off) off ;;
  status) status ;;
  *) echo "usage: sudo perf/isolate.sh on|off|status" >&2; exit 2 ;;
esac
