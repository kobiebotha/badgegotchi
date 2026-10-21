export const ACTIVE_SESSION_QUERY = `
  SELECT * FROM sessions WHERE state IN ('active', 'paused')
  ORDER BY started_at DESC LIMIT 1`;

export const TODAY_SESSIONS_QUERY = `
  SELECT * FROM sessions WHERE day_key = ? ORDER BY started_at DESC`;

export const WELLNESS_QUERY = `
  SELECT * FROM wellness_events WHERE day_key = ? ORDER BY occurred_at DESC`;

export const CURRENT_PET_QUERY = `
  SELECT * FROM pet_sessions ORDER BY updated_at DESC LIMIT 1`;

export const ACTIVE_PET_EVENT_QUERY = `
  SELECT event.* FROM badge_projection AS projection
  JOIN pet_events AS event
    ON event.id = json_extract(projection.payload, '$.latest_event_id')
    AND event.pet_session_id = json_extract(projection.payload, '$.id')
  WHERE projection.kind = 'pet'
    AND json_extract(projection.payload, '$.status') IN ('pending', 'processing')
  LIMIT 1`;

/**
 * Query all source tables together so useQuery updates on local AND downloaded
 * events. Counter values are never written back to the upload queue.
 * Parameters: dayKey, userId + ':' + dayKey, fallback opened-at ISO timestamp.
 */
export const DAILY_SUMMARY_QUERY = `
  WITH day AS (SELECT ? AS day_key, ? AS fallback_id, ? AS fallback_stamp),
  totals AS (
    SELECT
      (SELECT count(*) FROM sessions
       WHERE day_key = day.day_key AND state = 'ended' AND type = 'focus') AS ended_focus_count,
      (SELECT count(*) FROM sessions
       WHERE day_key = day.day_key AND state = 'ended' AND type = 'break') AS ended_break_count,
      (SELECT count(*) FROM wellness_events
       WHERE day_key = day.day_key AND type = 'hydration') AS hydration_count,
      (SELECT count(*) FROM wellness_events
       WHERE day_key = day.day_key AND type = 'movement') AS movement_count,
      (SELECT max(occurred_at) FROM wellness_events
       WHERE day_key = day.day_key AND type = 'hydration') AS last_hydration_at
    FROM day
  )
  SELECT coalesce(summary.id, day.fallback_id) AS id, day.day_key,
    totals.ended_focus_count, totals.ended_break_count,
    totals.hydration_count, totals.movement_count, totals.last_hydration_at,
    CASE WHEN totals.last_hydration_at IS NOT NULL AND
      (summary.hydration_timer_anchor_at IS NULL OR
       julianday(totals.last_hydration_at) >= julianday(summary.hydration_timer_anchor_at))
      THEN totals.last_hydration_at
      ELSE coalesce(summary.hydration_timer_anchor_at, day.fallback_stamp)
    END AS hydration_timer_anchor_at,
    CASE WHEN totals.last_hydration_at IS NOT NULL AND
      (summary.hydration_timer_anchor_at IS NULL OR
       julianday(totals.last_hydration_at) >= julianday(summary.hydration_timer_anchor_at))
      THEN 0 ELSE coalesce(summary.hydration_reminder_active, 0)
    END AS hydration_reminder_active,
    coalesce(summary.updated_at, day.fallback_stamp) AS updated_at
  FROM day CROSS JOIN totals
  LEFT JOIN daily_activity_summary AS summary ON summary.day_key = day.day_key
  LIMIT 1`;

export function dailySummaryParameters(
  dayKey: string,
  userId: string,
  openedAt: Date,
): string[] {
  return [dayKey, `${userId}:${dayKey}`, openedAt.toISOString()];
}
