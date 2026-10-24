-- AIRSAFE schema. Idempotent: safe to run on every start.
CREATE TABLE IF NOT EXISTS rooms (
  id                 TEXT PRIMARY KEY,
  position           SERIAL,
  vertical           TEXT NOT NULL DEFAULT 'hospital',
  name               TEXT NOT NULL,
  department         TEXT NOT NULL,
  tier               TEXT NOT NULL,
  room_type          TEXT NOT NULL DEFAULT 'general',
  capacity           INTEGER NOT NULL DEFAULT 4,
  ventilation_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_rooms_vertical ON rooms (vertical);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id               BIGSERIAL PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms (id),
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT now(),
  co2_ppm          DOUBLE PRECISION NOT NULL,
  pm25_ugm3        DOUBLE PRECISION,
  temp_c           DOUBLE PRECISION,
  rh_pct           DOUBLE PRECISION,
  occupancy        INTEGER,
  diff_pressure_pa DOUBLE PRECISION,
  booked           BOOLEAN,
  pm10_ugm3        DOUBLE PRECISION,
  tvoc_ppb         DOUBLE PRECISION,
  air_velocity_ms  DOUBLE PRECISION,
  source           TEXT NOT NULL DEFAULT 'simulator',
  -- verifiable ledger (device readings only; simulated data is never ledgered)
  device_id        TEXT,
  reading_ms       BIGINT,
  raw_body         TEXT,
  signature        TEXT,
  leaf_hash        BYTEA,
  attested         BOOLEAN NOT NULL DEFAULT false,
  batch_id         BIGINT,
  batch_index      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_readings_room_ts ON sensor_readings (room_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_readings_ledger ON sensor_readings (id) WHERE leaf_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_readings_batch ON sensor_readings (batch_id, batch_index) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_readings_sim ON sensor_readings (timestamp) WHERE source = 'simulator';

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  email           TEXT UNIQUE,
  password_hash   TEXT,
  wallet_address  TEXT UNIQUE,
  role            TEXT NOT NULL DEFAULT 'property_admin',
  vertical_access TEXT NOT NULL DEFAULT 'all',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR wallet_address IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS devices (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES rooms (id),
  api_key_hash      TEXT NOT NULL,
  label             TEXT,
  firmware_version  TEXT,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  public_key        BYTEA,
  did               TEXT,
  require_signature BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_devices_room ON devices (room_id);

CREATE TABLE IF NOT EXISTS wallet_nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  message    TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS ledger_batches (
  id               BIGSERIAL PRIMARY KEY,
  root             BYTEA NOT NULL,
  leaf_count       INTEGER NOT NULL,
  from_ms          BIGINT NOT NULL,
  to_ms            BIGINT NOT NULL,
  first_reading_id BIGINT NOT NULL,
  last_reading_id  BIGINT NOT NULL,
  checkpoint_sig   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  anchor_chain_id  BIGINT,
  anchor_contract  TEXT,
  anchor_tx        TEXT,
  anchor_block     BIGINT,
  anchored_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS server_key (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  seed BYTEA NOT NULL
);

-- Databases created by earlier versions: a node with a missing/failed sensor must still report what it can.
ALTER TABLE sensor_readings ALTER COLUMN pm25_ugm3 DROP NOT NULL;
ALTER TABLE sensor_readings ALTER COLUMN temp_c DROP NOT NULL;
ALTER TABLE sensor_readings ALTER COLUMN rh_pct DROP NOT NULL;
ALTER TABLE sensor_readings ALTER COLUMN occupancy DROP NOT NULL;
