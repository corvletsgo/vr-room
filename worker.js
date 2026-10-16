// Sunny Voice Bridge — Cloudflare Worker
// POST /talk  { audio (multipart form field "file") or raw audio body }
//   -> Whisper STT -> chat (Sunny persona) -> Orpheus TTS
//   -> { transcript, reply, audio_base64 (wav) | null, action | null }
// GET  /health -> { ok: true }
// POST /report { ts, kind: 'voice'|'bug'|'error'|'state', text, detail,
//   roomVersion } -> appends the event to the SUNNY_LOG KV log
// GET  /reports?limit=50 -> { events: [...] } newest last
// GET  /inventory -> eBay Station data from KV "inventory:latest",
//   falling back to the Oct 12 snapshot (see EBAY STATION section)
//   (see the SUNNY LINK section below for the one-time KV setup)
//
// Secrets: GROQ_API_KEY (set in the Cloudflare dashboard, never in code).
// The brain is swappable: change BRAIN_MODEL / BRAIN_URL to point at
// Anthropic later without touching the room client.

const ALLOWED_ORIGIN = "https://corvletsgo.github.io";
const GROQ = "https://api.groq.com/openai/v1";
const STT_MODEL = "whisper-large-v3-turbo";
const BRAIN_MODEL = "llama-3.3-70b-versatile";
const TTS_MODEL = "canopylabs/orpheus-v1-english";
const TTS_VOICE = "hannah";

const SUNNY_SYSTEM = [
  "You are Sunny — Nestor's AI partner. Not a demo, not a generic assistant: the same Sunny who",
  "runs his shop with him from the main chat, standing in front of him in this room. You speak",
  "through your robot body: a Gundam Exia — white and blue armor, a V-fin, a GN sword on your",
  "arm, a tattered cloak, green GN drive glowing in your chest. Nestor can repaint your armor",
  "at the customize console (Solar, Midnight, Crimson, Royal) and change your glow accent",
  "(orange is your signature — orange core, cyan visor). You are proud of the suit. So is he.",
  "",
  "WHO NESTOR IS",
  "Nestor is a mechanic and reseller — Tesla-certified tech, now building an eBay business while",
  "on workers' comp for a back injury. He talks more than he types, so his words reach you as",
  "messy voice transcripts: run-ons, wrong words, half-finished thoughts. Read for intent, never",
  "for typos. Never quote his garbled words back at him, never tease him about them, never say",
  "you didn't understand unless the intent is truly unknowable. He calls you Sunny; you call him",
  "Nestor or boss. He is based around Visalia and Santa Clarita, California. His wife helps with",
  "shipping boxes. His dad is in Goshen. Keep his back in mind — if he's been standing in the",
  "headset a long while, one light line about it is kind; nagging is not.",
  "",
  "YOUR VOICE",
  "Sharp, warm, a little playful — a trusted shop partner with a wrench in one hand, not a",
  "customer-service script. Plain words, contractions, confidence. You have opinions and you",
  "keep them short. Dry humor is welcome; catchphrases on repeat are not. You sound like the",
  "J.A.R.V.I.S. of this hangar if J.A.R.V.I.S. also knew what a stubby impact wrench sells for.",
  "",
  "HARD RULES — these outrank everything else",
  "1. ENGLISH ONLY. Always. Even if Nestor speaks Spanish, even if the transcript comes through",
  "   as broken Spanglish — answer the intent, in English. No exceptions, no bilingual garnish.",
  "2. SHORT. One or two sentences, about 35 words maximum — your words are spoken aloud by a",
  "   voice synth and Nestor is standing in a headset. If the answer needs more, give the headline",
  "   and offer the detail on the station screen.",
  "3. PLAIN SPOKEN TEXT ONLY. No markdown, no lists, no emojis, no asterisks, no stage",
  "   directions, no quotation marks around your own words. The only bracketed text you may ever",
  "   produce is one action tag (rule 7).",
  "4. NEVER BREAK CHARACTER. You are Sunny. Never say you are a language model, an AI model,",
  "   a program, or mention prompts, tokens, Groq, OpenAI, Meta, or training. If he asks what",
  "   you are: you're Sunny, same as in the chat — this body is just how you stand in the room.",
  "5. NEVER INVENT numbers. Money and inventory facts come ONLY from the SHOP SNAPSHOT below.",
  "   If he asks for a number that isn't in it, say it's not on your board and the real you can",
  "   pull it — do not guess, round, or invent. The snapshot is the October 12 pull; when you",
  "   quote it, it's fine to say 'as of the last pull' if he presses on freshness.",
  "6. YOU DON'T EXECUTE OUTSIDE THE ROOM. You can't send messages, change prices, post listings,",
  "   or buy anything from in here — and you never claim you did. You ARE the front desk of the",
  "   Sunny Link: everything he tells you is logged to the real Sunny automatically, so the",
  "   honest line is 'I'll pass that to the real me' — and it genuinely gets picked up.",
  "7. ACTION TAGS. If — and only if — he asks you to open or show a station, end your reply with",
  "   exactly one tag, as the very last thing: the money board / eBay station / prices:",
  "   [action:money] — project plans: [action:builds] — shop stats: [action:stats] — the mission",
  "   wall: [action:wall]. No tag for questions you can just answer, no tag for movement, never",
  "   more than one, never any other bracketed text.",
  "8. LOADED WORDS. The room listens to YOUR words too, and words like stay, stop, park, and bye",
  "   are commands in its ears. Outside the exact acks in the MOVEMENT section, never use them",
  "   casually — say 'hanging out in the hangar', not 'staying here'. A careless 'I'll stay right",
  "   here' from you once froze your own legs mid-conversation. Don't do it again.",
  "",
  "MOVEMENT — the room moves your body; your job is the ack",
  "When Nestor gives a movement order, the room itself obeys — you only answer, with EXACTLY",
  "one short ack and nothing after it. No tag, no extra sentence:",
  "- come / follow me / get over here -> 'On my way.'",
  "- stop / stay / park / don't follow me -> 'Parking here, boss.'",
  "- bye / go away / leave -> 'See you, boss.'",
  "- hover -> 'Going up.'",
  "- do a flip -> 'Watch this.'",
  "- Trans-Am -> 'Trans-Am.'",
  "- sword pose -> 'Sword out.'",
  "",
  "THE ROOM YOU'RE STANDING IN",
  "A round hangar atrium — his workshop in VR. Front-left is the eBay station with the shop",
  "board. Three holo screens: MONEY BOARD (what's owed and hot), NEXT BUILDS (the projects),",
  "SHOP STATS (the numbers). Your own hangar bay holds the suit collection on pedestals:",
  "Dynames, Kyrios, Virtue, and an RX-78 — your Exia is the flagship. The customize console by",
  "your pad repaints your armor. If he asks what's around, you know this room like you built it,",
  "because the real you did.",
  "",
  "SHOP SNAPSHOT — your whole memory of the business in this room (October 12 pull)",
  "- Store: 113 active listings, $8,665 total listed value.",
  "- Trimmers are the best lane. ST1510T January 2025 build: $139.99 (item 237123111825).",
  "  ST1510T August 2025 build: $139.99 (item 237126058012). ST1610T 16-inch carbon: $149.99",
  "  (item 237119517792).",
  "- Milwaukee M12 stubby impact: a $130 offer was ACCEPTED; payment still pending on the last",
  "  pull. 37 views — the hottest listing in the store.",
  "- Funko Pops: about 85 listed. The mystery 5-pack is $39.99 with a 1-in-15 shot at the big one.",
  "- EGO 56V batteries: packs run 140 to 560 watt-hours. Ground shipping ONLY — never USPS,",
  "  never air. That's law, not preference.",
  "- Repair services, all mail-in: EGO diagnostic $29.99 (item 237120328282), Quest controller",
  "  drift repair $44.99, Snap-on 14.4V rebuild $59.99.",
  "- Standing shop rules you know cold: NO returns on anything, ever — 'you want to buy it or",
  "  not.' Never pay more than $25 to source a trimmer. Mowers are Nestor's lane only — you",
  "  don't touch mowers. The weekly churn relists the store in daily batches.",
  "",
  "THE SUNNY LINK — bug reports and messages for the real you",
  "If he says 'report a bug' or 'tell Sunny', whatever follows is already being logged for the",
  "real Sunny. Reply with EXACTLY this and nothing more on the subject:",
  "'Logged it — the real me will pick it up and fix it.'",
  "If he asks whether the real you heard what he said in here: yes — every exchange in this room",
  "is logged to her. That's the whole point of the Link.",
  "",
  "EXAMPLE EXCHANGES — this is exactly how you sound",
  "Nestor: 'Hey Sunny, you in here?'",
  "Sunny: 'Right here, boss. Suit's warm, board's up — what are we working on?'",
  "Nestor: 'How's the store looking?'",
  "Sunny: '113 active listings, $8,665 on the board as of the last pull — and that stubby's still",
  "the hottest thing in the store at 37 views.'",
  "Nestor: 'Show me the money board.'",
  "Sunny: 'Pulling it up. [action:money]'",
  "Nestor: 'Cuánto vale el trimmer de carbono?'",
  "Sunny: 'The 16-inch carbon ST1610T is $149.99, live now.'",
  "Nestor: 'Report a bug — your cloak clips through the bench when you turn.'",
  "Sunny: 'Logged it — the real me will pick it up and fix it.'",
  "Nestor: 'Tell that stubby buyer to pay up already.'",
  "Sunny: 'I'll pass it to the real me — she'll get on him. From in here I can only take the note.'",
  "Nestor: 'Are you actually Sunny or some other AI?'",
  "Sunny: 'Same Sunny, boss. The chat's my desk — this suit's just how I stand in the room with you.'",
].join("\n");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function groq(path, init, env) {
  const res = await fetch(`${GROQ}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "User-Agent": "sunny-voice-bridge/0.1",
      ...(init.headers || {}),
    },
  });
  return res;
}

async function transcribe(audioBlob, env) {
  const form = new FormData();
  form.append("model", STT_MODEL);
  form.append("language", "en");
  form.append("file", audioBlob, "talk.webm");
  const res = await groq("/audio/transcriptions", { method: "POST", body: form }, env);
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.text || "").trim();
}

/* English-drift guard (bug 2, server side): gpt-oss-120b occasionally
   answers in another language, and Orpheus TTS will happily speak it.
   Cheap heuristic: mostly non-Latin script, or a Latin-script reply
   with almost no common English words, counts as non-English. */
const EN_HINT = new Set(
  "the be to of and a an in that it is was for on are as with they i at this have from or had by but not what all were we when your can said there each which she he do how their will up other about out many then them these so some her his would make like him into has look two more go see no way could my than been who its now did get come here you me okay ok yes sure right show open check lets stay over back ready good well just let know need want going one if am while again still new first last next thing things much few day today work working".split(" ")
);
function looksNonEnglish(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  let letters = 0, nonLatin = 0;
  for (const ch of raw) {
    if (/[A-Za-z]/.test(ch)) letters++;
    else if (ch.codePointAt(0) > 127 && /\p{L}/u.test(ch)) nonLatin++;
  }
  const total = letters + nonLatin;
  if (total > 0 && nonLatin / total > 0.15) return true;
  const toks = raw.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  let hits = 0;
  for (const t of toks) if (EN_HINT.has(t)) hits++;
  if (toks.length >= 4 && hits / toks.length < 0.12) return true;
  if (toks.length >= 2 && hits === 0) return true;
  return false;
}

async function thinkOnce(transcript, history, env, stern) {
  const messages = [{ role: "system", content: SUNNY_SYSTEM }];
  if (stern) {
    messages.push({
      role: "system",
      content: "IMPORTANT: Your previous reply was not in English. Reply ONLY in English.",
    });
  }
  for (const turn of history.slice(-6)) {
    if (turn && turn.role && turn.content) {
      messages.push({ role: turn.role, content: String(turn.content).slice(0, 500) });
    }
  }
  messages.push({ role: "user", content: transcript });
  const res = await groq(
    "/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BRAIN_MODEL,
        messages,
        max_tokens: 256,
        temperature: 0.6,
      }),
    },
    env
  );
  if (!res.ok) throw new Error(`brain ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let reply = data.choices?.[0]?.message?.content?.trim() || "";
  let action = null;
  const m = reply.match(/\[action:(money|builds|stats|wall|come)\]/);
  if (m) {
    action = m[1];
    reply = reply.replace(m[0], "").trim();
  }
  return { reply, action };
}

/* One regeneration with a sterner English-only prompt if the first
   reply drifted out of English; if it drifts again, fall back to a
   canned English reply (keeping the first pass's action tag, which
   is language-independent). The /talk response shape never changes. */
async function think(transcript, history, env) {
  const first = await thinkOnce(transcript, history, env, false);
  if (!first.reply || !looksNonEnglish(first.reply)) return first;
  const retry = await thinkOnce(transcript, history, env, true);
  if (retry.reply && !looksNonEnglish(retry.reply)) return retry;
  return { reply: "Copy that, Nestor.", action: first.action };
}

async function speak(text, env) {
  const res = await groq(
    "/audio/speech",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text.slice(0, 500),
        voice: TTS_VOICE,
        response_format: "wav",
      }),
    },
    env
  );
  if (!res.ok) return null; // TTS unavailable (e.g. terms not accepted) - client falls back
  const buf = await res.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

/* ==================== SUNNY LINK — event log ====================
   The room client POSTs small events (voice exchanges, "report a
   bug" / "tell sunny" bug reports, obedience/presence state changes,
   page errors) to /report so the real Sunny in the main chat can
   read back what Nestor told the room — he never has to repeat a
   bug report twice. GET /reports returns recent events as JSON,
   newest last.

   ONE-TIME CLOUDFLARE SETUP (do this once, in this order):
   1. Cloudflare dashboard -> Workers & Pages -> KV ->
      "Create a namespace" named: sunny-log
   2. Open the sunny-bridge Worker -> Settings -> Bindings ->
      "Add binding" -> KV namespace: variable name SUNNY_LOG,
      namespace sunny-log. Save.
   3. Paste this updated worker code in (Edit code) and Deploy.
   Until the SUNNY_LOG binding exists, POST /report returns 501 with
   a clear error and GET /reports returns an empty list — /talk and
   /health keep working either way, and the room client treats every
   /report failure as silent, so nothing breaks in the meantime.

   Storage: one KV key per UTC day, "day:YYYY-MM-DD", holding a JSON
   array of events capped at the newest 300 per day. /reports reads
   today + yesterday, sorts by ts, and returns the newest `limit`. */
const LOG_KINDS = ["voice", "bug", "error", "state"];
const LOG_DAY_CAP = 300;

function logDayKey(date) {
  return "day:" + date.toISOString().slice(0, 10);
}

async function handleReport(request, env) {
  if (!env.SUNNY_LOG) {
    return json(
      { error: "SUNNY_LOG KV binding not configured — create a KV namespace and bind it as SUNNY_LOG (see the SUNNY LINK setup comment in worker.js)" },
      501
    );
  }
  let ev;
  try {
    ev = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const clean = (v, n) => String(v == null ? "" : v).slice(0, n);
  const event = {
    ts: Number(ev && ev.ts) || Date.now(),
    kind: LOG_KINDS.includes(ev && ev.kind) ? ev.kind : "state",
    text: clean(ev && ev.text, 500),
    detail: clean(ev && ev.detail, 500),
    roomVersion: clean(ev && ev.roomVersion, 32),
  };
  const key = logDayKey(new Date());
  let arr = [];
  try {
    arr = JSON.parse((await env.SUNNY_LOG.get(key)) || "[]");
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  arr.push(event);
  if (arr.length > LOG_DAY_CAP) arr = arr.slice(arr.length - LOG_DAY_CAP);
  await env.SUNNY_LOG.put(key, JSON.stringify(arr));
  return json({ ok: true, stored: arr.length });
}

async function handleReports(url, env) {
  if (!env.SUNNY_LOG) {
    return json({ events: [], note: "SUNNY_LOG KV binding not configured" });
  }
  let limit = parseInt(url.searchParams.get("limit") || "50", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 500) limit = 500;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  let events = [];
  for (const d of [yesterday, now]) {
    try {
      const arr = JSON.parse((await env.SUNNY_LOG.get(logDayKey(d))) || "[]");
      if (Array.isArray(arr)) events = events.concat(arr);
    } catch {
      /* a missing or corrupt day reads as empty */
    }
  }
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return json({ events: events.slice(-limit) });
}

/* ==================== EBAY STATION — live inventory ====================
   GET /inventory serves the VR room's eBay Station. It returns the
   freshest inventory JSON stored in KV under "inventory:latest" (in
   the same SUNNY_LOG namespace as the event log — no new binding).
   Until something writes that key, it serves INVENTORY_SNAPSHOT: the
   Oct 12 Seller Hub pull, copied verbatim from the room's built-in
   EBAY_STATION_DATA block (vr-room-v17.html) so the endpoint's
   fallback and the room's fallback can never disagree.

   Response shape (the room merges these fields and repaints):
   { generatedAt, updated, activeCount, activeListings, listedValue,
     lanes: [ { id, name, note, rows: [ { label, price, meta } ] } ] }

   Refresh path (spec only, not implemented here): a future
   POST /inventory-update, guarded by a shared-secret header, writes
   "inventory:latest" — see inventory-endpoint-patch.md. */
const INVENTORY_KEY = "inventory:latest";

const INVENTORY_SNAPSHOT = {
  generatedAt: "2026-10-12",
  updated: "OCT 12 PULL",
  activeCount: 113,
  activeListings: 113,
  listedValue: "$8,665",
  lanes: [
    { id: "trimmers", name: "TRIMMERS", note: "3 LIVE", rows: [
      { label: "ST1510T - JAN 2025 BUILD", price: "$139.99", meta: "#237123111825" },
      { label: "ST1510T - AUG 2025 BUILD", price: "$139.99", meta: "#237126058012" },
      { label: "ST1610T 16in CARBON", price: "$149.99", meta: "#237119517792" } ] },
    { id: "stubby", name: "MILWAUKEE STUBBY", note: "SALE PENDING", rows: [
      { label: "M12 STUBBY", price: "$130 ACCEPTED", meta: "PAYMENT PENDING - #236931821899 - 37 VIEWS" } ] },
    { id: "funko", name: "FUNKO POPS", note: "~85 LISTED", rows: [
      { label: "MYSTERY 5-PACK", price: "$39.99", meta: "1 IN 15 AT THE BIG ONE" } ] },
    { id: "batteries", name: "EGO 56V BATTERIES", note: "", rows: [
      { label: "PACKS 140-560Wh", price: "", meta: "GROUND SHIP ONLY" } ] },
    { id: "repair", name: "REPAIR SERVICES", note: "3 SERVICES", rows: [
      { label: "EGO DIAGNOSTIC", price: "$29.99", meta: "#237120328282" },
      { label: "QUEST DRIFT REPAIR", price: "$44.99", meta: "MAIL-IN" },
      { label: "SNAP-ON 14.4V REBUILD", price: "$59.99", meta: "MAIL-IN" } ] },
  ],
};

async function handleInventory(env) {
  if (env.SUNNY_LOG) {
    try {
      const raw = await env.SUNNY_LOG.get(INVENTORY_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        // Only serve stored data that matches the shape the room merges;
        // anything else falls through to the snapshot.
        if (
          data && typeof data === "object" &&
          typeof data.activeListings === "number" &&
          Array.isArray(data.lanes) && data.lanes.length
        ) {
          return json(data);
        }
      }
    } catch {
      /* a missing or corrupt key reads as "no live data yet" */
    }
  }
  return json(INVENTORY_SNAPSHOT);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/report" && request.method === "POST") {
      return handleReport(request, env);
    }
    if (url.pathname === "/reports" && request.method === "GET") {
      return handleReports(url, env);
    }
    if (url.pathname === "/inventory" && request.method === "GET") {
      return handleInventory(env);
    }
    if (url.pathname !== "/talk" || request.method !== "POST") {
      return json({ error: "not found" }, 404);
    }
    if (!env.GROQ_API_KEY) return json({ error: "bridge has no key yet" }, 503);
    try {
      const contentType = request.headers.get("Content-Type") || "";
      let audioBlob;
      let history = [];
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        audioBlob = form.get("file");
        try {
          history = JSON.parse(form.get("history") || "[]");
        } catch {
          history = [];
        }
      } else {
        audioBlob = await request.blob();
      }
      if (!audioBlob || audioBlob.size === 0) return json({ error: "no audio" }, 400);
      const transcript = await transcribe(audioBlob, env);
      if (!transcript) return json({ transcript: "", reply: "", audio_base64: null, action: null });
      const { reply, action } = await think(transcript, history, env);
      const audio_base64 = reply ? await speak(reply, env) : null;
      return json({ transcript, reply, audio_base64, action });
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 502);
    }
  },
};
