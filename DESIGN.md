# System Design Write-up

**Last-Mile Delivery Tracker** — a minimal Node.js application (no external
dependencies) with a JSON file as its data store. The following covers the four
areas of interest: the rate calculation engine, zone detection, auto-assignment,
and failed-delivery handling.

## Rate calculation engine

The engine (`calculateCharge` in `server.js`) is fully driven by
admin-configured data; no rate, zone, or surcharge value is hardcoded in the
logic. Given an order's pickup/drop pincodes, dimensions, actual weight, order
type and payment type, it:

1. Detects the pickup and drop zones (see below). If either pincode is not
   mapped to a zone, it returns an error instead of guessing.
2. Computes volumetric weight as `L × B × H ÷ 5000`, and bills on the higher of
   actual and volumetric weight — the standard courier convention that stops
   large light parcels from being underpriced.
3. Selects the rate card matching the order type (B2B or B2C). Each card holds
   an intra-zone and an inter-zone per-kg rate. If pickup and drop share a zone
   the intra rate is used, otherwise the inter rate.
4. Multiplies the chosen rate by the billed weight to get freight, then adds the
   COD surcharge for that order type when the payment type is COD.

The same function backs both `/api/quote` (a preview shown before the customer
confirms) and `/api/orders` (the value stored on the order), so the previewed
price and the charged price can never drift apart.

## Zone detection approach

Zones are an admin-managed mapping of `zone → list of pincodes`. Detection is a
direct lookup: the order's pincode is searched across zones and the owning zone
id is returned. This keeps the model simple and completely configurable — the
admin can create zones and assign/reassign pincodes at runtime via the zone
API, with no code change. A real deployment would swap this exact-match lookup
for a geospatial or pincode-range service behind the same `detectZone`
interface; the rest of the engine would not change.

## Auto-assignment logic

Agents are modelled with a home `zone` and an `available` flag.
`autoAssignAgent` takes the order's pickup zone and picks the "nearest"
available agent: it prefers an available agent whose home zone equals the pickup
zone, and otherwise falls back to any available agent. If none are available it
returns nothing and the caller reports that no agent could be assigned. The
admin can also assign a specific agent manually via the same endpoint
(`{agentId}` instead of `{auto:true}`). Zone proximity is used as a cheap,
data-only proxy for distance; the function is the single place to later plug in
real coordinates and a nearest-neighbour search.

## Order status lifecycle and tracking history

Orders follow `Created → Picked Up → In Transit → Out for Delivery →
Delivered`, with `Failed` as an alternate terminal state. Every order carries a
`history` array; each status change appends a new entry recording the status, an
ISO timestamp, and the actor's role. Entries are only ever appended, never
edited or removed, giving an immutable audit trail that the customer sees as a
tracking timeline. Admins can override status through the same status endpoint.

## Failed-delivery handling

When an agent marks an order `Failed`, the customer is notified and the order
becomes eligible for rescheduling. The reschedule endpoint captures a new date,
re-runs auto-assignment to pick an agent for the fresh attempt, resets the order
to `Created`, logs the reschedule (with new date and agent) into the immutable
history, and notifies the customer. This closes the loop: a failure never dead-
ends an order — it is flagged, communicated, and re-queued for delivery.

## Notifications

Every status change and key event calls `notify`, which stores a notification
record and logs it to the console, standing in for a real email/SMS provider.
Because it is a single choke-point, wiring in an actual free-tier email/SMS
service later is a one-function change.
