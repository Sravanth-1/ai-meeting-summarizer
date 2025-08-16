import express from 'express';
import rateLimit from 'express-rate-limit';
import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '5mb' })); // for large transcripts
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- Config ---
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;

if (!GROQ_API_KEY) console.warn('⚠️ Missing GROQ_API_KEY');
if (!FROM_EMAIL) console.warn('⚠️ Missing FROM_EMAIL (for email sending)');

// --- Rate limit ---
const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use('/api/', limiter);

// --- LLM helper ---
const SYSTEM_PROMPT = `You are a precise meeting notes summarizer.`;

function buildUserPrompt(transcript, extra) {
  // Use the prompt exactly as user provides, no fallback
  return `Transcript:\n${transcript}\n\nAdditional instruction from user:\n${extra || ''}`;
}

async function callGroq(messages) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 1500
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const promptTokens = data.usage?.prompt_tokens || 0;
  const completionTokens = data.usage?.completion_tokens || 0;
  return { content, promptTokens, completionTokens };
}

// --- API: summarize ---
app.post('/api/summarize', async (req, res) => {
  try {
    const { transcript, prompt } = req.body || {};
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(transcript, prompt) }
    ];

    const { content, promptTokens, completionTokens } = await callGroq(messages);
    res.json({ summary: content, model: GROQ_MODEL, tokens: { prompt: promptTokens, completion: completionTokens } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to summarize' });
  }
});

// --- Email via Resend ---
let resend;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
}

app.post("/api/send-email", async (req, res) => {
  try {
    console.log("Incoming request body:", req.body);
    const { email, summary } = req.body || {};

    if (!email) return res.status(400).json({ error: "Recipient email required" });
    if (!summary || !summary.trim()) return res.status(400).json({ error: "Summary content required" });

    if (resend) {
      console.log("✅ Sending email via Resend...");
      const out = await resend.emails.send({
        from: FROM_EMAIL,
        to: [email],
        subject: "Meeting Summary",
        html: `<div>${summary}</div>`
      });

      console.log("Resend response:", out);
      if (out.error) throw out.error;

      return res.json({ ok: true, id: out.data?.id || "sent" });
    } else {
      return res.status(500).json({ error: "Email service not configured" });
    }
  } catch (err) {
    console.error("❌ Failed to send email:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
