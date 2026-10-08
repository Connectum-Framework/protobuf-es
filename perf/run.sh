#!/usr/bin/env bash
# Measures @bufbuild/protobuf with the packages/protobuf-bench corpus inside
# Docker, pinned to one CPU. With --head it runs an interleaved A/B between
# two library revisions on one identical harness. See perf/README.md.
set -euo pipefail

usage() {
  cat <<'EOF'
USAGE: perf/run.sh --base <ref> [--head <ref>] [options]

  --base REF      library revision A (its packages/protobuf is measured)
  --head REF      library revision B; enables the interleaved A/B. Passing the
                  same revision as --base gives an A/A run, which measures the
                  noise floor
  --harness REF   revision the benchmark code comes from (default: HEAD)
  --passes N      fresh-process passes per side (default 30). With the exact
                  sign test, 10 pairs need 9 wins to reach p < 0.05; 30 pairs
                  resolve 3-5 % effects when the pair noise is <= 4 %. One
                  extra warm-up pair always runs first and is discarded
  --realistic     add the production-shaped fixtures (BENCH_REALISTIC=1)
  --filter RE     only cases matching RE (passed to bench.ts, may repeat)
  --profile CASE  also record a CPU profile of CASE per side (may repeat)
  --cpu N         CPU the container is pinned to (default 2)
  --cooldown S    seconds of rest between build and first pass (default 60)
  --no-wait       skip waiting for an idle host
  --isolated      run in pbbench.slice, the core reserved by perf/isolate.sh;
                  refuses to start unless the reservation is in force. Only
                  the reserved CPUs must then be idle, not the whole machine
  --image IMG     Node.js image (default node:24.21.0)
  --label NAME    result directory name under .tmp/perf/
EOF
}

base= head= harness=HEAD passes=30 cpu=2 cooldown=60 wait=1 sampler_cpu=12 isolated=0
image=node:24.21.0 label= realistic=0
filters=() profiles=()
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --base) base=$2; shift 2 ;;
    --head) head=$2; shift 2 ;;
    --harness) harness=$2; shift 2 ;;
    --passes) passes=$2; shift 2 ;;
    --realistic) realistic=1; shift ;;
    --filter) filters+=("$2"); shift 2 ;;
    --profile) profiles+=("$2"); shift 2 ;;
    --cpu) cpu=$2; shift 2 ;;
    --cooldown) cooldown=$2; shift 2 ;;
    --no-wait) wait=0; shift ;;
    --isolated) isolated=1; shift ;;
    --image) image=$2; shift 2 ;;
    --label) label=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n $base ]] || { usage >&2; exit 2; }

repo_root=$(git rev-parse --show-toplevel)
# A worktree's .git is a pointer into the main repository's object store, so
# the common dir has to be mounted as well for `git archive` to work inside.
git_common=$(cd "$repo_root" && cd "$(git rev-parse --git-common-dir)" && pwd)
resolve() { git -C "$repo_root" rev-parse --verify "$1^{commit}"; }
base_sha=$(resolve "$base")
# A mistyped --head must fail here, not silently degrade the A/B into a
# single-side run.
head_sha=
if [[ -n $head ]]; then head_sha=$(resolve "$head"); fi
harness_sha=$(resolve "$harness")

# The hyperthread sibling shares the core's execution units and caches with
# the benchmark, so it is watched and recorded together with the pinned CPU.
siblings=$(cat "/sys/devices/system/cpu/cpu$cpu/topology/thread_siblings_list")
cpus=$(echo "$siblings" | awk -F'[,-]' '{ for (i = $1; i <= $NF; i++) printf "%s ", i }')

# Expands a cpuset list into one CPU number per line. The kernel separates
# ranges with commas ("0-1,4-13"), systemctl show with spaces ("0-1 4-13").
expand_cpus() {
  tr ', ' '\n\n' <<< "$1" | awk -F- 'NF { hi = (NF == 2 ? $2 : $1); for (i = $1; i <= hi; i++) print i }'
}

if [[ $isolated -eq 1 ]]; then
  # The benchmark core must be requested for pbbench.slice (its cgroup only
  # exists while a container runs in it, so the request is what can be read
  # here; the container records the cpuset it actually got) and must be
  # absent from the effective cpusets of the slices everything else runs in.
  reserved=$(systemctl show pbbench.slice -p AllowedCPUs --value)
  for c in $cpus; do
    if ! expand_cpus "$reserved" | grep -qx "$c"; then
      echo "CPU $c is not reserved for pbbench.slice (AllowedCPUs='$reserved'); run: sudo perf/isolate.sh on" >&2
      exit 1
    fi
    for slice in user.slice system.slice; do
      if expand_cpus "$(cat "/sys/fs/cgroup/$slice/cpuset.cpus.effective")" | grep -qx "$c"; then
        echo "CPU $c is still available to $slice; run: sudo perf/isolate.sh on" >&2
        exit 1
      fi
    done
  done
fi

label=${label:-${base_sha:0:8}${head_sha:+-vs-${head_sha:0:8}}}
out="$repo_root/.tmp/perf/$label"
cache="$repo_root/.tmp/perf/npm-cache"
if [[ -e $out ]]; then
  echo "result directory exists, pick another --label: $out" >&2
  exit 1
fi
mkdir -p "$out" "$cache"

# Build trees (two full checkouts with node_modules) live on disk, not in a
# tmpfs: on this machine /tmp and tmpfs mounts take RAM. The container empties
# the directory when it exits; a leftover means a run is in progress or died.
work="$HOME/.cache/agent-work/protobuf-es/perf-work"
mkdir -p "$work"
if [[ -n $(ls -A "$work") ]]; then
  echo "build directory not empty (another run, or a crashed one): $work" >&2
  exit 1
fi

cpufreq=/sys/devices/system/cpu/cpu$cpu/cpufreq
jq -n --arg base "$base_sha" --arg head "$head_sha" --arg harness "$harness_sha" \
  --arg image "$image" \
  --arg digest "$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null || echo unknown)" \
  --arg cpus "$cpus" --argjson passes "$passes" --argjson cooldown "$cooldown" \
  --argjson wait "$wait" --argjson realistic "$realistic" \
  --arg filters "${filters[*]:-}" --arg profiles "${profiles[*]:-}" \
  --arg model "$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')" \
  --arg kernel "$(uname -r)" \
  --arg governor "$(cat "$cpufreq/scaling_governor")" \
  --arg epp "$(cat "$cpufreq/energy_performance_preference" 2>/dev/null || echo n/a)" \
  --arg no_turbo "$(cat /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null || echo n/a)" \
  --arg fmin "$(cat "$cpufreq/scaling_min_freq")" --arg fmax "$(cat "$cpufreq/scaling_max_freq")" \
  --argjson isolated "$isolated" \
  '{base: $base, head: (if $head == "" then null else $head end),
    harness: $harness, image: $image, imageDigest: $digest, cpus: $cpus,
    passes: $passes, warmupPairs: 1, cooldown: $cooldown, waitedForIdle: ($wait == 1),
    isolated: ($isolated == 1),
    realistic: ($realistic == 1), filters: $filters, profiles: $profiles,
    host: {cpu: $model, kernel: $kernel, governor: $governor, epp: $epp,
           noTurbo: $no_turbo, scalingMinKhz: $fmin, scalingMaxKhz: $fmax}}' > "$out/meta.json"

if [[ $wait -eq 1 ]]; then
  if [[ $isolated -eq 1 ]]; then
    # Nothing but kernel threads may run on the reserved core, so the rest of
    # the machine is allowed to be busy; only the reserved CPUs are checked.
    # Softirq time on the reserved CPUs is not counted either: see
    # IGNORE_SOFTIRQ in wait-idle.sh.
    BUSY_MAX=101 LOAD_MAX=100000 IGNORE_SOFTIRQ=1 CPUS="$cpus" \
      "$repo_root/perf/wait-idle.sh" 3600 | tee "$out/wait-idle.log"
  else
    CPUS="$cpus" "$repo_root/perf/wait-idle.sh" 3600 | tee "$out/wait-idle.log"
  fi
fi

cgroup_parent=()
if [[ $isolated -eq 1 ]]; then cgroup_parent=(--cgroup-parent=pbbench.slice); fi

# Frequency of the benchmark core, sampled from the host every 250 ms on a
# CPU outside the benchmark core, so sampling does not disturb what it
# observes. Two readings per pass (env.log) miss drops inside a pass; this
# trace does not. Stopped on any exit.
read -r -a watched <<< "$cpus"
taskset -c "$sampler_cpu" bash -c '
  while :; do
    line=$(date +%s.%N)
    for c in "$@"; do
      line+=" cpu$c=$(cat /sys/devices/system/cpu/cpu$c/cpufreq/scaling_cur_freq)"
    done
    echo "$line"
    sleep 0.25
  done' sampler "${watched[@]}" > "$out/freq.log" &
sampler_pid=$!
trap 'kill "$sampler_pid" 2>/dev/null || true' EXIT

docker run --rm \
  "${cgroup_parent[@]}" \
  --cpuset-cpus="$cpu" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/bench \
  -e npm_config_cache=/npm-cache \
  -e BENCH_BASE="$base_sha" \
  -e BENCH_HEAD="$head_sha" \
  -e BENCH_HARNESS="$harness_sha" \
  -e BENCH_PASSES="$passes" \
  -e BENCH_COOLDOWN="$cooldown" \
  -e BENCH_CPUS="$cpus" \
  -e BENCH_REALISTIC="$realistic" \
  -e BENCH_FILTERS="${filters[*]:-}" \
  -e BENCH_PROFILES="${profiles[*]:-}" \
  --tmpfs /home/bench:exec \
  -v "$work:/work" \
  -v "$repo_root:$repo_root:ro" \
  -v "$git_common:$git_common:ro" \
  -v "$cache:/npm-cache" \
  -v "$out:/out" \
  -w "$repo_root" \
  "$image" \
  bash "$repo_root/perf/in-container.sh"

got=$(cat "$out/container-cpuset.txt")
if [[ $got != "$cpu" ]]; then
  echo "container ran on CPUs '$got', not on CPU $cpu; results are not valid: $out" >&2
  exit 1
fi

"$repo_root/perf/report.sh" "$out"
echo "results: $out"
