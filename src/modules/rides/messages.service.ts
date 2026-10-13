import { query, queryOne } from "../../db/pool.ts";
import { conflict, notFound } from "../../lib/errors.ts";

/** Chat is open only while a driver is assigned and the trip is live. */
const LIVE = ["accepted", "arrived", "in_progress"];

export interface ChatMessage {
  id: number;
  rideId: string;
  senderId: string;
  senderRole: "rider" | "driver";
  body: string;
  createdAt: string;
}

interface Row { id: string; ride_id: string; sender_id: string; sender_role: "rider" | "driver"; body: string; created_at: string }
const toMessage = (r: Row): ChatMessage => ({
  id: Number(r.id), rideId: r.ride_id, senderId: r.sender_id, senderRole: r.sender_role, body: r.body, createdAt: r.created_at,
});

/** Only the rider and the assigned driver may touch the thread; anyone else gets a 404 (no existence leak). */
async function assertChatOpen(rideId: string, userId: string) {
  const ride = await queryOne<{ status: string; rider_id: string; driver_id: string | null }>(
    "SELECT status, rider_id, driver_id FROM rides WHERE id = $1", [rideId]);
  if (!ride || (ride.rider_id !== userId && ride.driver_id !== userId)) throw notFound("Ride not found");
  if (!LIVE.includes(ride.status)) throw conflict("Chat is only available while the driver is assigned to a live ride", "CHAT_CLOSED");
}

/** Polling endpoint: messages after the `after` cursor (a message id), oldest first. */
export async function listMessages(rideId: string, userId: string, after: number, limit: number): Promise<ChatMessage[]> {
  await assertChatOpen(rideId, userId);
  const rows = await query<Row>(
    `SELECT m.id, m.ride_id, m.sender_id, m.body, m.created_at,
            CASE WHEN m.sender_id = r.rider_id THEN 'rider' ELSE 'driver' END AS sender_role
       FROM ride_messages m JOIN rides r ON r.id = m.ride_id
      WHERE m.ride_id = $1 AND m.id > $2
      ORDER BY m.id LIMIT $3`,
    [rideId, after, limit]);
  return rows.map(toMessage);
}

export async function sendMessage(rideId: string, userId: string, body: string): Promise<ChatMessage> {
  // One statement checks party + live status and inserts, so a ride that completes mid-request can't receive a message.
  const row = await queryOne<Row>(
    `INSERT INTO ride_messages (ride_id, sender_id, body)
     SELECT id, $2, $3 FROM rides
      WHERE id = $1 AND status = ANY ($4::ride_status[]) AND (rider_id = $2 OR driver_id = $2)
     RETURNING id, ride_id, sender_id, body, created_at,
               (SELECT CASE WHEN rider_id = $2 THEN 'rider' ELSE 'driver' END FROM rides WHERE id = $1) AS sender_role`,
    [rideId, userId, body, LIVE]);
  if (!row) { await assertChatOpen(rideId, userId); throw conflict("Message could not be sent", "CHAT_CLOSED"); }
  return toMessage(row);
}

/** Housekeeping: delete messages older than a week. Returns rows deleted. */
export async function purgeOldMessages(): Promise<number> {
  const rows = await query("DELETE FROM ride_messages WHERE created_at < now() - interval '7 days' RETURNING 1");
  return rows.length;
}