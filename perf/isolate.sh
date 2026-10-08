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
# system.slice, so CPUs 2-3 are taken away from user.slice and system.slice
# (everything users and services run, including other containers) and given
# to pbbench.slice alone; perf/run.sh --isolated starts the benchmark container
# there. All settings are --runtime: they live under /run and vanish on reboot.
# Kernel threads and interrupts are not covered by cgroups and may still run
# on CPUs 2-3; perf/run.sh records per-pass CPU time to show them.
set -euo pipefail

bench_cpus=2-3
other_cpus=0-1,4-13
freq_khz=${PERF_FREQ_KHZ:-2400000}
# The frequency limits in force before `on`, restored by `off`.
state=/run/pbbench-isolate.freq

cpufreq() { echo "/sys/devices/system/cpu/cpu$1/cpufreq/$2"; }

status() {
  local unit c
  for unit in user.slice system.slice pbbench.slice; do
    printf '%-14s AllowedCPUs=%-12s effective=%s\n' "$unit" \
      "$(systemctl show "$unit" -p AllowedCPUs --value)" \
      "$(cat "/sys/fs/cgroup/$unit/cpuset.cpus.effective" 2>/dev/null || echo '(no cgroup yet)')"
  done
  for c in 2 3; do
    echo "cpu$c scaling_min_freq=$(cat "$(cpufreq "$c" scaling_min_freq)") scaling_max_freq=$(cat "$(cpufreq "$c" scaling_max_freq)") cur=$(cat "$(cpufreq "$c" scaling_cur_freq)")"
  done
}

on() {
  local c
  if [[ ! -e $state ]]; then
    for c in 2 3; do
      echo "$c $(cat "$(cpufreq "$c" scaling_min_freq)") $(cat "$(cpufreq "$c" scaling_max_freq)")"
    done > "$state"
  fi
  systemctl set-property --runtime pbbench.slice AllowedCPUs="$bench_cpus"
  systemctl set-property --runtime user.slice AllowedCPUs="$other_cpus"
  systemctl set-property --runtime system.slice AllowedCPUs="$other_cpus"
  # min <= max must hold after every write: when raising, max goes first;
  # when lowering, min goes first. Lowering max to the target first and then
  # raising min covers both directions from the default 0.4-4.9 GHz range.
  for c in 2 3; do
    echo "$freq_khz" > "$(cpufreq "$c" scaling_max_freq)"
    echo "$freq_khz" > "$(cpufreq "$c" scaling_min_freq)"
  done
  status
}

off() {
  local c min max
  systemctl set-property --runtime user.slice AllowedCPUs=
  systemctl set-property --runtime system.slice AllowedCPUs=
  systemctl set-property --runtime pbbench.slice AllowedCPUs=
  if [[ -e $state ]]; then
    while read -r c min max; do
      echo "$min" > "$(cpufreq "$c" scaling_min_freq)"
      echo "$max" > "$(cpufreq "$c" scaling_max_freq)"
    done < "$state"
    rm -f /run/pbbench-isolate.freq
  fi
  status
}

case ${1:-} in
  on) on ;;
  off) off ;;
  status) status ;;
  *) echo "usage: sudo perf/isolate.sh on|off|status" >&2; exit 2 ;;
esac
