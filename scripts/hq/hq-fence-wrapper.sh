#!/bin/sh
# FENCE-LIGHT (0.2.23) — sourced by the installed hq-fence wrapper (src/hq/fence-wrapper.ts renderHqFenceWrapper),
# from the installed package root, only when "$CONFIG_DIR/hq/lease-cache" exists. Inherits ROLE, "$@", BUN, ENTRY,
# CONFIG_DIR, LOG, log_line, alert. Always exits.
#
# Cache line (written only by a successful holder renewal in hqHeartbeat; removed at every heartbeat start,
# by every successful lease action and by every CLI «do not run»):
#   <holder> <generation> <expiresAt> <host> <machine> <confirmedAt>
#
# Fast path (no bun, no network) ONLY when every check below holds; anything else is DECISION=cli, i.e. the
# same installed CLI decision as before (`hq fence --role`), under the role's time limit.
#   holder = cache host = ~/.elanous-hq/host · machine = `hostname` · confirmedAt <= now < confirmedAt+660
#   now < expiresAt <= confirmedAt+660 · local.json starts {"holder":<it>,"generation":<it> · seen-generation <= it
#   Every file one line; numbers without leading zeros (an arithmetic error must never abort before the CLI).
# There is no fast «skip»: a cache that names another holder goes to the CLI.
#
# Time limit per role (seconds). The watchdog is GNU timeout: it puts the fenced command in its own process
# group and signals only that group (TERM, then KILL after 5s) — never anything by name.
case "$ROLE" in
  telegram-poller|release-run) LIMIT=3600 ;;
  seat-loop) LIMIT=1800 ;;
  cron|conatus) LIMIT=900 ;;
  git-push|ledger-cli) LIMIT=120 ;;
  *) LIMIT= ;;
esac

# Watchdog: PATH first (cron PATH is /usr/bin:/bin), then Homebrew coreutils. HQ_FENCE_WATCHDOGS overrides the
# absolute candidates (tests). None found = the legacy CLI command without a limit, with one evidence line.
TIMEOUT=
for t in timeout gtimeout ${HQ_FENCE_WATCHDOGS-/opt/homebrew/bin/timeout /opt/homebrew/bin/gtimeout /usr/local/bin/timeout /usr/local/bin/gtimeout}; do
  case "$t" in
    /*) if [ -x "$t" ]; then TIMEOUT=$t; break; fi ;;
    *) p=$(command -v "$t" 2>/dev/null) && [ -n "$p" ] && { TIMEOUT=$p; break; } ;;
  esac
done

DECISION=cli
WHY=
FL_CACHE="$CONFIG_DIR/hq/lease-cache"
FL_HOST_FILE="$HOME/.elanous-hq/host"
FL_LOCAL="$CONFIG_DIR/hq/local.json"
FL_SEEN="$HOME/.elanous-hq/seen-generation"
if [ -z "$LIMIT" ]; then WHY=unknown-role
elif [ $# -eq 0 ] || [ -z "$*" ]; then WHY=no-command
elif [ -z "$TIMEOUT" ]; then WHY=no-watchdog
elif [ -L "$FL_CACHE" ] || [ ! -f "$FL_CACHE" ] || [ ! -r "$FL_CACHE" ]; then WHY=cache-unreadable
elif [ -L "$FL_HOST_FILE" ] || [ ! -f "$FL_HOST_FILE" ] || [ ! -r "$FL_HOST_FILE" ]; then WHY=no-host-file
elif [ ! -f "$FL_LOCAL" ] || [ ! -r "$FL_LOCAL" ]; then WHY=no-local-state
else
  HOLDER= GENERATION= EXPIRES= CACHE_HOST= CACHE_MACHINE= CONFIRMED= EXTRA= THIS_HOST= LOCAL_LINE= SEEN=
  CACHE_MORE=0 LOCAL_MORE=0
  # Each file must be exactly one newline-terminated line: a second read that succeeds, or that hits EOF
  # with unterminated text, means more content.
  { IFS=' ' read -r HOLDER GENERATION EXPIRES CACHE_HOST CACHE_MACHINE CONFIRMED EXTRA || CACHE_MORE=1
    _FL_REST=; if IFS= read -r _FL_REST || [ -n "$_FL_REST" ]; then CACHE_MORE=1; fi; } < "$FL_CACHE"
  IFS= read -r THIS_HOST < "$FL_HOST_FILE" || true
  { IFS= read -r LOCAL_LINE || LOCAL_MORE=1
    _FL_REST=; if IFS= read -r _FL_REST || [ -n "$_FL_REST" ]; then LOCAL_MORE=1; fi; } < "$FL_LOCAL"
  WHY=malformed
  case "$HOLDER" in ''|*[!A-Za-z0-9_.-]*) ;; *)
  case "$CACHE_MACHINE" in ''|*[!A-Za-z0-9_.-]*) ;; *)
  case "$GENERATION" in ''|0*|*[!0-9]*) ;; *)
  case "$EXPIRES" in ''|0*|*[!0-9]*) ;; *)
  case "$CONFIRMED" in ''|0*|*[!0-9]*) ;; *)
    if [ "$CACHE_MORE" = 1 ] || [ -n "$EXTRA" ] || [ "${#GENERATION}" -gt 15 ] || [ "${#EXPIRES}" -gt 12 ] || [ "${#CONFIRMED}" -gt 12 ]; then WHY=malformed
    elif [ "$HOLDER" != "$THIS_HOST" ] || [ "$CACHE_HOST" != "$THIS_HOST" ]; then WHY=not-this-host
    else
      THIS_MACHINE=$(hostname)
      THIS_MACHINE=${THIS_MACHINE%.local}
      NOW=$(date +%s)
      if [ "$CACHE_MACHINE" != "$THIS_MACHINE" ]; then WHY=other-machine
      elif [ "$CONFIRMED" -gt "$NOW" ] || [ "$NOW" -ge "$((CONFIRMED + 660))" ] \
        || [ "$EXPIRES" -le "$NOW" ] || [ "$EXPIRES" -gt "$((CONFIRMED + 660))" ]; then WHY=stale
      else
        # The CLI's own host-local view must name the same holder and generation as its leading top-level
        # fields — hq.ts writeLocal is JSON.stringify({ holder, generation, ... }) on one line. Anchored at «{»,
        # so a nested or later «holder» never matches; any other shape goes to the CLI.
        if [ "$LOCAL_MORE" = 1 ]; then WHY=local-malformed
        else
          case "$LOCAL_LINE" in
            '{"holder":"'"$HOLDER"'","generation":'"$GENERATION"[,}]*) WHY= ;;
            *) WHY=local-mismatch ;;
          esac
        fi
        if [ -z "$WHY" ] && [ -f "$FL_SEEN" ]; then
          IFS= read -r SEEN < "$FL_SEEN" || true
          case "$SEEN" in
            ''|0*|*[!0-9]*) WHY=seen-unreadable ;;
            *) if [ "${#SEEN}" -gt 15 ] || [ "$SEEN" -gt "$GENERATION" ]; then WHY=seen-newer-generation; fi ;;
          esac
        fi
        if [ -z "$WHY" ]; then DECISION=run; WHY=fresh-holder; fi
      fi
    fi
  ;; esac ;; esac ;; esac ;; esac ;; esac
fi

if [ "$DECISION" = run ]; then
  export ELANOUS_HQ_GENERATION="$GENERATION"
  "$TIMEOUT" -k 5 "$LIMIT" /bin/sh -c "$*"
  rc=$?
elif [ -n "$TIMEOUT" ] && [ -n "$LIMIT" ]; then
  # Same installed CLI decision as the legacy wrapper, bounded by the role limit.
  "$TIMEOUT" -k 5 "$LIMIT" "$BUN" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence --role "$ROLE" -- /bin/sh -c "$*"
  rc=$?
else
  # Unknown role (the CLI rejects it) or no watchdog binary: exactly the legacy command, unbounded.
  if [ "$WHY" = no-watchdog ]; then log_line "fence watchdog unavailable (role=$ROLE) - CLI fence without time limit"; fi
  "$BUN" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence --role "$ROLE" -- /bin/sh -c "$*"
  rc=$?
fi

TIMED_OUT=0
if [ -n "$TIMEOUT" ] && [ -n "$LIMIT" ] && { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; }; then
  TIMED_OUT=1
  log_line "fence timeout role=$ROLE limit=${LIMIT}s rc=$rc decision=$DECISION reason=$WHY"
  echo "hq-fence: timeout role=$ROLE limit=${LIMIT}s rc=$rc" >&2
fi

# LOOPCHECK-FENCE streak: the CLI records it on its own path; the fast path (and a CLI killed by the watchdog)
# records through bun only when it matters — a failure, or a success that must reset a nonzero streak.
if [ "$DECISION" = run ] || [ "$TIMED_OUT" = 1 ]; then
  RECORD=0
  if [ "$rc" -ne 0 ]; then RECORD=1
  else
    FL_OUTCOME="$CONFIG_DIR/hq/fence-outcomes/$ROLE.json"
    if [ -f "$FL_OUTCOME" ]; then
      OUTCOME_LINE=
      IFS= read -r OUTCOME_LINE < "$FL_OUTCOME" || true
      case "$OUTCOME_LINE" in '{"consecutiveFailures":0,'*) ;; *) RECORD=1 ;; esac
    fi
  fi
  if [ "$RECORD" = 1 ]; then
    "$TIMEOUT" -k 5 20 "$BUN" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence-wrapper record "$ROLE" "$rc" \
      || log_line "fence outcome record failed (role=$ROLE rc=$rc)"
  fi
fi

if [ "$rc" -ne 0 ]; then
  if [ -n "$TIMEOUT" ]; then
    # Bounded: an unavailable owner channel must not strand a cron fence.
    "$TIMEOUT" -k 5 20 "$BUN" "$ENTRY" --config-dir "$CONFIG_DIR" hq fence-wrapper alert "hq-fence: fence failed (rc=$rc, role=$ROLE)" \
      || { echo "hq-fence: owner alert failed: fence failed (rc=$rc, role=$ROLE)" >&2; log_line "owner alert failed: fence failed (rc=$rc, role=$ROLE)"; }
  else
    alert "hq-fence: fence failed (rc=$rc, role=$ROLE)"
  fi
fi
exit "$rc"
