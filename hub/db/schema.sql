CREATE TABLE IF NOT EXISTS devices (
  device_id    text PRIMARY KEY,
  device_name  text NOT NULL,
  source       text NOT NULL,
  estimated    boolean NOT NULL DEFAULT false,
  sent_at      bigint NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  windows      jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS account_usage (
  id           int PRIMARY KEY CHECK (id = 1),
  fetched_at   bigint NOT NULL,
  windows      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_usage (
  device_id text NOT NULL,
  day       date NOT NULL,
  model     text NOT NULL,
  messages  int NOT NULL DEFAULT 0,
  tokens    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, day, model)
);

CREATE INDEX IF NOT EXISTS daily_usage_day_idx ON daily_usage (day);
