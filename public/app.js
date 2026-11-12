const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const timeAgo = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };

function makeApi(tokenKey, onAuthFail) {
  return async (url, method = "GET", body) => {
    if (location.protocol === "file:") throw new Error("Open this page at http://localhost:3000 (not by double-clicking the file).");
    let r;
    try { r = await fetch(url, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.getItem(tokenKey) || "") }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new Error("Can't reach the server. Make sure it is running (npm start) and you are on http://localhost:3000"); }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && onAuthFail) onAuthFail();
    if (!r.ok) throw new Error(data.error || "Request failed.");
    return data;
  };
}

function initChat(api, greeting, suggestions) {
  const msgs = $("msgs"), form = $("chatForm"), input = $("chatInput");
  const add = (t, who) => { const d = document.createElement("div"); d.className = "m " + who; d.textContent = t; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; };
  add(greeting, "bot");
  const choices = document.createElement("div");
  choices.className = "chat-suggestions";
  suggestions.forEach(text => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.onclick = () => { input.value = text; form.requestSubmit(); };
    choices.appendChild(button);
  });
  form.before(choices);
  $("chat").classList.add("min");
  $("chatHead").onclick = () => $("chat").classList.toggle("min");
  form.onsubmit = async e => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    add(text, "user"); input.value = "";
    try { add((await api("/api/chat", "POST", { message: text })).reply, "bot"); window.onChatDone && window.onChatDone(); }
    catch (err) { add(err.message, "bot"); }
  };
}