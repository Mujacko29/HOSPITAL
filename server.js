// HospitalQueueAI - run: npm i express && node server.js
// Optional: OPENAI_API_KEY (+ OPENAI_MODEL) for a generative chatbot. STAFF_PASSWORD to change the staff login.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "staff123";
const FILE = path.join(__dirname, "data.json");

// ---------- persistent "database" (JSON file, survives restarts) ----------
let db = {
  users: [], tickets: [], notifications: [], agentLog: [], sessions: {},
  autoMode: true, nextTicketId: 1, ticketCounters: {},
  departments: [
    { id: "gen", name: "General Consultation", prefix: "G", avgMinutes: 10, open: true },
    { id: "ped", name: "Pediatrics", prefix: "P", avgMinutes: 12, open: true },
    { id: "car", name: "Cardiology", prefix: "C", avgMinutes: 15, open: true },
    { id: "er", name: "Emergency", prefix: "E", avgMinutes: 5, open: true },
  ],
};
if (fs.existsSync(FILE)) try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (e) { console.error("data.json unreadable, starting fresh"); }
if (!db.ticketCounters || typeof db.ticketCounters !== "object" || Array.isArray(db.ticketCounters)) db.ticketCounters = {};
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(16).toString("hex");
const formatDuration = value => {
  const numeric = Number(value);
  const total = Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
  if (!total) return "less than a minute";
  const parts = [
    [Math.floor(total / 1440), "day"],
    [Math.floor((total % 1440) / 60), "hour"],
    [total % 60, "minute"],
  ].filter(([count]) => count > 0);
  return parts.slice(0, 2).map(([count, unit]) => `${count} ${unit}${count === 1 ? "" : "s"}`).join(" ");
};

// ---------- helpers ----------
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const dept = id => db.departments.find(d => d.id === id);
const waitingIn = id => db.tickets.filter(t => t.deptId === id && t.status === "waiting").sort((a, b) => a.id - b.id);
const servingIn = id => db.tickets.filter(t => t.deptId === id && t.status === "serving");
const active = uidv => db.tickets.find(t => t.userId === uidv && ["waiting", "serving"].includes(t.status));
const findTicket = id => db.tickets.find(t => t.id === +id);

function notify(userId, text, kind = "info") {
  if (userId) db.notifications.push({ id: uid(), userId, text, kind, at: now(), read: false });
}
function log(text, userId) {
  const entry = { at: now(), text };
  if (userId) entry.userId = userId;
  db.agentLog.unshift(entry);
  db.agentLog = db.agentLog.slice(0, 60);
}

function removePatientData(userId) {
  const userTickets = db.tickets.filter(ticket => ticket.userId === userId);
  for (const deptId of new Set(userTickets.map(ticket => ticket.deptId))) {
    db.ticketCounters[deptId] = Math.max(
      Number(db.ticketCounters[deptId]) || 0,
      db.tickets.filter(ticket => ticket.deptId === deptId).length
    );
  }

  const userTicketNumbers = new Set(userTickets.map(ticket => ticket.number));
  const uniqueTicketNumbers = [...userTicketNumbers].filter(number =>
    !db.tickets.some(ticket => ticket.userId !== userId && ticket.number === number)
  );
  const ticketPatterns = uniqueTicketNumbers.map(number =>
    new RegExp(`\\b${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
  );
  const unambiguousTickets = userTickets.filter(ticket =>
    !db.tickets.some(other => other.userId !== userId && other.number === ticket.number && other.name === ticket.name)
  );
  db.agentLog = db.agentLog.filter(entry => {
    if (entry.userId === userId) return false;
    if (typeof entry.text !== "string") return true;
    return !ticketPatterns.some(pattern => pattern.test(entry.text)) &&
      !unambiguousTickets.some(ticket => entry.text.includes(ticket.number) && entry.text.includes(ticket.name));
  });
  db.tickets = db.tickets.filter(ticket => ticket.userId !== userId);
  db.notifications = db.notifications.filter(notification => notification.userId !== userId);
  Object.entries(db.sessions).forEach(([token, session]) => {
    if (session.role === "patient" && session.userId === userId) delete db.sessions[token];
  });
}

const registeredUserIds = new Set(db.users.map(user => user.id));
const orphanedUserIds = new Set();
db.tickets.forEach(ticket => {
  if (ticket.userId && !registeredUserIds.has(ticket.userId)) orphanedUserIds.add(ticket.userId);
});
db.notifications.forEach(notification => {
  if (notification.userId && !registeredUserIds.has(notification.userId)) orphanedUserIds.add(notification.userId);
});
Object.values(db.sessions).forEach(session => {
  if (session && session.role === "patient" && session.userId && !registeredUserIds.has(session.userId)) {
    orphanedUserIds.add(session.userId);
  }
});
if (orphanedUserIds.size) {
  orphanedUserIds.forEach(removePatientData);
  save();
}

function position(t) {
  const d = dept(t.deptId);
  if (t.status !== "waiting") return { ahead: 0, etaMinutes: 0 };
  const ahead = waitingIn(t.deptId).filter(x => x.id < t.id).length;
  const busy = servingIn(t.deptId).length ? d.avgMinutes / 2 : 0;
  return { ahead, etaMinutes: Math.round(ahead * d.avgMinutes + busy + (servingIn(t.deptId).length ? 0 : 0)) };
}

// the agent's reasoning about "what should this patient do now?"
function nextAction(t) {
  if (!t) return "You have no active queue number. Choose a service and tap Get queue number.";
  const d = dept(t.deptId), p = position(t);
  if (t.status === "serving") return `It's your turn. Go to the ${d.name} counter now and show your queue number ${t.number}.`;
  if (!d.open) return `${d.name} is currently closed. Please ask the front desk for help.`;
  if (p.ahead === 0) return `You're next. Stay at the ${d.name} waiting area so you don't miss your call.`;
  if (p.ahead <= 2) return `Almost there: ${p.ahead} patient(s) ahead. Move to the ${d.name} waiting area and have your ID ready.`;
  return `About ${formatDuration(p.etaMinutes)} to go. You can rest or get water, but return when you're ${2} patients away. I'll notify you.`;
}

function publicTicket(t) {
  if (!t) return null;
  const d = dept(t.deptId);
  return { id: t.id, number: t.number, status: t.status, department: d ? d.name : "?", ...position(t),
           totalWaiting: waitingIn(t.deptId).length, nextAction: nextAction(t), createdAt: t.createdAt };
}

// ---------- auth ----------
function auth(req, _res, next) {
  const tok = (req.get("authorization") || "").replace("Bearer ", "");
  const s = db.sessions[tok];
  req.session = s || null;
  req.user = s && s.role === "patient" ? db.users.find(u => u.id === s.userId) : null;
  req.isStaff = !!(s && s.role === "staff");
  next();
}
const needUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: "Please log in first." });
const needStaff = (req, res, next) => req.isStaff ? next() : res.status(401).json({ error: "Staff login required." });

const app = express();
app.use(express.json());
app.use(auth);
app.use(express.static(path.join(__dirname, "public")));

// ---------- patient: account ----------
app.post("/api/auth/register", (req, res) => {
  const { name, phone, password } = req.body || {};
  if (![name, phone, password].every(v => typeof v === "string" && v.trim())) return res.status(400).json({ error: "Name, phone and password are required." });
  if (password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
  const p = phone.trim();
  if (db.users.some(u => u.phone === p)) return res.status(409).json({ error: "That phone number is already registered. Log in instead." });
  const salt = uid();
  const user = { id: uid(), name: name.trim().slice(0, 80), phone: p, salt, passHash: hash(password, salt) };
  db.users.push(user);
  const token = uid(); db.sessions[token] = { role: "patient", userId: user.id };
  save();
  res.json({ token, user: { name: user.name, phone: user.phone } });
});

app.post("/api/auth/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = db.users.find(x => x.phone === String(phone || "").trim());
  if (!u || hash(String(password || ""), u.salt) !== u.passHash) return res.status(401).json({ error: "Wrong phone number or password." });
  const token = uid(); db.sessions[token] = { role: "patient", userId: u.id };
  save();
  res.json({ token, user: { name: u.name, phone: u.phone } });
});

app.post("/api/staff/login", (req, res) => {
  if ((req.body || {}).password !== STAFF_PASSWORD) return res.status(401).json({ error: "Wrong staff password." });
  const token = uid(); db.sessions[token] = { role: "staff" };
  save();
  res.json({ token });
});

app.post("/api/auth/logout", (req, res) => {
  const token = (req.get("authorization") || "").replace("Bearer ", "");
  if (token && db.sessions[token]) {
    delete db.sessions[token];
    save();
  }
  res.json({ ok: true });
});

// ---------- patient: queue ----------
app.get("/api/departments", (_req, res) =>
  res.json({ departments: db.departments.map(d => ({ id: d.id, name: d.name, open: d.open, waiting: waitingIn(d.id).length, avgMinutes: d.avgMinutes })) }));

app.post("/api/tickets", needUser, (req, res) => {
  const d = dept((req.body || {}).departmentId);
  if (!d) return res.status(400).json({ error: "Choose a service." });
  if (!d.open) return res.status(400).json({ error: `${d.name} is closed right now.` });
  if (active(req.user.id)) return res.status(409).json({ error: "You already have an active queue number. Cancel it first to switch service." });
  const id = db.nextTicketId++;
  const previousCount = Math.max(Number(db.ticketCounters[d.id]) || 0, db.tickets.filter(t => t.deptId === d.id).length);
  const n = previousCount + 1;
  db.ticketCounters[d.id] = n;
  const t = { id, number: `${d.prefix}-${String(n).padStart(3, "0")}`, deptId: d.id, userId: req.user.id, name: req.user.name,
              status: "waiting", createdAt: now(), calledAt: null, doneAt: null, flags: {} };
  db.tickets.push(t);
  notify(req.user.id, `You're registered for ${d.name}. Your number is ${t.number}.`, "ok");
  log(`${t.number} (${t.name}) joined ${d.name}.`, req.user.id);
  save();
  res.status(201).json({ ticket: publicTicket(t) });
});

app.get("/api/me", needUser, (req, res) => {
  const t = active(req.user.id) || db.tickets.filter(x => x.userId === req.user.id).sort((a, b) => b.id - a.id)[0];
  const notes = db.notifications.filter(n => n.userId === req.user.id).slice(-15).reverse();
  res.json({ user: { name: req.user.name }, ticket: publicTicket(t), notifications: notes });
});

app.post("/api/me/notifications/read", needUser, (req, res) => {
  db.notifications.filter(n => n.userId === req.user.id).forEach(n => n.read = true); save(); res.json({ ok: true });
});

app.post("/api/tickets/cancel", needUser, (req, res) => {
  const t = active(req.user.id);
  if (!t || t.status !== "waiting") return res.status(400).json({ error: "You have no waiting ticket to cancel." });
  t.status = "cancelled"; t.doneAt = now();
  log(`${t.number} cancelled by the patient.`, t.userId); save();
  res.json({ ok: true });
});

// ---------- staff ----------
function callNext(deptId, by) {
  const d = dept(deptId);
  if (!d) return { ok: false, message: "Unknown department." };
  if (servingIn(deptId).length) return { ok: false, message: `${servingIn(deptId)[0].number} is still being served in ${d.name}.` };
  const t = waitingIn(deptId)[0];
  if (!t) return { ok: false, message: `No one is waiting in ${d.name}.` };
  t.status = "serving"; t.calledAt = now();
  notify(t.userId, `It's your turn! Please go to the ${d.name} counter. (${t.number})`, "turn");
  log(`${by} called ${t.number} (${t.name}) to ${d.name}.`, t.userId);
  save();
  return { ok: true, message: `${t.number} ${t.name} is now being served in ${d.name}.`, ticket: t };
}

function finish(t, status) {
  if (status === "completed" && t.calledAt) { // learn real service time -> better estimates
    const mins = Math.max(1, (Date.now() - new Date(t.calledAt)) / 60000);
    const d = dept(t.deptId); d.avgMinutes = Math.round((d.avgMinutes * 0.7 + mins * 0.3) * 10) / 10;
  }
  t.status = status; t.doneAt = now();
  notify(t.userId, status === "completed" ? "Your visit is marked as done. Thank you!" : "Your queue number was closed because you didn't arrive. Register again if you still need service.", status === "completed" ? "ok" : "warn");
  log(`${t.number} marked ${status}.`, t.userId); save();
}

app.get("/api/staff/overview", needStaff, (_req, res) => {
  res.json({
    autoMode: db.autoMode,
    departments: db.departments.map(d => ({ ...d, waiting: waitingIn(d.id).length, serving: servingIn(d.id).length })),
    tickets: db.tickets.filter(t => ["waiting", "serving"].includes(t.status)).sort((a, b) => a.id - b.id)
      .map(t => ({ id: t.id, number: t.number, name: t.name, deptId: t.deptId, department: dept(t.deptId)?.name, status: t.status, createdAt: t.createdAt })),
    stats: ["waiting", "serving", "completed", "cancelled", "no_show"].reduce((o, s) => (o[s] = db.tickets.filter(t => t.status === s).length, o), {}),
    agentLog: db.agentLog.slice(0, 25).map(({ at, text }) => ({ at, text })),
  });
});

app.get("/api/staff/patients", needStaff, (req, res) => {
  if (req.query.search !== undefined && typeof req.query.search !== "string") {
    return res.status(400).json({ error: "Search must be a single text value." });
  }
  const search = String(req.query.search || "").trim().slice(0, 80).toLowerCase();
  const tickets = db.tickets
    .slice()
    .sort((a, b) => b.id - a.id)
    .filter(t => {
      const department = dept(t.deptId);
      return !search || [t.name, t.number, department?.name].some(value =>
        String(value || "").toLowerCase().includes(search));
    })
    .slice(0, 50)
    .map(t => ({
      id: t.id,
      number: t.number,
      name: t.name,
      department: dept(t.deptId)?.name || "?",
      status: t.status,
      createdAt: t.createdAt,
    }));
  res.json({ tickets });
});

app.get("/api/staff/users", needStaff, (_req, res) => {
  const users = db.users.slice().reverse().map(user => ({ id: user.id, name: user.name, phone: user.phone }));
  res.json({ users });
});

app.delete("/api/staff/users/:id", needStaff, (req, res) => {
  const user = db.users.find(candidate => candidate.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Patient account not found." });
  const userTickets = db.tickets.filter(ticket => ticket.userId === user.id);
  if (userTickets.some(ticket => ["waiting", "serving"].includes(ticket.status))) {
    return res.status(409).json({ error: "Resolve this patient's active queue ticket before deleting the account." });
  }

  db.users = db.users.filter(candidate => candidate.id !== user.id);
  removePatientData(user.id);
  save();
  res.json({ ok: true });
});

app.post("/api/staff/call-next", needStaff, (req, res) => res.json(callNext((req.body || {}).departmentId, "Staff")));
app.post("/api/staff/tickets/:id/:action", needStaff, (req, res) => {
  const t = findTicket(req.params.id), a = req.params.action;
  if (!t) return res.status(404).json({ error: "Ticket not found." });
  if (a === "serve") { // serve a specific waiting patient (skip the line)
    if (t.status !== "waiting") return res.status(400).json({ error: `${t.number} is ${t.status}.` });
    if (servingIn(t.deptId).length) return res.status(409).json({ error: "Someone is already being served in this department." });
    t.status = "serving"; t.calledAt = now(); notify(t.userId, `It's your turn! Please go to the ${dept(t.deptId).name} counter. (${t.number})`, "turn");
    log(`Staff served ${t.number} directly.`, t.userId); save(); return res.json({ ok: true });
  }
  if (a === "complete" && t.status === "serving") { finish(t, "completed"); return res.json({ ok: true }); }
  if (a === "noshow" && t.status === "serving") { finish(t, "no_show"); return res.json({ ok: true }); }
  if (a === "cancel" && t.status === "waiting") { t.status = "cancelled"; t.doneAt = now(); notify(t.userId, "Your queue number was cancelled by staff.", "warn"); log(`Staff cancelled ${t.number}.`, t.userId); save(); return res.json({ ok: true }); }
  res.status(400).json({ error: `Cannot ${a} a ${t.status} ticket.` });
});

app.post("/api/staff/auto", needStaff, (req, res) => { db.autoMode = !!(req.body || {}).on; log(`Agent auto-call turned ${db.autoMode ? "ON" : "OFF"}.`); save(); res.json({ autoMode: db.autoMode }); });

app.post("/api/staff/departments", needStaff, (req, res) => {
  const { name, prefix, avgMinutes } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "Department name is required." });
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20) + "-" + uid().slice(0, 3);
  db.departments.push({ id, name: name.trim(), prefix: (String(prefix || name)[0] || "X").toUpperCase(), avgMinutes: Math.max(1, +avgMinutes || 10), open: true });
  save(); res.json({ ok: true });
});
app.patch("/api/staff/departments/:id", needStaff, (req, res) => {
  const d = dept(req.params.id); if (!d) return res.status(404).json({ error: "Not found." });
  const { open, avgMinutes, name } = req.body || {};
  if (typeof open === "boolean") d.open = open;
  if (avgMinutes) d.avgMinutes = Math.max(1, +avgMinutes);
  if (typeof name === "string" && name.trim()) d.name = name.trim();
  save(); res.json({ ok: true });
});
app.delete("/api/staff/departments/:id", needStaff, (req, res) => {
  if (db.tickets.some(t => t.deptId === req.params.id && ["waiting", "serving"].includes(t.status))) return res.status(400).json({ error: "Clear the waiting patients first, or close the department instead." });
  db.departments = db.departments.filter(d => d.id !== req.params.id); save(); res.json({ ok: true });
});

// ---------- AI assistant ----------
const KNOWLEDGE = `Hospital process: 1) Create an account or log in. 2) Choose the service you need. 3) Get a queue number. 4) Wait in the department waiting area; you'll be notified when you are 2 patients away and when it's your turn. 5) Go to the counter, show your queue number and a valid ID. 6) After the consultation, staff mark your visit as done. Bring: valid ID, previous medical records, insurance card if any. Emergency: if life-threatening (chest pain, difficulty breathing, severe bleeding) go directly to the Emergency room; do not wait for the app. The assistant is not a doctor and cannot diagnose.`;

function builtIn(text, ticket, staff) {
  const m = text.toLowerCase();
  if (staff) {
    const target = db.departments.find(d => m.includes(d.name.toLowerCase())) || db.departments.find(d => waitingIn(d.id).length && !servingIn(d.id).length);
    if (/call|next/.test(m)) return target ? callNext(target.id, "Assistant").message : "There is no department that needs a call right now.";
    if (/status|queue|analy|busy/.test(m)) return db.departments.map(d => `${d.name}: ${waitingIn(d.id).length} waiting, ${servingIn(d.id).length} serving, avg ${formatDuration(d.avgMinutes)}`).join("\n");
    return "Staff commands: 'status', 'call next', or 'call next in Cardiology'.";
  }
  if (/my|wait|long|ahead|turn|position|status|how many|number/.test(m) && !/what documents/.test(m)) {
    if (!ticket) return "You don't have an active queue number yet. Pick a service and tap Get queue number.";
    const p = publicTicket(ticket);
    return `Your number is ${p.number} (${p.department}), status: ${p.status}. ${p.status === "waiting" ? `${p.ahead} patient(s) ahead, estimated wait: ${formatDuration(p.etaMinutes)}. ` : ""}${p.nextAction}`;
  }
  if (/what (should|do) i do|next step|what now/.test(m)) return nextAction(ticket);
  if (/document|bring|id|requirement/.test(m)) return "Please bring a valid ID, your previous medical records or prescriptions, and your insurance card if you have one.";
  if (/emergen|chest|breath|bleed|faint|unconscious/.test(m)) return "If this is life-threatening, go straight to the Emergency room or ask a staff member right now. Don't wait in the regular queue.";
  if (/department|service|which|where/.test(m)) return "Available services: " + db.departments.filter(d => d.open).map(d => `${d.name} (${waitingIn(d.id).length} waiting)`).join(", ") + ".";
  if (/register|how|process|work/.test(m)) return KNOWLEDGE.split("Bring:")[0];
  return "I can explain your queue status, wait time and what to do next, and answer questions about the hospital process. I can't give medical advice.";
}

async function llm(message, ticket, staff) {
  const patientTicket = ticket ? publicTicket(ticket) : null;
  const ctx = staff
    ? { departments: db.departments.map(d => ({ name: d.name, waiting: waitingIn(d.id).length, serving: servingIn(d.id).length, averageServiceTime: formatDuration(d.avgMinutes) })) }
    : {
      departments: db.departments.filter(d => d.open).map(d => ({ name: d.name, waiting: waitingIn(d.id).length })),
      yourTicket: patientTicket ? { ...patientTicket, etaMinutes: undefined, estimatedWait: formatDuration(patientTicket.etaMinutes) } : null,
    };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages: [
      { role: "system", content: `You are HospitalQueueAI, a concise, friendly hospital queue assistant for ${staff ? "staff" : "a patient"}. Never diagnose. Only use the data provided; never invent queue info or reveal other patients. Express wait estimates in natural minutes, hours, or days, not large raw minute totals.\n${KNOWLEDGE}\nLive data: ${JSON.stringify(ctx)}` },
      { role: "user", content: message }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "LLM error");
  return j.choices[0].message.content;
}

app.post("/api/chat", async (req, res) => {
  const message = String((req.body || {}).message || "").trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: "Message is required." });
  if (!req.user && !req.isStaff) return res.status(401).json({ error: "Please log in to chat." });
  const ticket = req.user ? active(req.user.id) : null;
  // staff actions always use the built-in agent so they're deterministic; patients get the LLM if configured
  if (process.env.OPENAI_API_KEY && !req.isStaff) {
    try { return res.json({ reply: await llm(message, ticket, false), source: "llm" }); }
    catch (e) { console.error("LLM failed, using built-in:", e.message); }
  }
  res.json({ reply: builtIn(message, ticket, req.isStaff), source: "built-in" });
});

// ---------- AGENTIC LOOP: monitor -> decide -> act (multi-step) ----------
function agentTick() {
  let changed = false;
  for (const d of db.departments) {
    const waiting = waitingIn(d.id);
    // step 1: notify patients whose turn is approaching
    waiting.forEach((t, i) => {
      if (i <= 2 && !t.flags.approaching) {
        t.flags.approaching = true; changed = true;
        notify(t.userId, i === 0 ? `You're next in ${d.name}. Please stay near the counter.` : `${i} patient(s) ahead of you in ${d.name}. Please move to the waiting area.`, "soon");
        log(`Notified ${t.number}: turn approaching (${i} ahead).`, t.userId);
      }
    });
    // step 2: keep the department moving (auto-call when the counter is free)
    if (db.autoMode && d.open && waiting.length && !servingIn(d.id).length) { callNext(d.id, "Agent"); changed = true; }
    // step 3: flag overload for staff
    if (waiting.length >= 8 && !d.overloadLogged) { d.overloadLogged = true; log(`Alert: ${d.name} has ${waiting.length} waiting. Consider opening another counter.`); changed = true; }
    if (waiting.length < 5) d.overloadLogged = false;
    // step 4: patient called but not finished for a long time
    servingIn(d.id).forEach(t => {
      if (t.calledAt && Date.now() - new Date(t.calledAt) > d.avgMinutes * 3 * 60000 && !t.flags.slow) { t.flags.slow = true; log(`${t.number} has been serving for 3x the average time.`, t.userId); changed = true; }
    });
  }
  if (changed) save();
}
setInterval(agentTick, 4000);

app.listen(PORT, () => console.log(`HospitalQueueAI on http://localhost:${PORT}  (staff password: ${STAFF_PASSWORD})  AI: ${process.env.OPENAI_API_KEY ? "LLM" : "built-in"}`));