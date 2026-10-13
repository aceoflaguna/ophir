CREATE TABLE ride_messages (
  id         BIGSERIAL PRIMARY KEY,
  ride_id    UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ride_messages_ride_idx    ON ride_messages (ride_id, id);   -- polling: ride_id = $1 AND id > $2
CREATE INDEX ride_messages_created_idx ON ride_messages (created_at);    -- retention purge