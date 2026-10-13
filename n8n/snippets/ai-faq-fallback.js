// Deterministic FAQ fallback for W13 (DEMO / local AI). When the model is unavailable, times out or answers something W13 cannot use, a clear
// routine question (prices, services, opening hours, location, a greeting, a thank-you) is answered from the clinic's KNOWLEDGE BASE with no
// model at all. Anything else (booking, medical, complaint, a person, an emergency, a long or unclear message) returns null: W13 hands it to a
// person exactly as before. The result is a DECISION in the model's own shape, so W13 – Plan runs it through the same checks: aiValidateDecision,
// the confidence tiers, the fact check (every price / time / link / phone must be in the knowledge base) and aiRoute.
// Pure functions, no network, no clock. Pasted into "W13 – Plan" AFTER the ai-receptionist.js block (uses aiClean, aiLine, aiEmergencyIn).
// Paste from AI_FAQ_MAX_TEXT down to (not including) the module.exports line (the one-line require above it is for Node tests only).
//
// What it never does: invent a service, price, time, address or policy; give medical advice; confirm, offer or book an appointment;
// reply to a message it cannot place; reply in a language other than the one the knowledge base is written in.

// (Node tests only: in the n8n node the ai-receptionist.js block above provides these.)
const { aiClean, aiEmergencyIn } = typeof module !== 'undefined' ? require('./ai-receptionist') : {};

const AI_FAQ_MAX_TEXT = 120;      // longer messages are not "a quick question": a person reads them
const AI_FAQ_MAX_REPLY = 480;
const AI_FAQ_MAX_ROW = 220;       // a knowledge row longer than this is not quoted (a cut-off price would fail the fact check)
const AI_FAQ_CONFIDENCE = 0.9;

// Words that make a message NOT a routine question, whatever else it says.
const AI_FAQ_NOT_ROUTINE = new RegExp([
  // booking and appointments are handled by the model, the booking link or a person
  '\\b(book|booking|booked|appointment|appointments|slot|slots|reschedule|cancel|cancelled|confirm|confirmed|available|availability|free time|come (today|tomorrow|tonight|now)|aaj|kal|parso|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday)\\b',
  // medical advice, symptoms getting worse, reports, medicines
  '\\b(should i|can i|may i|is it (safe|ok|okay)|safe to|medicine|medicines|medication|tablet|tablets|dawai|dawa|exercise|exercises|stretch|stretches|surgery|operation|mri|x-?ray|scan|report|reports|diagnos\\w*|prescri\\w*|injection|steroid|ice|heat|worse|worsen\\w*|swelling|swollen|numb\\w*|tingling|fracture|broken|injur\\w*|accident|bleeding|fever|infection|pregnan\\w*|kya karu|kya karun|kaise theek|theek (hoga|ho jayega|nahi)|cure|heal(ing)?|why (is|does)|what is wrong)\\b',
  // things the knowledge base may or may not cover and this fallback does not try to match: a person (or the model) answers
  '\\b(parking|insurance|mediclaim|cashless|offers|discount|discounts|package|packages|membership|emi|instalment|installment|home visit|home service|online session|video call|policy|policies|metro|nearest|nearby|bus|waiting)\\b',
  // complaints, money disputes, people
  '\\b(complain\\w*|angry|worst|terrible|bad service|cheat\\w*|fraud|scam|refund|money back|waste|disappointed|legal|lawyer|police|consumer|sue|doctor se|speak to|talk to|call me|call back|callback|human|person|manager|owner|doctor ko)\\b',
  '[\\u0A80-\\u0DFF]',   // scripts other than Devanagari / Latin: not understood here
  'https?://|www\\.',
].join('|'), 'i');

const AI_FAQ_TOPICS = {
  pricing: /\b(price|prices|pricing|cost|costs|fee|fees|charge|charges|rate|rates|how much|kitna|kitne|kitni|paise|paisa|rupee|rupees|rs\.?)\b|₹|कीमत|फीस|कितना|कितने|कितनी|शुल्क|चार्ज/i,
  hours: /\b(timing|timings|hours|opening|closing|open|close|closed|kab (tak )?(khul\w*|band\w*)|kitne baje|khulta|khulte|band hota|working days|working hours)\b|समय|कब खुल|खुलता|खुलते|बंद/i,
  location: /\b(address|location|located|where|directions?|map|landmark|how to reach|kahan|kaha|kidhar|pata)\b|पता|कहाँ|कहां|किधर/i,
  services: /\b(services?|treatments?|do you (treat|offer|do|have)|what do you (do|offer|treat)|kya kya|kaun si|konsi|kon si)\b|सेवा|सेवाएं|इलाज/i,
};
const AI_FAQ_GREETING = /^(hi+|hello+|hey+|hii+|namaste|namaskar|good (morning|afternoon|evening)|नमस्ते|नमस्कार)[\s!.,🙏]*$/i;
const AI_FAQ_THANKS = /^(ok(ay)?|thanks?|thank you|thx|shukriya|dhanyavad|dhanyawad|धन्यवाद|शुक्रिया|👍|🙏)[\s!.,👍🙏]*$/i;

const aiFaqNorm = (t) => aiClean(t, 2000).toLowerCase().replace(/\s+/g, ' ').trim();

// -> { topics: ['pricing', ...] } | { greeting: true } | { thanks: true } | null
function aiFaqTopics(text) {
  const t = aiFaqNorm(text);
  if (!t || t.length > AI_FAQ_MAX_TEXT) return null;
  if (AI_FAQ_THANKS.test(t)) return { thanks: true };
  if (AI_FAQ_GREETING.test(t)) return { greeting: true };
  if (AI_FAQ_NOT_ROUTINE.test(t)) return null;
  let topics = Object.keys(AI_FAQ_TOPICS).filter((k) => AI_FAQ_TOPICS[k].test(t));
  // "knee treatment cost" asks the price of a service: it does not also ask for the list of services
  if (topics.includes('pricing') && topics.includes('services') && !/\b(services?|what do you|kya kya|kaun si|konsi|kon si|do you)\b|सेवा/i.test(t)) topics = topics.filter((k) => k !== 'services');
  return topics.length && topics.length <= 2 ? { topics } : null;
}

const aiFaqHasAmount = (s) => /₹\s*\d|\brs\.?\s*\d|\binr\s*\d|\d[\d,]*\s*(rupees?|rs)\b/i.test(s);

// Rows of one KB category whose content is short enough to quote whole. `match` ranks by words shared with the question.
function aiFaqRows(kb, pred, text) {
  const words = [...new Set(aiFaqNorm(text).split(/[^a-z0-9ऀ-ॿ]+/).filter((w) => w.length >= 4 && !['price', 'prices', 'cost', 'costs', 'fees', 'charge', 'charges', 'what', 'your', 'about', 'kitna', 'kitne', 'does', 'have', 'timing', 'timings', 'hours', 'services', 'service', 'treatment', 'treatments', 'address', 'location', 'where', 'much', 'open'].includes(w)))];
  const rows = kb.filter((k) => pred(k) && k.content.length <= AI_FAQ_MAX_ROW && k.title.length <= 100);
  const scored = rows.map((k) => ({ k, score: words.filter((w) => `${k.title} ${k.content}`.toLowerCase().includes(w)).length }));
  const best = Math.max(0, ...scored.map((s) => s.score));
  return (best > 0 ? scored.filter((s) => s.score === best) : scored).map((s) => s.k);
}

// x: the W13 context (aiContext). Returns a decision in the model's shape (it passes aiValidateDecision) or null.
function aiFaqDecision(x) {
  if (!x || !Array.isArray(x.kb) || typeof x.text !== 'string') return null;
  if (aiEmergencyIn(x.text)) return null;
  const t = aiFaqTopics(x.text);
  if (!t) return null;
  const clinic = (x.profile && x.profile.clinic_name) || 'the clinic';
  const d = {
    intent: 'other', action: 'reply', needs_human: false, handoff_reason: '', confidence: AI_FAQ_CONFIDENCE, sentiment: 'neutral', language: 'English', lead_stage: 'warm',
    reply: '', booking: { date: null, time: null, time_window: null }, appointment_ref: null, follow_up_days: null, kb_refs: [], likely_service: null,
    lead_summary: '', priority: 'normal', staff_note: '', risk_flags: [],
  };
  if (t.thanks) return { ...d, intent: 'thanks_ack', action: 'no_reply', lead_stage: 'cold', lead_summary: 'Thanked the clinic.' };
  if (t.greeting) return { ...d, intent: 'greeting', reply: `Hello! Thank you for contacting ${clinic}. You can ask me about our services, prices, timings or location, and our team will help with anything else.`, lead_summary: 'Greeted the clinic.' };

  const refs = [];
  const parts = [];
  let service = null;
  const lines = (rows, f) => rows.slice(0, 4).map((k) => { refs.push(k.ref); return f(k); });
  const section = (head, rows, f) => { const l = lines(rows, f); if (l.length) parts.push(`${head}\n${l.join('\n')}`); return l.length > 0; };
  const covered = [];
  if (t.topics.includes('pricing')) {
    const rows = aiFaqRows(x.kb, (k) => (k.category === 'pricing' || k.category === 'services') && aiFaqHasAmount(k.content), x.text);
    if (section('Our prices:', rows, (k) => `- ${k.title}: ${k.content}`)) { covered.push('prices'); const s = rows.find((k) => k.category === 'services'); if (s && rows.length === 1) service = s.title; }
  }
  if (t.topics.includes('services')) {
    const rows = x.kb.filter((k) => k.category === 'services' && k.title.length <= 100);
    if (section(t.topics.includes('pricing') ? 'Our services:' : 'We offer:', rows, (k) => `- ${k.title}`)) covered.push('services');
  }
  if (t.topics.includes('hours')) {
    if (section('Our timings:', aiFaqRows(x.kb, (k) => k.category === 'hours', x.text), (k) => `- ${k.content}`)) covered.push('timings');
  }
  if (t.topics.includes('location')) {
    if (section('Our address:', aiFaqRows(x.kb, (k) => k.category === 'location', x.text), (k) => `- ${k.content}`)) covered.push('location');
  }
  // every topic asked about must be answered: a half answer is a hand-off, not a guess
  const asked = t.topics.length;
  if (!covered.length || covered.length < asked) return null;
  const reply = `${parts.join('\n\n')}\n\nOur team is happy to help with anything else.`;
  if (reply.length > AI_FAQ_MAX_REPLY) return null;
  const intent = t.topics.includes('pricing') ? 'pricing' : t.topics.includes('services') ? 'services_info' : 'location_hours';
  return { ...d, intent, reply, kb_refs: [...new Set(refs)], likely_service: service, lead_summary: `Asked about ${covered.join(' and ')}; answered from the knowledge base while the AI model was unavailable.` };
}

if (typeof module !== 'undefined') module.exports = { AI_FAQ_MAX_TEXT, AI_FAQ_MAX_REPLY, AI_FAQ_CONFIDENCE, AI_FAQ_NOT_ROUTINE, aiFaqTopics, aiFaqRows, aiFaqDecision };
