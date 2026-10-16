import { getDb } from "./db";
import {
  dayInTz, shouldApplyAccount, shouldApplyDevice,
  type AccountUsage, type Aggregates, type Report, type StoredDevice,
} from "./contract";

export function hubTz(): string {
  return process.env.HUB_TZ || "UTC";
}

export async function saveReport(r: Report, now = Date.now()): Promise<void> {
  const sql = getDb();
  const prevRows = (await sql`SELECT sent_at FROM devices WHERE device_id = ${r.deviceId}`) as { sent_at: string }[];
  const prev = prevRows[0];
  const applyDevice = shouldApplyDevice(prev ? Number(prev.sent_at) : null, r.sentAt);
  if (applyDevice) {
    await sql`
      INSERT INTO devices (device_id, device_name, source, estimated, sent_at, received_at, windows)
      VALUES (${r.deviceId}, ${r.deviceName}, ${r.source}, ${r.estimated}, ${Math.round(r.sentAt)}, now(), ${JSON.stringify(r.windows)}::jsonb)
      ON CONFLICT (device_id) DO UPDATE SET
        device_name = EXCLUDED.device_name, source = EXCLUDED.source, estimated = EXCLUDED.estimated,
        sent_at = EXCLUDED.sent_at, received_at = now(), windows = EXCLUDED.windows
      WHERE devices.sent_at <= EXCLUDED.sent_at`;
    const models = Object.entries(r.windows.today.byModel).map(([model, v]) => ({
      model, messages: Math.round(v.messages), tokens: Math.round(v.tokens),
    }));
    if (models.length) {
      const day = dayInTz(r.sentAt || now, hubTz());
      await sql`
        INSERT INTO daily_usage (device_id, day, model, messages, tokens)
        SELECT ${r.deviceId}, ${day}::date, m.model, m.messages, m.tokens
        FROM jsonb_to_recordset(${JSON.stringify(models)}::jsonb)
          AS m(model text, messages int, tokens bigint)
        ON CONFLICT (device_id, day, model) DO UPDATE SET
          messages = GREATEST(daily_usage.messages, EXCLUDED.messages),
          tokens = GREATEST(daily_usage.tokens, EXCLUDED.tokens)`;
    }
  }
  if (r.account) {
    const curRows = (await sql`SELECT fetched_at FROM account_usage WHERE id = 1`) as { fetched_at: string }[];
    const cur = curRows[0];
    if (shouldApplyAccount(cur ? Number(cur.fetched_at) : null, r.account.fetchedAt)) {
      await sql`
        INSERT INTO account_usage (id, fetched_at, windows, received_at)
        VALUES (1, ${Math.round(r.account.fetchedAt)}, ${JSON.stringify(r.account.windows)}::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, windows = EXCLUDED.windows, received_at = now()
        WHERE account_usage.fetched_at < EXCLUDED.fetched_at`;
    }
  }
}

export async function loadDevices(): Promise<StoredDevice[]> {
  const rows = (await getDb()`
    SELECT device_id, device_name, source, estimated, sent_at, (extract(epoch FROM received_at) * 1000)::bigint AS received_ms, windows
    FROM devices ORDER BY device_name, device_id`) as Record<string, unknown>[];
  return rows.map((r) => ({
    deviceId: r.device_id as string,
    deviceName: r.device_name as string,
    source: r.source as string,
    estimated: r.estimated as boolean,
    sentAt: Number(r.sent_at),
    receivedAt: Number(r.received_ms),
    windows: r.windows as Aggregates,
  }));
}

export async function loadAccount(): Promise<(AccountUsage & { receivedAt: number }) | null> {
  const rows = (await getDb()`
    SELECT fetched_at, windows, (extract(epoch FROM received_at) * 1000)::bigint AS received_ms
    FROM account_usage WHERE id = 1`) as Record<string, unknown>[];
  if (!rows.length) return null;
  return {
    fetchedAt: Number(rows[0].fetched_at),
    windows: rows[0].windows as AccountUsage["windows"],
    receivedAt: Number(rows[0].received_ms),
  };
}

export interface DailyRow { deviceId: string; day: string; model: string; messages: number; tokens: number }

export async function loadDaily(days = 30): Promise<DailyRow[]> {
  const rows = (await getDb()`
    SELECT device_id, to_char(day, 'YYYY-MM-DD') AS day, model, messages, tokens
    FROM daily_usage WHERE day >= (now() AT TIME ZONE ${hubTz()})::date - ${days - 1}::int
    ORDER BY day`) as Record<string, unknown>[];
  return rows.map((r) => ({
    deviceId: r.device_id as string, day: r.day as string, model: r.model as string,
    messages: Number(r.messages), tokens: Number(r.tokens),
  }));
}

export async function deleteDevice(id: string): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`DELETE FROM devices WHERE device_id = ${id} RETURNING device_id`) as unknown[];
  await sql`DELETE FROM daily_usage WHERE device_id = ${id}`;
  return rows.length > 0;
}
