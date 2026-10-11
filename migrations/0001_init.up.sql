-- Enums ---------------------------------------------------------------
CREATE TYPE user_role      AS ENUM ('rider', 'driver', 'admin');
CREATE TYPE driver_status  AS ENUM ('offline', 'online', 'busy');
CREATE TYPE vehicle_type   AS ENUM ('economy', 'comfort', 'xl');
CREATE TYPE ride_status    AS ENUM ('searching', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_drivers');
CREATE TYPE offer_status   AS ENUM ('pending', 'accepted', 'declined', 'expired', 'cancelled');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'wallet');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');

-- Users ---------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'rider',
  rating_avg    NUMERIC(3,2) NOT NULL DEFAULT 5.00,
  rating_count  INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE phone IS NOT NULL;

-- Refresh tokens (opaque, stored hashed, rotated, grouped by family) ----
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   UUID NOT NULL,                 -- one family == one login session
  token_hash  TEXT NOT NULL UNIQUE,          -- sha256 hex of the opaque token
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx    ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx  ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- Drivers ---------------------------------------------------------------
CREATE TABLE drivers (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status         driver_status NOT NULL DEFAULT 'offline',
  license_number TEXT NOT NULL,
  vehicle_make   TEXT NOT NULL,
  vehicle_model  TEXT NOT NULL,
  vehicle_color  TEXT NOT NULL,
  plate_number   TEXT NOT NULL,
  vehicle_type   vehicle_type NOT NULL DEFAULT 'economy',
  last_lat       DOUBLE PRECISION,
  last_lng       DOUBLE PRECISION,
  last_seen_at   TIMESTAMPTZ,
  total_earnings NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX drivers_plate_uq ON drivers (upper(plate_number));
CREATE INDEX drivers_status_idx ON drivers (status);

-- Rides -----------------------------------------------------------------
CREATE TABLE rides (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id              UUID NOT NULL REFERENCES users(id),
  driver_id             UUID REFERENCES users(id),
  status                ride_status NOT NULL DEFAULT 'searching',
  vehicle_type          vehicle_type NOT NULL DEFAULT 'economy',
  pickup_lat            DOUBLE PRECISION NOT NULL,
  pickup_lng            DOUBLE PRECISION NOT NULL,
  pickup_address        TEXT,
  dropoff_lat           DOUBLE PRECISION NOT NULL,
  dropoff_lng           DOUBLE PRECISION NOT NULL,
  dropoff_address       TEXT,
  estimated_distance_km NUMERIC(8,2) NOT NULL,
  estimated_duration_min NUMERIC(8,1) NOT NULL,
  estimated_fare        NUMERIC(10,2) NOT NULL,
  final_distance_km     NUMERIC(8,2),
  final_fare            NUMERIC(10,2),
  platform_fee          NUMERIC(10,2),
  driver_earnings       NUMERIC(10,2),
  currency              CHAR(3) NOT NULL DEFAULT 'PHP',
  payment_method        payment_method NOT NULL DEFAULT 'cash',
  cancelled_by          TEXT,                -- rider | driver | system
  cancel_reason         TEXT,
  rider_rating          SMALLINT CHECK (rider_rating BETWEEN 1 AND 5),
  driver_rating         SMALLINT CHECK (driver_rating BETWEEN 1 AND 5),
  rider_comment         TEXT,
  driver_comment        TEXT,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ,
  arrived_at            TIMESTAMPTZ,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rides_rider_idx  ON rides (rider_id, requested_at DESC);
CREATE INDEX rides_driver_idx ON rides (driver_id, requested_at DESC);
CREATE INDEX rides_status_idx ON rides (status, requested_at);
-- A rider can only have one live ride, a driver can only serve one live ride.
CREATE UNIQUE INDEX rides_one_active_rider_uq
  ON rides (rider_id) WHERE status IN ('searching','accepted','arrived','in_progress');
CREATE UNIQUE INDEX rides_one_active_driver_uq
  ON rides (driver_id) WHERE driver_id IS NOT NULL AND status IN ('accepted','arrived','in_progress');

-- Offers: a ride is offered to one driver at a time ---------------------
CREATE TABLE ride_offers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id    UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     offer_status NOT NULL DEFAULT 'pending',
  distance_km NUMERIC(8,2),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  UNIQUE (ride_id, driver_id)
);
CREATE INDEX ride_offers_driver_pending_idx ON ride_offers (driver_id) WHERE status = 'pending';
CREATE INDEX ride_offers_expiry_idx ON ride_offers (expires_at) WHERE status = 'pending';

-- Ride audit trail ------------------------------------------------------
CREATE TABLE ride_events (
  id         BIGSERIAL PRIMARY KEY,
  ride_id    UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   UUID,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ride_events_ride_idx ON ride_events (ride_id, id);

-- Payments --------------------------------------------------------------
CREATE TABLE payments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id    UUID NOT NULL UNIQUE REFERENCES rides(id),
  rider_id   UUID NOT NULL REFERENCES users(id),
  driver_id  UUID NOT NULL REFERENCES users(id),
  amount     NUMERIC(10,2) NOT NULL,
  currency   CHAR(3) NOT NULL,
  method     payment_method NOT NULL,
  status     payment_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Housekeeping run log --------------------------------------------------
CREATE TABLE housekeeping_runs (
  id          BIGSERIAL PRIMARY KEY,
  job         TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  affected    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX housekeeping_runs_job_idx ON housekeeping_runs (job, started_at DESC);
