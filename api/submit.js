/* ===================================================================
   ORBIS CONCIERGE — lead capture endpoint
   Deploy at /api/submit.js in the same Vercel project as intake.js.
   ----------------------------------------------------------------
   When a chat ends, chat-embed.html POSTs the full transcript here.
   This function:
     1. Uses Claude to pull structured fields + a short summary out of the conversation.
     2. Writes a row to the Airtable "Concierge Leads" table (incl. a rolling Summary).
     3. Emails the lead to hello@orbisdesign.group via Resend.
   Each delivery is independent — if one fails, the other still runs.

   ENV VARS (set in Vercel → Settings → Environment Variables):
     ANTHROPIC_API_KEY   — already set for intake.js
     AIRTABLE_TOKEN      — Airtable personal access token (scopes: data.records:read + data.records:write)
     RESEND_API_KEY      — Resend API key for sending the email
   ================================================================ */

import Anthropic from '@anthropic-ai/sdk';

/* === SETTINGS === */
const AIRTABLE_BASE_ID = 'appIMj9llvTcnJfm0';          // Orbis Intake base
const AIRTABLE_TABLE   = 'Concierge Leads';            // table created for these leads
const LEAD_TO          = 'hello@orbisdesign.group';    // where the email lands
const LEAD_FROM        = 'Orbis Concierge <concierge@orbisdesign.group>'; // must be a Resend-verified domain
const EXTRACT_MODEL    = 'claude-sonnet-4-6';

/* === Pull a clean candidate name out of the visitor's first reply === */
/* (mirrors intake.js so we can fetch this person's prior summary for continuity) */
function firstUserName(messages) {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  let s = firstUser.content.trim();
  s = s.replace(/^(hi|hello|hey)[,!.\s]+/i, '');
  s = s.replace(/^(i'?m|i am|my name is|name'?s|this is|it'?s)\s+/i, '');
  s = s.split(/[,\n]/)[0];
  s = s.replace(/\s+(from|with|at|of)\s+.*$/i, '');
  s = s.replace(/[.!?]+$/, '').trim();
  if (!s || s.length > 60 || s.split(/\s+/).length > 5) return '';
  return s;
}

/* === Fetch this person's most recent prior Summary (for a cumulative update) === */
async function lookupPriorSummary(name) {
  if (!process.env.AIRTABLE_TOKEN || !name) return '';
  try {
    const safe = name.replace(/"/g, '\\"');
    const params = new URLSearchParams();
    params.set('filterByFormula', `LOWER(TRIM({Name}))=LOWER(TRIM("${safe}"))`);
    params.append('sort[0][field]', 'Submitted At');
    params.append('sort[0][direction]', 'desc');
    params.set('maxRecords', '1');
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
    if (!res.ok) return '';
    const data = await res.json();
    const rec = data.records && data.records[0];
    return (rec && rec.fields && rec.fields.Summary) || '';
  } catch (err) {
    console.error('[orbis submit] prior-summary lookup skipped:', err);
    return '';
  }
}

/* === Turn the raw transcript into a structured lead (+ rolling summary) === */
async function extractLead(anthropic, transcript, priorSummary) {
  const priorBlock = priorSummary
    ? `\nThis person has spoken with Orbis before. A PRIOR SUMMARY from earlier conversation(s) is provided below. Produce an UPDATED, CUMULATIVE "summary" that folds the earlier context together with this new conversation — keep the earlier facts, add what's new, and note what changed.\n\nPRIOR SUMMARY:\n${priorSummary}\n`
    : '';

  const prompt = `Below is a transcript of an intake conversation between the Orbis Concierge (assistant) and a prospective client (user). Extract the lead's details into JSON. Use an empty string for anything not mentioned — never guess. For "urgency" return exactly one of: "Urgent", "Not urgent", "Unknown".

The "summary" field is a 2-3 sentence note written for the Orbis team: who this person is, their project, what they need, and any notable context or next step. Neutral and factual, no fluff, no marketing language.
${priorBlock}
Return ONLY a JSON object, no prose, with these keys:
{"name":"","email":"","phone":"","company":"","role":"","projectType":"","location":"","size":"","servicesNeeded":"","referral":"","urgency":"","summary":""}

Transcript:
${transcript}`;

  const res = await anthropic.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = res.content[0].text.trim();
  // strip code fences if the model added them
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

/* === Write the lead to Airtable === */
async function writeToAirtable(lead, transcript) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  const fields = {
    'Name':            lead.name || 'Unknown',
    'Email':           lead.email || '',
    'Phone':           lead.phone || '',
    'Company':         lead.company || '',
    'Role':            lead.role || '',
    'Project Type':    lead.projectType || '',
    'Location':        lead.location || '',
    'Size':            lead.size || '',
    'Services Needed': lead.servicesNeeded || '',
    'Referral':        lead.referral || '',
    'Urgency':         ['Urgent', 'Not urgent', 'Unknown'].includes(lead.urgency) ? lead.urgency : 'Unknown',
    'Status':          'New',
    'Summary':         lead.summary || '',
    'Transcript':      transcript,
    'Submitted At':    new Date().toISOString(),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  return res.json();
}

/* === Email the lead via Resend === */
async function emailLead(lead, transcript) {
  const line = (label, val) => val ? `<tr><td style="padding:4px 16px 4px 0;color:#8A8478;">${label}</td><td style="padding:4px 0;">${val}</td></tr>` : '';
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0E0D0B;max-width:620px;">
      <h2 style="font-weight:600;margin:0 0 4px;">New Orbis Concierge lead</h2>
      <p style="color:#8A8478;margin:0 0 18px;">${new Date().toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' })} (AST)</p>
      ${lead.summary ? `<p style="margin:0 0 18px;padding:12px 16px;background:#F4F0E8;border-left:2px solid #0E0D0B;font-size:14px;">${lead.summary}</p>` : ''}
      <table style="border-collapse:collapse;font-size:14px;">
        ${line('Name', lead.name)}
        ${line('Email', lead.email)}
        ${line('Phone', lead.phone)}
        ${line('Company', lead.company)}
        ${line('Role', lead.role)}
        ${line('Project', lead.projectType)}
        ${line('Location', lead.location)}
        ${line('Size', lead.size)}
        ${line('Needs', lead.servicesNeeded)}
        ${line('Referral', lead.referral)}
        ${line('Urgency', lead.urgency)}
      </table>
      <h3 style="font-weight:600;margin:24px 0 8px;">Transcript</h3>
      <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#F4F0E8;padding:16px;border-radius:6px;">${transcript.replace(/</g, '&lt;')}</pre>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: LEAD_FROM,
      to: [LEAD_TO],
      reply_to: lead.email || undefined,
      subject: `New lead — ${lead.name || 'Unknown'}${lead.company ? ' · ' + lead.company : ''}`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

/* === HANDLER === */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid messages' });
  }

  // Build a readable transcript
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'Client' : 'Concierge'}: ${m.content}`)
    .join('\n\n');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Fetch this person's prior summary (if any) so the new summary is cumulative.
  const priorSummary = await lookupPriorSummary(firstUserName(messages));

  // Extract structured fields + summary (fall back to empty lead if it fails)
  let lead;
  try {
    lead = await extractLead(anthropic, transcript, priorSummary);
  } catch (err) {
    console.error('[orbis submit] extraction failed:', err);
    lead = { name: '', email: '', phone: '', company: '', role: '', projectType: '', location: '', size: '', servicesNeeded: '', referral: '', urgency: 'Unknown', summary: priorSummary || '' };
  }

  // Deliver to both targets independently
  const results = await Promise.allSettled([
    writeToAirtable(lead, transcript),
    emailLead(lead, transcript),
  ]);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[orbis submit] ${i === 0 ? 'Airtable' : 'Email'} delivery failed:`, r.reason);
    }
  });

  const anyOk = results.some(r => r.status === 'fulfilled');
  return res.status(anyOk ? 200 : 500).json({
    ok: anyOk,
    airtable: results[0].status,
    email: results[1].status,
  });
}
