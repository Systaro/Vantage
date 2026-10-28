#!/bin/sh
# vantage-agent: host check agent of Vantage Ops.
#
# Collects disk, memory, load, CPU time, systemd, docker and (optionally) Elasticsearch state of this
# host and emits it as one JSON report. The server validates the report strictly; the contract is
# src/shared/hosts/report.ts in the Vantage repository (report version 1).
#
# Modes:
#   vantage-agent              agent mode, what cron runs: build the report and POST it to
#                              $VANTAGE_URL/api/ingest/v1/report ("Authorization: Bearer $VANTAGE_TOKEN")
#   vantage-agent --print      central mode: print the report to stdout, never post. Ops runs it as
#                              ssh -o BatchMode=yes -o ConnectTimeout=10 -- HOST 'sh -s -- --print' < vantage-agent.sh
#   vantage-agent --install    install agent, config file and cron entry, then send one report
#   vantage-agent --uninstall  remove all of that again
#   vantage-agent --help       all flags
#
# Configuration, lowest to highest precedence:
#   1. config file (sh-sourceable KEY='value' lines): --config FILE, else /etc/vantage-agent.conf if
#      readable, else $HOME/.config/vantage-agent.conf if readable
#   2. environment: VANTAGE_URL, VANTAGE_TOKEN, VANTAGE_ES_URL
#   3. flags: --url, --token, --es-url
#
# Requirements: POSIX sh (dash, BusyBox ash, bash), awk, df; curl only for posting and the ES check.
# On macOS --print works with less data (memory is null, disks come from df).
#
# Exit codes: 0 ok, 1 runtime failure (post or install failed), 2 usage or configuration error.

LC_ALL=C
export LC_ALL
set -u
umask 077
# cron and non-login SSH sessions come with a minimal PATH; append (not prepend) the usual places.
PATH=${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
export PATH

AGENT_VERSION=1
# Test hooks, not part of the interface: alternative proc root and systemd runtime directory.
PROC=${VANTAGE_PROC:-/proc}
SYSTEMD_DIR=${VANTAGE_SYSTEMD_DIR:-/run/systemd/system}

NL='
'
TAB=$(printf '\t')
CRON_MARK='# managed by vantage-agent'
CRON_D_FILE=/etc/cron.d/vantage-agent
ES_UNREACHABLE='{"reachable":false,"blocked_indices":0,"max_disk_pct":null}'

MODE=''
F_URL='' F_URL_SET=0
F_TOKEN='' F_TOKEN_SET=0
F_ES='' F_ES_SET=0
F_CONFIG=''
INTERVAL=5
TMPD=''
ERRF=/dev/null
ERRORS=''
HAVE_TIMEOUT=0
OUT=''
ERR=''

say() { printf 'vantage-agent: %s\n' "$*" >&2; }
info() { printf 'vantage-agent: %s\n' "$*"; }
die() {
  _code=$1
  shift
  say "$*"
  exit "$_code"
}
usage_error() {
  say "$*"
  say "see 'vantage-agent --help'"
  exit 2
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Usage: vantage-agent [--print | --install | --uninstall] [options]

Host check agent of Vantage Ops. Without a mode flag it builds the report and posts it to
$VANTAGE_URL/api/ingest/v1/report (this is what cron runs).

Modes:
  --print            print the JSON report to stdout and never post (central mode over SSH)
  --install          install the agent, its config file and a cron entry, then post one report
  --uninstall        remove the cron entry, the config file and the installed agent
  -h, --help         show this help
  --version          print the agent version

Options (also accepted as --flag=value):
  --url URL          Vantage Ops base URL, http:// or https:// (VANTAGE_URL)
  --token TOKEN      host token, vha_ followed by 43 characters (VANTAGE_TOKEN)
  --es-url URL       Elasticsearch base URL for the optional ES check (VANTAGE_ES_URL)
  --interval MIN     cron interval for --install: 1-59, 60 or a multiple of 60 up to 1440 (default 5)
  --config FILE      config file to read instead of /etc/vantage-agent.conf or
                     ~/.config/vantage-agent.conf

Precedence: config file < environment < flags.
Install locations: as root /usr/local/bin/vantage-agent, /etc/vantage-agent.conf and
/etc/cron.d/vantage-agent (root crontab without /etc/cron.d); otherwise ~/.local/bin/vantage-agent,
~/.config/vantage-agent.conf and the user crontab.

Central mode: ssh -o BatchMode=yes -o ConnectTimeout=10 -- HOST 'sh -s -- --print' < vantage-agent.sh
EOF
}

cleanup() {
  if [ -n "$TMPD" ]; then rm -rf "$TMPD"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Creates the private temp directory (mode 700 through umask 077). Must run in the main shell.
make_tmp() {
  [ -z "$TMPD" ] || return 0
  _base=${TMPDIR:-/tmp}
  TMPD=$(mktemp -d "$_base/vantage-agent.XXXXXX" 2>/dev/null) || TMPD=''
  if [ -z "$TMPD" ]; then
    # mkdir fails if the name exists, so a pre-planted directory or symlink is never used.
    TMPD=$_base/vantage-agent.$$
    mkdir "$TMPD" 2>/dev/null || {
      TMPD=''
      return 1
    }
  fi
  ERRF=$TMPD/stderr
}

# run_t SECONDS CMD...: runs CMD with a time limit when a working timeout(1) exists.
run_t() {
  _secs=$1
  shift
  if [ "$HAVE_TIMEOUT" = 1 ]; then timeout "$_secs" "$@"; else "$@"; fi
}

# run_capture SECONDS CMD...: stdout into OUT, on failure a one-line reason into ERR; returns the status.
run_capture() {
  _secs=$1
  shift
  OUT=$(run_t "$_secs" "$@" 2>"$ERRF")
  _rc=$?
  ERR=''
  if [ "$_rc" -ne 0 ]; then
    if [ "$_rc" -eq 124 ] && [ "$HAVE_TIMEOUT" = 1 ]; then
      ERR="timed out after ${_secs}s"
    else
      ERR=$(awk 'NF { print; exit }' "$ERRF" 2>/dev/null)
      [ -n "$ERR" ] || ERR="exit status $_rc"
    fi
  fi
  return "$_rc"
}

add_error() {
  ERRORS=$ERRORS$(printf '%s' "$*" | tr '\n' ' ')$NL
}

# ---------------------------------------------------------------------------------------------------
# JSON helpers

# esc(): makes a string safe inside a JSON string literal. Escapes \ and ", drops control
# characters (the server rejects them). Plain loop, because sub/gsub backslash handling differs
# between mawk, gawk, BusyBox awk and BSD awk.
AWK_ESC='
function esc(s,   i, n, c, out) {
  if (s !~ /["\\\001-\037\177]/) return s
  out = ""
  n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\"" || c == "\\") out = out "\\" c
    else if (c !~ /[\001-\037\177]/) out = out c
  }
  return out
}
'

# json_lines MAX LEN: stdin lines as a JSON string array, at most MAX entries cut to LEN bytes each.
json_lines() {
  awk -v max="$1" -v len="$2" "$AWK_ESC"'
    { s = esc(substr($0, 1, len)) }
    s != "" && n < max + 0 { out = out (n++ ? "," : "") "\"" s "\"" }
    END { printf "[%s]", out }'
}

# json_str VALUE LEN: the first line of VALUE as a JSON string, cut to LEN bytes.
json_str() {
  printf '%s\n' "$1" | awk -v len="$2" "$AWK_ESC"'NR == 1 { printf "\"%s\"", esc(substr($0, 1, len)) }'
}

# ---------------------------------------------------------------------------------------------------
# Checks. Each sets its *_JSON variable and never aborts the report.

# /proc/mounts: "device mountpoint fstype ..." with space, tab, newline and backslash encoded as \ooo.
# Prints "device<TAB>mount<TAB>fstype" for every non-pseudo filesystem.
MOUNTS_AWK='
BEGIN {
  n = split("autofs binfmt_misc bpf cgroup cgroup2 configfs debugfs devpts devtmpfs efivarfs fuse.gvfsd-fuse fuse.lxcfs fuse.portal fusectl hugetlbfs mqueue nfsd nsfs overlay proc pstore ramfs rootfs rpc_pipefs securityfs selinuxfs squashfs sysfs tmpfs tracefs", list, " ")
  for (i = 1; i <= n; i++) pseudo[list[i]] = 1
}
function unesc(s,   out, i, n, c, d) {
  if (index(s, "\\") == 0) return s
  out = ""
  n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    d = substr(s, i + 1, 3)
    if (c == "\\" && d ~ /^[0-7][0-7][0-7]$/) {
      out = out sprintf("%c", substr(d, 1, 1) * 64 + substr(d, 2, 1) * 8 + substr(d, 3, 1))
      i += 3
    } else out = out c
  }
  return out
}
NF >= 3 && !($3 in pseudo) {
  dev = unesc($1)
  mnt = unesc($2)
  if (dev == "") dev = "none"
  if (mnt == "" || mnt ~ /[\001-\037\177]/ || dev ~ /[\001-\037\177]/) next
  print dev "\t" mnt "\t" $3
}'

# Fallback without /proc/mounts (macOS): "df -P -k" lines of /dev/* devices, fstype unknown.
DF_LIST_AWK='
NR > 1 && $1 ~ /^\/dev\// {
  line = $0
  if (!sub(/^[^ ]+ +[0-9]+ +[0-9]+ +[0-9]+ +([0-9]+%|-) +/, "", line)) next
  if (line == "" || line ~ /[\001-\037\177]/) next
  print $1 "\t" line "\t"
}'

# "df -P -k MOUNT": prints "size used avail". Searches the number columns instead of counting
# fields, so a device or mount name with spaces does not shift them.
DF_NUM_AWK='
NR > 1 {
  for (i = 2; i + 3 <= NF; i++)
    if ($i ~ /^[0-9]+$/ && $(i + 1) ~ /^[0-9]+$/ && $(i + 2) ~ /^[0-9]+$/ && $(i + 3) ~ /^([0-9]+%|-)$/) {
      print $i, $(i + 1), $(i + 2)
      exit
    }
}'

DISKS_AWK='
BEGIN { FS = "\t" }
NF >= 6 {
  t = $5 + $6
  pct = t > 0 ? $5 * 100 / t : 0
  if (pct > 100) pct = 100
  out = out (n++ ? "," : "") sprintf("{\"mount\":\"%s\",\"device\":\"%s\",\"fstype\":\"%s\",\"size_kb\":%s,\"used_kb\":%s,\"avail_kb\":%s,\"used_pct\":%.1f}", esc($2), esc(substr($1, 1, 1024)), esc(substr($3, 1, 64)), $4, $5, $6, pct)
}
END { printf "[%s]", out }'

collect_disks() {
  DISKS_JSON='[]'
  if [ -r "$PROC/mounts" ]; then
    _cands=$(awk "$MOUNTS_AWK" "$PROC/mounts")
  elif have df; then
    run_capture 10 df -P -k
    _cands=$(printf '%s\n' "$OUT" | awk "$DF_LIST_AWK")
    [ -n "$_cands" ] || add_error "disks: df -P -k listed nothing: $ERR"
  else
    add_error "disks: neither $PROC/mounts nor df available"
    return 0
  fi

  _seen=''
  _rows=''
  _count=0
  _skipped=0
  while IFS=$TAB read -r _dev _mnt _fst; do
    [ -n "$_mnt" ] || continue
    [ "${#_mnt}" -le 1024 ] || continue
    # Bind mounts of directories repeat the device; the first mount of a device wins.
    case $NL$_seen in *"$NL$_dev$NL"*) continue ;; esac
    if [ "$_count" -ge 100 ]; then
      _skipped=$((_skipped + 1))
      continue
    fi
    # Bind-mounted files (/etc/hosts in containers) are not filesystems. On network filesystems the
    # stat behind -d can hang, so there df (with its time limit) goes first.
    case $_fst in
      nfs* | cifs | smb* | fuse.* | ceph | glusterfs | 9p | afs | davfs) _remote=1 ;;
      *) _remote=0 ;;
    esac
    if [ "$_remote" = 0 ] && [ ! -d "$_mnt" ]; then continue; fi
    if ! run_capture 10 df -P -k "$_mnt"; then
      add_error "disk $_mnt: df failed: $ERR"
      continue
    fi
    [ -d "$_mnt" ] || continue
    _nums=$(printf '%s\n' "$OUT" | awk "$DF_NUM_AWK")
    if [ -z "$_nums" ]; then
      add_error "disk $_mnt: unexpected df output"
      continue
    fi
    # shellcheck disable=SC2086 # split "size used avail" into words
    set -- $_nums
    [ "$1" != 0 ] || continue
    _seen=$_seen$_dev$NL
    _rows=$_rows$_dev$TAB$_mnt$TAB$_fst$TAB$1$TAB$2$TAB$3$NL
    _count=$((_count + 1))
  done <<EOF
$_cands
EOF
  [ "$_skipped" -eq 0 ] || add_error "disks: $_skipped more filesystems not reported (limit 100)"
  DISKS_JSON=$(printf '%s' "$_rows" | awk "$AWK_ESC$DISKS_AWK")
  [ -n "$DISKS_JSON" ] || DISKS_JSON='[]'
}

collect_memory() {
  MEMORY_JSON=null
  [ -r "$PROC/meminfo" ] || return 0
  _m=$(awk '
    $1 == "MemTotal:" { t = $2 }
    $1 == "MemAvailable:" { a = $2; have_a = 1 }
    $1 == "MemFree:" { f = $2 }
    $1 == "Buffers:" { b = $2 }
    $1 == "Cached:" { c = $2 }
    END {
      if (t !~ /^[0-9]+$/ || t + 0 == 0) exit 1
      if (!have_a) a = f + b + c
      if (a + 0 > t + 0) a = t
      printf "{\"total_kb\":%s,\"available_kb\":%.0f,\"used_pct\":%.1f}", t, a, (t - a) * 100 / t
    }' "$PROC/meminfo")
  if [ -z "$_m" ]; then
    add_error "memory: cannot parse $PROC/meminfo"
    return 0
  fi
  MEMORY_JSON=$_m
}

cpu_cores() {
  _n=''
  if have nproc; then _n=$(nproc 2>/dev/null); fi
  case $_n in '' | *[!0-9]* | 0) _n=$(getconf _NPROCESSORS_ONLN 2>/dev/null) ;; esac
  case $_n in '' | *[!0-9]* | 0) if have sysctl; then _n=$(sysctl -n hw.ncpu 2>/dev/null); fi ;; esac
  case $_n in '' | *[!0-9]* | 0) if [ -r "$PROC/cpuinfo" ]; then _n=$(grep -c '^processor' "$PROC/cpuinfo"); fi ;; esac
  case $_n in '' | *[!0-9]* | 0) _n=1 ;; esac
  printf '%s' "$_n"
}

collect_load() {
  LOAD_JSON=null
  if [ -r "$PROC/loadavg" ]; then
    _l=$(cat "$PROC/loadavg")
  elif have sysctl && _l=$(sysctl -n vm.loadavg 2>/dev/null); then
    _l=$(printf '%s\n' "$_l" | tr -d '{}')
  else
    return 0
  fi
  _j=$(printf '%s\n' "$_l" | awk -v cores="$(cpu_cores)" '
    function ok(v) { return v ~ /^[0-9]+(\.[0-9]+)?$/ }
    NR == 1 && ok($1) && ok($2) && ok($3) {
      printf "{\"load1\":%.2f,\"load5\":%.2f,\"load15\":%.2f,\"cores\":%d}", $1, $2, $3, cores
    }')
  if [ -z "$_j" ]; then
    add_error "load: cannot parse load average"
    return 0
  fi
  LOAD_JSON=$_j
}

# CPU time since boot from /proc/stat, in clock ticks. A single reading says nothing; the hub takes
# the difference between two reports, so the agent stays stateless and needs no sampling pause.
collect_cpu() {
  CPU_JSON=null
  [ -r "$PROC/stat" ] || return 0
  _c=$(awk '
    $1 == "cpu" {
      if (NF < 5) exit 1
      # user nice system idle iowait irq softirq steal; guest time is already counted in user and nice
      for (i = 2; i <= NF && i <= 9; i++) { if ($i !~ /^[0-9]+$/) exit 1; t += $i }
      w = 0
      if (NF >= 6) w = $6
      printf "{\"total\":%.0f,\"idle\":%.0f,\"iowait\":%.0f}", t, $5, w
      exit 0
    }' "$PROC/stat")
  if [ -z "$_c" ]; then
    add_error "cpu: cannot parse $PROC/stat"
    return 0
  fi
  CPU_JSON=$_c
}

collect_systemd() {
  SYSTEMD_JSON=null
  have systemctl || return 0
  [ -d "$SYSTEMD_DIR" ] || return 0
  if ! run_capture 15 systemctl list-units --state=failed --no-legend --plain --no-pager; then
    add_error "systemd: systemctl failed: $ERR"
    return 0
  fi
  # First column is the unit; some versions print a status bullet column in front of it.
  _units=$(printf '%s\n' "$OUT" | awk '{ u = $1; if (u !~ /\./ && NF >= 2) u = $2; if (u ~ /\./) print u }')
  SYSTEMD_JSON="{\"failed\":$(printf '%s\n' "$_units" | json_lines 500 256)}"
}

collect_docker() {
  DOCKER_JSON=null
  have docker || return 0
  if ! run_capture 15 docker info --format '{{.ServerVersion}}'; then
    case $ERR in
      *[Pp]ermission\ denied*) add_error "docker: not accessible (permission denied)" ;;
      *) add_error "docker: not accessible: $ERR" ;;
    esac
    return 0
  fi
  if ! run_capture 15 docker ps -aq; then
    add_error "docker: ps failed: $ERR"
    return 0
  fi
  _ids=$OUT
  _total=$(printf '%s\n' "$_ids" | awk 'NF { n++ } END { print n + 0 }')
  _stopped=''
  if [ "$_total" -gt 0 ]; then
    # One call for all containers. A container removed after "ps" makes inspect fail for that id
    # only, so whatever it printed is still used.
    # shellcheck disable=SC2086 # the id list is meant to split into arguments
    run_capture 15 docker inspect --format '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.Status}}' $_ids
    if [ -z "$OUT" ]; then
      add_error "docker: inspect failed: $ERR"
      return 0
    fi
    # Should run but does not: restart policy always/unless-stopped and not running, or a
    # container stuck restarting or dead whatever its policy.
    _stopped=$(printf '%s\n' "$OUT" | awk -F'|' '
      NF >= 3 {
        name = $1
        sub(/^\//, "", name)
        if ((($2 == "always" || $2 == "unless-stopped") && $3 != "running") || $3 == "restarting" || $3 == "dead") print name
      }')
  fi
  DOCKER_JSON="{\"total\":$_total,\"stopped\":$(printf '%s\n' "$_stopped" | json_lines 1000 256)}"
}

# es_get URL: GET with the URL in a private curl config, so credentials in it stay out of ps.
es_get() {
  if [ -n "$TMPD" ]; then
    printf 'url = "%s"\n' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')" >"$TMPD/es.conf"
    run_capture 15 curl -fsS -g -m 10 -K "$TMPD/es.conf"
  else
    run_capture 15 curl -fsS -g -m 10 "$1"
  fi
}

collect_es() {
  ES_JSON=null
  [ -n "${VANTAGE_ES_URL:-}" ] || return 0
  _es=${VANTAGE_ES_URL%/}
  if ! have curl; then
    add_error "es: curl not found"
    ES_JSON=$ES_UNREACHABLE
    return 0
  fi
  if ! es_get "$_es/_cluster/health"; then
    add_error "es: not reachable: $ERR"
    ES_JSON=$ES_UNREACHABLE
    return 0
  fi
  _blocked=0
  if es_get "$_es/_all/_settings/index.blocks.read_only_allow_delete?flat_settings=true"; then
    _blocked=$(printf '%s\n' "$OUT" | awk '{ n += gsub(/"index\.blocks\.read_only_allow_delete" *: *"true"/, "") } END { print n + 0 }')
  else
    add_error "es: settings query failed: $ERR"
  fi
  _maxpct=null
  if es_get "$_es/_cat/allocation?h=disk.percent"; then
    _maxpct=$(printf '%s\n' "$OUT" | awk '
      $1 ~ /^[0-9]+(\.[0-9]+)?$/ { v = $1 + 0; if (!seen || v > m) m = v; seen = 1 }
      END { if (!seen) print "null"; else print (m > 100 ? 100 : m) }')
  else
    add_error "es: allocation query failed: $ERR"
  fi
  ES_JSON="{\"reachable\":true,\"blocked_indices\":$_blocked,\"max_disk_pct\":$_maxpct}"
}

assemble_report() {
  REPORT="{\"version\":1,\"agent\":\"$AGENT_VERSION\",\"hostname\":$HOST_JSON,\"time\":$NOW"
  REPORT="$REPORT,\"disks\":$DISKS_JSON,\"memory\":$MEMORY_JSON,\"load\":$LOAD_JSON,\"cpu\":$CPU_JSON"
  REPORT="$REPORT,\"systemd\":$SYSTEMD_JSON,\"docker\":$DOCKER_JSON,\"es\":$ES_JSON"
  REPORT="$REPORT,\"errors\":$(printf '%s' "$ERRORS" | json_lines 50 500)}"
}

# Builds REPORT. Call it with stdin from /dev/null: in central mode stdin is the script itself, and
# a child process reading stdin would swallow the rest of it.
build_report() {
  if have timeout && timeout 5 true >/dev/null 2>&1; then HAVE_TIMEOUT=1; fi
  make_tmp || add_error "agent: cannot create a temporary directory"
  collect_disks
  collect_memory
  collect_load
  collect_cpu
  collect_systemd
  collect_docker
  collect_es
  _host=''
  if have hostname; then _host=$(hostname 2>/dev/null); fi
  [ -n "$_host" ] || _host=$(uname -n 2>/dev/null)
  [ -n "$_host" ] || _host=unknown
  HOST_JSON=$(json_str "$_host" 253)
  NOW=$(date +%s 2>/dev/null)
  case $NOW in
    '' | *[!0-9]*)
      add_error "time: date +%s failed"
      NOW=0
      ;;
  esac
  assemble_report
  # The server takes at most 64 KiB; disks are the only part that can grow that far.
  if [ "${#REPORT}" -gt 65000 ]; then
    add_error "disks: omitted, report too large"
    DISKS_JSON='[]'
    assemble_report
  fi
}

# ---------------------------------------------------------------------------------------------------
# Configuration

valid_url() {
  case $1 in
    *[[:space:]]* | *"$NL"*) return 1 ;;
    http://?* | https://?*) return 0 ;;
    *) return 1 ;;
  esac
}

valid_token() {
  case $1 in vha_*) ;; *) return 1 ;; esac
  [ "${#1}" -eq 47 ] || return 1
  case ${1#vha_} in *[!A-Za-z0-9_-]*) return 1 ;; esac
  return 0
}

load_config() {
  _file=''
  if [ -n "$F_CONFIG" ]; then
    if [ ! -f "$F_CONFIG" ] || [ ! -r "$F_CONFIG" ]; then usage_error "config file not readable: $F_CONFIG"; fi
    _file=$F_CONFIG
  elif [ -f /etc/vantage-agent.conf ] && [ -r /etc/vantage-agent.conf ]; then
    _file=/etc/vantage-agent.conf
  elif [ -n "${HOME:-}" ] && [ -f "$HOME/.config/vantage-agent.conf" ] && [ -r "$HOME/.config/vantage-agent.conf" ]; then
    _file=$HOME/.config/vantage-agent.conf
  fi
  [ -n "$_file" ] || return 0
  sh -n "$_file" 2>/dev/null || usage_error "config file has a syntax error: $_file"
  # "." looks up names without a slash in PATH.
  case $_file in */*) ;; *) _file=./$_file ;; esac
  # The environment beats the file: remember what it set and restore it after sourcing.
  _u_set=${VANTAGE_URL+x} _u=${VANTAGE_URL-}
  _t_set=${VANTAGE_TOKEN+x} _t=${VANTAGE_TOKEN-}
  _e_set=${VANTAGE_ES_URL+x} _e=${VANTAGE_ES_URL-}
  # shellcheck disable=SC1090 # path is only known at run time
  . "$_file"
  if [ -n "$_u_set" ]; then VANTAGE_URL=$_u; fi
  if [ -n "$_t_set" ]; then VANTAGE_TOKEN=$_t; fi
  if [ -n "$_e_set" ]; then VANTAGE_ES_URL=$_e; fi
}

apply_flags() {
  if [ "$F_URL_SET" = 1 ]; then VANTAGE_URL=$F_URL; fi
  if [ "$F_TOKEN_SET" = 1 ]; then VANTAGE_TOKEN=$F_TOKEN; fi
  if [ "$F_ES_SET" = 1 ]; then VANTAGE_ES_URL=$F_ES; fi
  VANTAGE_URL=${VANTAGE_URL:-}
  VANTAGE_TOKEN=${VANTAGE_TOKEN:-}
  VANTAGE_ES_URL=${VANTAGE_ES_URL:-}
  if [ -n "$VANTAGE_ES_URL" ] && ! valid_url "$VANTAGE_ES_URL"; then
    usage_error "VANTAGE_ES_URL must start with http:// or https:// and contain no whitespace"
  fi
}

require_post_config() {
  [ -n "$VANTAGE_URL" ] || usage_error "VANTAGE_URL is not set (--url, environment or config file)"
  valid_url "$VANTAGE_URL" || usage_error "VANTAGE_URL must start with http:// or https:// and contain no whitespace"
  [ -n "$VANTAGE_TOKEN" ] || usage_error "VANTAGE_TOKEN is not set (--token, environment or config file)"
  valid_token "$VANTAGE_TOKEN" || usage_error "VANTAGE_TOKEN must be vha_ followed by 43 characters of A-Z a-z 0-9 _ -"
  VANTAGE_URL=${VANTAGE_URL%/}
}

# ---------------------------------------------------------------------------------------------------
# Agent mode

post_report() {
  have curl || die 1 "curl not found; agent mode needs curl (--print works without it)"
  [ -n "$TMPD" ] || die 1 "cannot create a temporary directory, report not sent"
  printf '%s\n' "$REPORT" >"$TMPD/report.json"
  # The token goes through a 0600 config file, never through the command line (visible in ps).
  printf 'header = "Authorization: Bearer %s"\n' "$VANTAGE_TOKEN" >"$TMPD/auth.conf"
  if curl -fsS -m 20 -K "$TMPD/auth.conf" -H 'Content-Type: application/json' \
    --data-binary "@$TMPD/report.json" -o /dev/null "$VANTAGE_URL/api/ingest/v1/report" </dev/null; then
    return 0
  fi
  die 1 "report not sent to $VANTAGE_URL"
}

# ---------------------------------------------------------------------------------------------------
# Install / uninstall

# sq VALUE: VALUE single-quoted for sh.
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

cron_schedule() {
  _n=$1
  case $_n in '' | *[!0-9]*) return 1 ;; esac
  while :; do
    case $_n in 0?*) _n=${_n#0} ;; *) break ;; esac
  done
  [ "${#_n}" -le 4 ] || return 1
  if [ "$_n" -ge 1 ] && [ "$_n" -le 59 ]; then
    printf '*/%s * * * *' "$_n"
  elif [ "$_n" -eq 60 ]; then
    printf '0 * * * *'
  elif [ "$_n" -gt 60 ] && [ "$_n" -le 1440 ] && [ $((_n % 60)) -eq 0 ]; then
    printf '0 */%s * * *' $((_n / 60))
  else
    return 1
  fi
}

is_root() { [ "$(id -u)" = 0 ]; }

set_paths() {
  if is_root; then
    BIN=/usr/local/bin/vantage-agent
    CONF=/etc/vantage-agent.conf
  else
    [ -n "${HOME:-}" ] || die 1 "HOME is not set"
    BIN=$HOME/.local/bin/vantage-agent
    CONF=$HOME/.config/vantage-agent.conf
  fi
}

# crontab_update [LINE]: drops our line from the current user's crontab and appends LINE if given.
# Works on files, so every other line (blank ones included) stays exactly as it was.
# Returns 1 when there was nothing to remove and nothing to add.
crontab_update() {
  _line=${1:-}
  crontab -l >"$TMPD/crontab.cur" 2>/dev/null || : >"$TMPD/crontab.cur"
  grep -v -F -e "$CRON_MARK" "$TMPD/crontab.cur" >"$TMPD/crontab.new"
  _ours=$(grep -c -F -e "$CRON_MARK" "$TMPD/crontab.cur")
  if [ -z "$_line" ] && [ "$_ours" = 0 ]; then return 1; fi
  if [ -n "$_line" ]; then printf '%s\n' "$_line" >>"$TMPD/crontab.new"; fi
  if [ -s "$TMPD/crontab.new" ]; then
    crontab "$TMPD/crontab.new"
  else
    crontab -r
  fi
}

do_install() {
  _self=$0
  if ! { [ -f "$_self" ] && [ -r "$_self" ] && grep -q '^# vantage-agent: host check agent of Vantage Ops' "$_self"; }; then
    die 1 "--install needs the script as a file, it cannot install itself from a pipe. Download vantage-agent.sh first, then run: sh vantage-agent.sh --install --url URL --token TOKEN"
  fi
  require_post_config
  _schedule=$(cron_schedule "$INTERVAL") || usage_error "--interval must be 1-59, 60 or a multiple of 60 up to 1440 (minutes)"
  set_paths
  if is_root && [ -d /etc/cron.d ]; then
    _cron=cron.d
  elif have crontab; then
    _cron=crontab
  else
    die 1 "no cron found: neither /etc/cron.d (as root) nor the crontab command"
  fi
  case $BIN$CONF in
    *%* | *"$NL"*) die 1 "install paths must not contain % or newlines: $BIN, $CONF" ;;
  esac
  make_tmp || die 1 "cannot create a temporary directory"

  (umask 022 && mkdir -p "${BIN%/*}") || die 1 "cannot create ${BIN%/*}"
  # Temp file + mv: atomic, and works when the running script is the installed binary itself.
  if ! { cp "$_self" "$BIN.tmp.$$" && chmod 755 "$BIN.tmp.$$" && mv -f "$BIN.tmp.$$" "$BIN"; }; then
    rm -f "$BIN.tmp.$$"
    die 1 "cannot install $BIN"
  fi
  info "installed $BIN"

  mkdir -p "${CONF%/*}" || die 1 "cannot create ${CONF%/*}"
  if ! {
    {
      printf '# vantage-agent configuration, written by vantage-agent --install\n'
      printf 'VANTAGE_URL=%s\n' "$(sq "$VANTAGE_URL")"
      printf 'VANTAGE_TOKEN=%s\n' "$(sq "$VANTAGE_TOKEN")"
      printf 'VANTAGE_ES_URL=%s\n' "$(sq "$VANTAGE_ES_URL")"
    } >"$CONF.tmp.$$" && chmod 600 "$CONF.tmp.$$" && mv -f "$CONF.tmp.$$" "$CONF"
  }; then
    rm -f "$CONF.tmp.$$"
    die 1 "cannot write $CONF"
  fi
  info "wrote $CONF (mode 600)"

  if [ "$_cron" = cron.d ]; then
    if ! {
      {
        printf '# Vantage Ops host check agent, written by vantage-agent --install\n'
        printf 'SHELL=/bin/sh\n'
        printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
        printf '%s root %s --config %s >/dev/null 2>&1\n' "$_schedule" "$BIN" "$CONF"
      } >"$CRON_D_FILE" && chmod 644 "$CRON_D_FILE"
    }; then
      die 1 "cannot write $CRON_D_FILE"
    fi
    # A previous install may have used the root crontab; never run twice.
    if have crontab; then crontab_update >/dev/null 2>&1; fi
    info "cron: $CRON_D_FILE ($_schedule)"
  else
    crontab_update "$_schedule $(sq "$BIN") --config $(sq "$CONF") >/dev/null 2>&1 $CRON_MARK" ||
      die 1 "cannot update the crontab"
    if is_root && [ -f "$CRON_D_FILE" ]; then rm -f "$CRON_D_FILE"; fi
    info "cron: crontab of $(id -un 2>/dev/null || id -u) ($_schedule)"
  fi

  # First report exactly as cron will send it: installed binary, written config, no VANTAGE_* env.
  if (
    unset VANTAGE_URL VANTAGE_TOKEN VANTAGE_ES_URL
    "$BIN" --config "$CONF" </dev/null
  ); then
    info "first report sent to $VANTAGE_URL"
  else
    die 1 "installed, but the first report failed (see above); cron retries on schedule ($_schedule)"
  fi
}

do_uninstall() {
  set_paths
  _did=0
  if is_root && [ -f "$CRON_D_FILE" ]; then
    rm -f "$CRON_D_FILE" || die 1 "cannot remove $CRON_D_FILE"
    info "removed $CRON_D_FILE"
    _did=1
  fi
  if have crontab; then
    make_tmp || die 1 "cannot create a temporary directory"
    if crontab_update; then
      info "removed the crontab entry"
      _did=1
    fi
  fi
  for _f in "$CONF" "$BIN"; do
    if [ -e "$_f" ] || [ -L "$_f" ]; then
      rm -f "$_f" || die 1 "cannot remove $_f"
      info "removed $_f"
      _did=1
    fi
  done
  [ "$_did" = 1 ] || info "nothing to remove"
}

# ---------------------------------------------------------------------------------------------------

set_mode() {
  if [ -n "$MODE" ] && [ "$MODE" != "$1" ]; then usage_error "--$1 cannot be combined with --$MODE"; fi
  MODE=$1
}

parse_args() {
  while [ $# -gt 0 ]; do
    _arg=$1
    shift
    case $_arg in
      --*=*)
        _opt=${_arg%%=*}
        _val=${_arg#*=}
        _hasval=1
        ;;
      *)
        _opt=$_arg
        _val=''
        _hasval=0
        ;;
    esac
    case $_opt in
      --print | --install | --uninstall | -h | --help | --version)
        [ "$_hasval" = 0 ] || usage_error "$_opt takes no value"
        ;;
    esac
    case $_opt in
      --print) set_mode print ;;
      --install) set_mode install ;;
      --uninstall) set_mode uninstall ;;
      -h | --help)
        usage
        exit 0
        ;;
      --version)
        printf 'vantage-agent %s\n' "$AGENT_VERSION"
        exit 0
        ;;
      --url | --token | --es-url | --interval | --config)
        if [ "$_hasval" = 0 ]; then
          [ $# -gt 0 ] || usage_error "$_opt needs a value"
          case $1 in -*) usage_error "$_opt needs a value" ;; esac
          _val=$1
          shift
        fi
        case $_opt in
          --url) F_URL=$_val F_URL_SET=1 ;;
          --token) F_TOKEN=$_val F_TOKEN_SET=1 ;;
          --es-url) F_ES=$_val F_ES_SET=1 ;;
          --interval)
            cron_schedule "$_val" >/dev/null || usage_error "--interval must be 1-59, 60 or a multiple of 60 up to 1440 (minutes)"
            INTERVAL=$_val
            ;;
          --config)
            [ -n "$_val" ] || usage_error "--config needs a value"
            F_CONFIG=$_val
            ;;
        esac
        ;;
      --)
        [ $# -eq 0 ] || usage_error "unexpected argument: $1"
        ;;
      *) usage_error "unknown argument: $_arg" ;;
    esac
  done
}

main() {
  parse_args "$@"
  case $MODE in
    uninstall)
      do_uninstall
      return
      ;;
  esac
  load_config
  apply_flags
  case $MODE in
    print)
      build_report </dev/null
      printf '%s\n' "$REPORT"
      ;;
    install) do_install ;;
    *)
      require_post_config
      build_report </dev/null
      post_report
      ;;
  esac
}

main "$@"
