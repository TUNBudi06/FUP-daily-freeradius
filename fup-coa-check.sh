#!/bin/bash

# ~/script-FUP/fup-coa-check.sh
# Production-Safe FUP Check with Per-Session Accounting
# Fixed: sql_escape function

# ==================== CONFIGURATION ====================
NAS_IP="10.6.7.1"
NAS_SECRET="hotspotmikrotik06"
COA_PORT="3799"
DB_NAME="raddb"
DEFAULT_FUP_RATE="5M/5M"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/fup-coa.log"
RADCLIENT="/usr/bin/radclient"
RADCLIENT_DICT="/usr/share/freeradius"
RADCLIENT_DICT_DIR="/etc/freeradius/3.0"
LOCK_FILE="/tmp/fup-coa-check.lock"

# ==================== FUNCTIONS ====================
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

is_valid_ip() {
    local ip="$1"
    [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
    IFS='.' read -r a b c d <<< "$ip"
    [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ]
}

is_valid_rate() {
    local rate="$1"
    [[ "$rate" =~ ^[0-9]+[KMGkmg]/[0-9]+[KMGkmg] ]] || return 1
}

# FIXED: sql_escape - only escape single quotes
sql_escape() {
    local input="$1"
    printf '%s' "${input//\'/\\\'}"
}

# ==================== CHECK DEPENDENCIES ====================
if [ ! -f "$RADCLIENT" ]; then
    log "ERROR: radclient not found"
    exit 1
fi

if ! mysql "$DB_NAME" -e "SELECT 1" >/dev/null 2>&1; then
    log "ERROR: Cannot connect to MySQL"
    exit 1
fi

# ==================== LOCK ====================
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    log "WARNING: Script already running"
    exit 0
fi

TEMP_FILE=$(mktemp)
trap 'flock -u 200; rm -f "$TEMP_FILE"' EXIT

log "=========================================="
log "START: FUP Check"

TODAY="$(date '+%Y-%m-%d')"

# ==================== FETCH ACTIVE SESSIONS ====================
mysql "$DB_NAME" -N -B -e "
SELECT
    ra.username,
    ra.acctuniqueid,
    COALESCE(ra.acctsessionid, ''),
    ra.framedipaddress,
    COALESCE(ra.acctinputoctets, 0),
    COALESCE(ra.acctoutputoctets, 0),
    COALESCE(
        (SELECT rc.value FROM radcheck rc
         WHERE rc.username = ra.username AND rc.attribute = 'Max-Daily-Traffic'
         ORDER BY rc.id DESC LIMIT 1),
        (SELECT gc.value FROM radusergroup ug
         JOIN radgroupcheck gc ON gc.groupname = ug.groupname AND gc.attribute = 'Max-Daily-Traffic'
         WHERE ug.username = ra.username ORDER BY ug.priority ASC LIMIT 1),
        '0'
    ) AS max_daily,
    COALESCE(
        (SELECT rc.value FROM radcheck rc
         WHERE rc.username = ra.username AND rc.attribute = 'Mikrotik-Rate-Limit'
         ORDER BY rc.id DESC LIMIT 1),
        (SELECT rr.value FROM radreply rr
         WHERE rr.username = ra.username AND rr.attribute = 'Mikrotik-Rate-Limit'
         ORDER BY rr.id DESC LIMIT 1),
        (SELECT gc.value FROM radusergroup ug
         JOIN radgroupcheck gc ON gc.groupname = ug.groupname AND gc.attribute = 'Mikrotik-Rate-Limit'
         WHERE ug.username = ra.username ORDER BY ug.priority ASC LIMIT 1),
        (SELECT gr.value FROM radusergroup ug
         JOIN radgroupreply gr ON ug.groupname = gr.groupname AND gr.attribute = 'Mikrotik-Rate-Limit'
         WHERE ug.username = ra.username ORDER BY ug.priority ASC LIMIT 1),
        '0'
    ) AS normal_rate,
    COALESCE(
        (SELECT rc.value FROM radcheck rc
         WHERE rc.username = ra.username AND rc.attribute = 'FUP-Rate-Limit'
         ORDER BY rc.id DESC LIMIT 1),
        (SELECT rr.value FROM radreply rr
         WHERE rr.username = ra.username AND rr.attribute = 'FUP-Rate-Limit'
         ORDER BY rr.id DESC LIMIT 1),
        (SELECT gc.value FROM radusergroup ug
         JOIN radgroupcheck gc ON gc.groupname = ug.groupname AND gc.attribute = 'FUP-Rate-Limit'
         WHERE ug.username = ra.username ORDER BY ug.priority ASC LIMIT 1),
        (SELECT gr.value FROM radusergroup ug
         JOIN radgroupreply gr ON ug.groupname = gr.groupname AND gr.attribute = 'FUP-Rate-Limit'
         WHERE ug.username = ra.username ORDER BY ug.priority ASC LIMIT 1),
        '0'
    ) AS fup_rate
FROM radacct ra
WHERE ra.acctstoptime IS NULL
    AND ra.username IS NOT NULL
    AND ra.username <> ''
    AND ra.framedipaddress IS NOT NULL
    AND ra.framedipaddress <> ''
    AND ra.acctuniqueid IS NOT NULL
    AND ra.acctuniqueid <> ''
" > "$TEMP_FILE" 2>/dev/null

if [ ! -s "$TEMP_FILE" ]; then
    log "No active sessions found"
    exit 0
fi

# ==================== PROCESS SESSIONS ====================
declare -A USER_DAILY_USAGE
declare -A USER_MAX_DAILY
declare -A USER_NORMAL_RATE
declare -A USER_FUP_RATE

while IFS=$'\t' read -r username acctuniqueid acctsessionid framed_ip current_input current_output max_daily normal_rate fup_rate; do

    [ -z "$username" ] && continue
    [ -z "$acctuniqueid" ] && continue

    if ! is_valid_ip "$framed_ip"; then
        log "SKIP: $username - invalid IP '$framed_ip'"
        continue
    fi

    # Escape SQL
    username_esc=$(sql_escape "$username")
    acctuniqueid_esc=$(sql_escape "$acctuniqueid")
    acctsessionid_esc=$(sql_escape "$acctsessionid")
    framed_ip_esc=$(sql_escape "$framed_ip")

    # Store user attributes
    USER_MAX_DAILY["$username"]="$max_daily"
    USER_NORMAL_RATE["$username"]="$normal_rate"
    USER_FUP_RATE["$username"]="$fup_rate"

    # Get existing session state
    session_state=$(mysql "$DB_NAME" -N -B -e "
        SELECT CONCAT(
            COALESCE(last_input, 0), '|',
            COALESCE(last_output, 0), '|',
            COALESCE(daily_input, 0), '|',
            COALESCE(daily_output, 0), '|',
            COALESCE(usage_date, '$TODAY'), '|',
            COALESCE(closed, 0)
        )
        FROM fup_session_state
        WHERE acctuniqueid = '$acctuniqueid_esc'
        LIMIT 1
    " 2>/dev/null)

    last_input="0"; last_output="0"
    daily_input="0"; daily_output="0"
    usage_date="$TODAY"; closed="0"

    if [ -n "$session_state" ]; then
        IFS='|' read -r last_input last_output daily_input daily_output usage_date closed <<< "$session_state"
        [[ "$last_input" =~ ^[0-9]+$ ]] || last_input="0"
        [[ "$last_output" =~ ^[0-9]+$ ]] || last_output="0"
        [[ "$daily_input" =~ ^[0-9]+$ ]] || daily_input="0"
        [[ "$daily_output" =~ ^[0-9]+$ ]] || daily_output="0"
    fi

    # Handle new day
    if [ "$usage_date" != "$TODAY" ]; then
        log "NEW_DAY: $username session $acctuniqueid"
        daily_input="0"
        daily_output="0"
        last_input="$current_input"
        last_output="$current_output"
        usage_date="$TODAY"
    fi

    # Calculate delta
    if [ "$current_input" -ge "$last_input" ]; then
        delta_input=$(( current_input - last_input ))
    else
        delta_input="$current_input"
        log "COUNTER_RESET: input $last_input -> $current_input"
    fi

    if [ "$current_output" -ge "$last_output" ]; then
        delta_output=$(( current_output - last_output ))
    else
        delta_output="$current_output"
        log "COUNTER_RESET: output $last_output -> $current_output"
    fi

    daily_input=$(( daily_input + delta_input ))
    daily_output=$(( daily_output + delta_output ))

    log "DELTA: $username session=$acctuniqueid delta_in=$delta_input delta_out=$delta_output daily=$(( daily_input + daily_output ))"

    # UPSERT session state
    mysql "$DB_NAME" -e "
        INSERT INTO fup_session_state
            (username, acctuniqueid, acctsessionid, framedipaddress,
             last_input, last_output, usage_date, daily_input, daily_output, last_seen, closed)
        VALUES
            ('$username_esc', '$acctuniqueid_esc', '$acctsessionid_esc', '$framed_ip_esc',
             $current_input, $current_output, '$TODAY', $daily_input, $daily_output, NOW(), 0)
        ON DUPLICATE KEY UPDATE
            username = VALUES(username),
            acctsessionid = VALUES(acctsessionid),
            framedipaddress = VALUES(framedipaddress),
            last_input = VALUES(last_input),
            last_output = VALUES(last_output),
            usage_date = VALUES(usage_date),
            daily_input = VALUES(daily_input),
            daily_output = VALUES(daily_output),
            last_seen = NOW(),
            closed = 0
    " 2>/dev/null

    if [ $? -ne 0 ]; then
        log "ERROR: Failed to update session state for $username"
        continue
    fi

    # Accumulate daily usage per user
    USER_DAILY_USAGE["$username"]=$(( ${USER_DAILY_USAGE["$username"]:-0} + daily_input + daily_output ))

done < "$TEMP_FILE"

# ==================== MARK CLOSED SESSIONS ====================
mysql "$DB_NAME" -e "
    UPDATE fup_session_state fss
    SET fss.closed = 1
    WHERE fss.closed = 0
        AND fss.acctuniqueid NOT IN (
            SELECT DISTINCT acctuniqueid FROM radacct WHERE acctstoptime IS NULL
        )
" 2>/dev/null

# ==================== CHECK FUP FOR EACH USER ====================
for username in "${!USER_DAILY_USAGE[@]}"; do

    total_usage="${USER_DAILY_USAGE[$username]}"
    max_daily="${USER_MAX_DAILY[$username]}"
    normal_rate="${USER_NORMAL_RATE[$username]}"
    fup_rate="${USER_FUP_RATE[$username]}"

    [ -z "$max_daily" ] && continue
    [ "$max_daily" = "0" ] && continue

    log "DAILY_USAGE: $username = $total_usage bytes (quota=$max_daily)"

    username_esc=$(sql_escape "$username")

    # Get fup_state
    fup_state=$(mysql "$DB_NAME" -N -B -e "
        SELECT CONCAT(
            COALESCE(throttled, 0), '|',
            COALESCE(normal_rate, '0'), '|',
            COALESCE(fup_date, '$TODAY')
        )
        FROM fup_state
        WHERE username = '$username_esc'
        LIMIT 1
    " 2>/dev/null)

    throttled="0"; saved_rate="$normal_rate"; fup_date="$TODAY"

    if [ -n "$fup_state" ]; then
        IFS='|' read -r throttled saved_rate fup_date <<< "$fup_state"
        [[ "$throttled" =~ ^[0-1]$ ]] || throttled="0"
    else
        mysql "$DB_NAME" -e "
            INSERT INTO fup_state (username, normal_rate, fup_date, throttled, last_updated)
            VALUES ('$username_esc', '$saved_rate', '$TODAY', 0, NOW())
        " 2>/dev/null
    fi

    # Handle new day
    if [ "$fup_date" != "$TODAY" ]; then
        log "NEW_DAY: $username - resetting throttled"
        throttled="0"
        mysql "$DB_NAME" -e "
            UPDATE fup_state
            SET fup_date = '$TODAY', throttled = 0, last_updated = NOW()
            WHERE username = '$username_esc'
        " 2>/dev/null
    fi

    # Skip if already throttled
    if [ "$throttled" = "1" ]; then
        continue
    fi

    # Check quota
    if [ "$total_usage" -lt "$max_daily" ]; then
        continue
    fi

    log "FUP_REACHED: $username (usage=$total_usage >= quota=$max_daily)"

    # Determine FUP rate
    if [ -z "$fup_rate" ] || [ "$fup_rate" = "0" ]; then
        fup_rate="$DEFAULT_FUP_RATE"
    fi

    if ! is_valid_rate "$fup_rate"; then
        log "ERROR: Invalid FUP rate '$fup_rate' for $username"
        continue
    fi

    # Save normal rate
    if [ -n "$normal_rate" ] && [ "$normal_rate" != "0" ]; then
        saved_rate="$normal_rate"
    fi

    mysql "$DB_NAME" -e "
        UPDATE fup_state
        SET normal_rate = '$saved_rate',
            fup_date = '$TODAY',
            throttled = 0,
            last_updated = NOW()
        WHERE username = '$username_esc'
    " 2>/dev/null

    # ==================== SEND CoA TO ALL ACTIVE SESSIONS ====================
    coa_success="0"

    active_ips=$(mysql "$DB_NAME" -N -B -e "
        SELECT DISTINCT framedipaddress
        FROM radacct
        WHERE username = '$username_esc'
            AND acctstoptime IS NULL
            AND framedipaddress IS NOT NULL
            AND framedipaddress <> ''
    " 2>/dev/null)

    while IFS= read -r ip; do
        [ -z "$ip" ] && continue

        log "COA_SENT: $username IP=$ip -> $fup_rate"

        coa_output=$(
            timeout 5 "$RADCLIENT" -x -d "$RADCLIENT_DICT" -D "$RADCLIENT_DICT_DIR" \
                "$NAS_IP:$COA_PORT" coa "$NAS_SECRET" <<EOF
User-Name = "$username"
Framed-IP-Address = $ip
Mikrotik-Rate-Limit := "$fup_rate"
EOF
        2>&1
        )

        echo "$coa_output" >> "$LOG_FILE"

        if echo "$coa_output" | grep -q "Received CoA-ACK"; then
            log "COA_ACK: $username IP=$ip -> $fup_rate"
            coa_success="1"
        else
            log "COA_FAILED: $username IP=$ip"
        fi

    done <<< "$active_ips"

    if [ "$coa_success" = "1" ]; then
        mysql "$DB_NAME" -e "
            UPDATE fup_state
            SET throttled = 1, last_updated = NOW()
            WHERE username = '$username_esc'
        " 2>/dev/null
        log "THROTTLED: $username -> $fup_rate (restore=$saved_rate)"
    else
        log "COA_FAILED: $username - will retry next cycle"
    fi

done

log "SUMMARY: Processed ${#USER_DAILY_USAGE[@]} users"
log "END: FUP Check"
log "=========================================="
