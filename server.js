const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

const sessions = {};

function id() {
  return crypto.randomBytes(6).toString('hex');
}
function now() {
  return new Date().toISOString();
}

function notify(db, order, message) {
  const n = { id: id(), orderId: order.id, to: order.customerEmail, message, at: now() };
  db.notifications.push(n);
  console.log(`[EMAIL/SMS] to ${order.customerEmail}: ${message}`);
}

function detectZone(db, pincode) {
  for (const z of db.zones) {
    if (z.pincodes.includes(String(pincode))) return z.id;
  }
  return null;
}

function calculateCharge(db, input) {
  const pickupZone = detectZone(db, input.pickupPincode);
  const dropZone = detectZone(db, input.dropPincode);
  if (!pickupZone || !dropZone) {
    return { error: 'Pickup or drop pincode is not assigned to any zone.' };
  }

  const volumetric = (input.length * input.breadth * input.height) / 5000;
  const billedWeight = Math.max(Number(input.actualWeight), volumetric);

  const card = db.rateCards.find((c) => c.orderType === input.orderType);
  if (!card) return { error: 'No rate card for order type ' + input.orderType };

  const intra = pickupZone === dropZone;
  const ratePerKg = intra ? card.intraZoneRate : card.interZoneRate;
  const freight = ratePerKg * billedWeight;

  let codSurcharge = 0;
  if (input.paymentType === 'COD') {
    codSurcharge = db.codSurcharge[input.orderType] || 0;
  }

  const total = Math.round((freight + codSurcharge) * 100) / 100;

  return {
    pickupZone,
    dropZone,
    routeType: intra ? 'intra-zone' : 'inter-zone',
    volumetricWeight: Math.round(volumetric * 1000) / 1000,
    billedWeight: Math.round(billedWeight * 1000) / 1000,
    ratePerKg,
    freight: Math.round(freight * 100) / 100,
    codSurcharge,
    total,
  };
}

function autoAssignAgent(db, pickupZone) {
  const available = db.agents.filter((a) => a.available);
  if (available.length === 0) return null;
  const sameZone = available.find((a) => a.zone === pickupZone);
  return (sameZone || available[0]).id;
}

function getUserFromReq(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  return sessions[token] || null;
}
function requireRole(user, roles) {
  return user && roles.includes(user.role);
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const STATUS_FLOW = ['Created', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delivered'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (method === 'POST' && p === '/api/register') {
    const b = await readBody(req);
    if (!b.email || !b.password) return send(res, 400, { error: 'email and password required' });
    if (db.users.find((u) => u.email === b.email)) return send(res, 400, { error: 'email taken' });
    const user = { id: id(), email: b.email, password: b.password, role: 'customer', name: b.name || b.email };
    db.users.push(user);
    saveDB(db);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/login') {
    const b = await readBody(req);
    const user = db.users.find((u) => u.email === b.email && u.password === b.password);
    if (!user) return send(res, 401, { error: 'invalid credentials' });
    const token = id() + id();
    sessions[token] = { userId: user.id, role: user.role };
    return send(res, 200, { token, role: user.role, name: user.name, email: user.email });
  }

  const user = getUserFromReq(req);

  if (method === 'GET' && p === '/api/zones') {
    return send(res, 200, db.zones);
  }
  if (method === 'POST' && p === '/api/zones') {
    if (!requireRole(user, ['admin'])) return send(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    const zone = { id: b.id || id(), name: b.name, pincodes: b.pincodes || [] };
    db.zones.push(zone);
    saveDB(db);
    return send(res, 200, zone);
  }

  if (method === 'GET' && p === '/api/ratecards') {
    return send(res, 200, { rateCards: db.rateCards, codSurcharge: db.codSurcharge });
  }
  if (method === 'PUT' && p === '/api/ratecards') {
    if (!requireRole(user, ['admin'])) return send(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    if (b.rateCards) db.rateCards = b.rateCards;
    if (b.codSurcharge) db.codSurcharge = b.codSurcharge;
    saveDB(db);
    return send(res, 200, { rateCards: db.rateCards, codSurcharge: db.codSurcharge });
  }

  if (method === 'GET' && p === '/api/agents') {
    return send(res, 200, db.agents);
  }

  if (method === 'POST' && p === '/api/quote') {
    const b = await readBody(req);
    return send(res, 200, calculateCharge(db, b));
  }

  if (method === 'POST' && p === '/api/orders') {
    if (!requireRole(user, ['customer', 'admin'])) return send(res, 403, { error: 'login required' });
    const b = await readBody(req);
    const charge = calculateCharge(db, b);
    if (charge.error) return send(res, 400, charge);

    const owner = db.users.find((u) => u.email === (b.customerEmail || '')) ||
      db.users.find((u) => u.id === user.userId);

    const order = {
      id: id(),
      customerId: owner.id,
      customerEmail: owner.email,
      pickupAddress: b.pickupAddress,
      dropAddress: b.dropAddress,
      pickupPincode: String(b.pickupPincode),
      dropPincode: String(b.dropPincode),
      dimensions: { length: b.length, breadth: b.breadth, height: b.height },
      actualWeight: b.actualWeight,
      orderType: b.orderType,
      paymentType: b.paymentType,
      charge,
      status: 'Created',
      agentId: null,
      rescheduleDate: null,
      history: [{ status: 'Created', at: now(), by: user.role }],
      createdAt: now(),
    };
    db.orders.push(order);
    notify(db, order, `Order ${order.id} created. Charge: ${charge.total}`);
    saveDB(db);
    return send(res, 200, order);
  }

  if (method === 'GET' && p === '/api/orders') {
    if (!user) return send(res, 403, { error: 'login required' });
    let list = db.orders;
    if (user.role === 'customer') list = list.filter((o) => o.customerId === user.userId);
    if (user.role === 'agent') list = list.filter((o) => o.agentId === user.userId);
    const fStatus = url.searchParams.get('status');
    const fZone = url.searchParams.get('zone');
    const fAgent = url.searchParams.get('agent');
    if (fStatus) list = list.filter((o) => o.status === fStatus);
    if (fZone) list = list.filter((o) => o.charge.pickupZone === fZone || o.charge.dropZone === fZone);
    if (fAgent) list = list.filter((o) => o.agentId === fAgent);
    return send(res, 200, list);
  }

  const orderMatch = p.match(/^\/api\/orders\/([a-z0-9]+)$/);
  if (method === 'GET' && orderMatch) {
    const order = db.orders.find((o) => o.id === orderMatch[1]);
    if (!order) return send(res, 404, { error: 'not found' });
    return send(res, 200, order);
  }

  const assignMatch = p.match(/^\/api\/orders\/([a-z0-9]+)\/assign$/);
  if (method === 'POST' && assignMatch) {
    if (!requireRole(user, ['admin'])) return send(res, 403, { error: 'admin only' });
    const order = db.orders.find((o) => o.id === assignMatch[1]);
    if (!order) return send(res, 404, { error: 'not found' });
    const b = await readBody(req);
    let agentId = b.agentId;
    if (b.auto) agentId = autoAssignAgent(db, order.charge.pickupZone);
    if (!agentId) return send(res, 400, { error: 'no available agent' });
    order.agentId = agentId;
    const agent = db.agents.find((a) => a.id === agentId);
    order.history.push({ status: 'Assigned to ' + agent.name, at: now(), by: user.role });
    notify(db, order, `Agent ${agent.name} assigned to order ${order.id}`);
    saveDB(db);
    return send(res, 200, order);
  }

  const statusMatch = p.match(/^\/api\/orders\/([a-z0-9]+)\/status$/);
  if (method === 'POST' && statusMatch) {
    if (!requireRole(user, ['agent', 'admin'])) return send(res, 403, { error: 'agent/admin only' });
    const order = db.orders.find((o) => o.id === statusMatch[1]);
    if (!order) return send(res, 404, { error: 'not found' });
    const b = await readBody(req);
    const allowed = [...STATUS_FLOW, 'Failed'];
    if (!allowed.includes(b.status)) return send(res, 400, { error: 'bad status' });
    order.status = b.status;
    order.history.push({ status: b.status, at: now(), by: user.role, note: b.note || '' });
    if (b.status === 'Failed') {
      notify(db, order, `Delivery failed for order ${order.id}. You can reschedule.`);
    } else {
      notify(db, order, `Order ${order.id} status: ${b.status}`);
    }
    saveDB(db);
    return send(res, 200, order);
  }

  const reschedMatch = p.match(/^\/api\/orders\/([a-z0-9]+)\/reschedule$/);
  if (method === 'POST' && reschedMatch) {
    if (!user) return send(res, 403, { error: 'login required' });
    const order = db.orders.find((o) => o.id === reschedMatch[1]);
    if (!order) return send(res, 404, { error: 'not found' });
    if (order.status !== 'Failed') return send(res, 400, { error: 'order is not in Failed state' });
    const b = await readBody(req);
    order.rescheduleDate = b.date;
    const newAgent = autoAssignAgent(db, order.charge.pickupZone);
    order.agentId = newAgent;
    order.status = 'Created';
    const agentName = db.agents.find((a) => a.id === newAgent)?.name || 'unassigned';
    order.history.push({ status: `Rescheduled to ${b.date}, reassigned to ${agentName}`, at: now(), by: user.role });
    notify(db, order, `Order ${order.id} rescheduled to ${b.date}. New agent: ${agentName}`);
    saveDB(db);
    return send(res, 200, order);
  }

  if (method === 'GET' && p === '/api/notifications') {
    return send(res, 200, db.notifications);
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Last-Mile Delivery Tracker running on http://localhost:${PORT}`);
});
