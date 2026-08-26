#!/bin/bash

# ~/script-FUP/fup-coa-reset.sh
# Production-Safe FUP Reset
# Usage: ./fup-coa-reset.sh [username] [--coa]

NAS_IP="10.6.7.1"
NAS_SECRET="hotspotmikrotik06"
COA_PORT="3799"
DB_NAME="raddb"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/fup-coa.log"
RADCLIENT="/usr/bin/radclient"
RADCLIENT_DICT="/usr/share/freeradius"
RADCLIENT_DICT_DIR="/etc/freeradius/3.0"
LOCK_FILE="/tmp/fup-coa-reset.lock"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

sql_escape() {
    local input="$1"
    printf '%s' "${input//\'/\\\'}"
}

TARGET_USER="${1:-}"
SEND_COA="0"

if [ "${2:-}" = "--coa" ]; then
    SEND_COA="1"
fi

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    log "WARNING: Script already running"
    exit 0
fi

trap 'flock -u 200' EXIT

log "=========================================="
log "START: FUP Reset"

TODAY="$(date '+%Y-%m-%d')"

if [ -n "$TARGET_USER" ]; then
    log "RESET: User=$TARGET_USER COA=$SEND_COA"
    TARGET_USER_ESC=$(sql_escape "$TARGET_USER")
    WHERE_FUP="WHERE username = '$TARGET_USER_ESC'"
else
    log "RESET: ALL users COA=$SEND_COA"
    WHERE_FUP=""
fi

# ==================== RESET FUP STATE ====================
mysql "$DB_NAME" -e "
    UPDATE fup_state
    SET fup_date = '$TODAY',
        throttled = 0,
        last_updated = NOW()
    $WHERE_FUP
" 2>/dev/null

if [ $? -ne 0 ]; then
    log "ERROR: Failed to reset fup_state"
    exit 1
fi

# ==================== RESET SESSION STATE ====================
if [ -n "$TARGET_USER" ]; then
    # Reset active sessions for this user
    mysql "$DB_NAME" -e "
        UPDATE fup_session_state fss
        JOIN radacct ra ON ra.acctuniqueid = fss.acctuniqueid
            AND ra.acctstoptime IS NULL
        SET fss.last_input = COALESCE(ra.acctinputoctets, 0),
            fss.last_output = COALESCE(ra.acctoutputoctets, 0),
            fss.daily_input = 0,
            fss.daily_output = 0,
            fss.usage_date = '$TODAY',
            fss.last_seen = NOW(),
            fss.closed = 0
        WHERE fss.username = '$TARGET_USER_ESC'
    " 2>/dev/null

    # Reset closed sessions
    mysql "$DB_NAME" -e "
        UPDATE fup_session_state
        SET daily_input = 0,
            daily_output = 0,
            usage_date = '$TODAY'
        WHERE username = '$TARGET_USER_ESC'
            AND closed = 1
    " 2>/dev/null
else
    # Reset all active sessions
    mysql "$DB_NAME" -e "
        UPDATE fup_session_state fss
        JOIN radacct ra ON ra.acctuniqueid = fss.acctuniqueid
            AND ra.acctstoptime IS NULL
        SET fss.last_input = COALESCE(ra.acctinputoctets, 0),
            fss.last_output = COALESCE(ra.acctoutputoctets, 0),
            fss.daily_input = 0,
            fss.daily_output = 0,
            fss.usage_date = '$TODAY',
            fss.last_seen = NOW(),
            fss.closed = 0
    " 2>/dev/null

    # Reset all closed sessions
    mysql "$DB_NAME" -e "
        UPDATE fup_session_state
        SET daily_input = 0,
            daily_output = 0,
            usage_date = '$TODAY'
        WHERE closed = 1
    " 2>/dev/null
fi

log "RESET: State reset complete"

# ==================== OPTIONAL CoA RESTORE ====================
if [ "$SEND_COA" = "1" ] && [ -n "$TARGET_USER" ]; then

    # Get normal rate - check fup_state first, then radcheck
    normal_rate=$(mysql "$DB_NAME" -N -B -e "
        SELECT COALESCE(
            (SELECT normal_rate FROM fup_state
             WHERE username = '$TARGET_USER_ESC'
               AND normal_rate IS NOT NULL
               AND normal_rate != ''
               AND normal_rate != '0'
             LIMIT 1),
            (SELECT rc.value FROM radcheck rc
             WHERE rc.username = '$TARGET_USER_ESC'
               AND rc.attribute = 'Mikrotik-Rate-Limit'
             ORDER BY rc.id DESC LIMIT 1),
            (SELECT rr.value FROM radreply rr
             WHERE rr.username = '$TARGET_USER_ESC'
               AND rr.attribute = 'Mikrotik-Rate-Limit'
             ORDER BY rr.id DESC LIMIT 1),
            '0'
        )
    " 2>/dev/null)

    log "DEBUG: Resolved normal_rate='$normal_rate' for $TARGET_USER"

    if [ -z "$normal_rate" ] || [ "$normal_rate" = "0" ]; then
        log "ERROR: No normal rate found for $TARGET_USER"
        exit 1
    fi

    log "COA_RESTORE: $TARGET_USER -> $normal_rate"

    # Get all active IPs
    active_ips=$(mysql "$DB_NAME" -N -B -e "
        SELECT DISTINCT framedipaddress
        FROM radacct
        WHERE username = '$TARGET_USER_ESC'
            AND acctstoptime IS NULL
            AND framedipaddress IS NOT NULL
            AND framedipaddress <> ''
    " 2>/dev/null)

    coa_success="0"

    while IFS= read -r ip; do
        [ -z "$ip" ] && continue

        log "COA_SENT: $TARGET_USER IP=$ip -> $normal_rate"

        coa_output=$(
            timeout 5 "$RADCLIENT" -x -d "$RADCLIENT_DICT" -D "$RADCLIENT_DICT_DIR" \
                "$NAS_IP:$COA_PORT" coa "$NAS_SECRET" <<EOF
User-Name = "$TARGET_USER"
Framed-IP-Address = $ip
Mikrotik-Rate-Limit := "$normal_rate"
EOF
        2>&1
        )

        echo "$coa_output" >> "$LOG_FILE"

        if echo "$coa_output" | grep -q "Received CoA-ACK"; then
            log "COA_ACK: $TARGET_USER IP=$ip -> $normal_rate"
            coa_success="1"
        else
            log "COA_FAILED: $TARGET_USER IP=$ip"
        fi

    done <<< "$active_ips"

    if [ "$coa_success" = "1" ]; then
        log "RESET: $TARGET_USER restored to $normal_rate"
    else
        log "WARNING: CoA restore failed for $TARGET_USER"
    fi
fi

log "END: FUP Reset"
log "=========================================="
