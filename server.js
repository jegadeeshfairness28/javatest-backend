require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ type: () => true, limit: '2mb' }));

const PORT = process.env.PORT || 8080;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO; // private results repo

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('Missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO in environment.');
  process.exit(1);
}

/**
 * IMPORTANT ARCHITECTURE NOTE:
 * This server no longer compiles or runs ANY student code. Grading is
 * 100% local (the student's own JDK/compiler via LocalRunner), because
 * Render's free tier proved too slow/unreliable under load — correct code
 * was timing out and getting marked wrong purely from infrastructure
 * slowness, not code error. If a student's local runner isn't available at
 * submit time, submission is BLOCKED with a clear message telling them to
 * start it — there is no silent server-side fallback anymore.
 *
 * This server's only jobs now:
 *  - hold the GitHub token (never exposed to students)
 *  - verify the test password
 *  - hand out the answer key so the student's own machine can grade
 *  - track attempt start-time authoritatively (fixes the timer bug where
 *    a stray earlier click silently ate exam time)
 *  - autosave student progress server-side (enables real resume/reattempt
 *    even from a different device, and abandoned-session tracking)
 *  - store the final score the student's machine computed
 */

// ============ answers.json cache ============
let answersCache = null, answersCacheAt = 0;
const CACHE_MS = 15000;

async function getAnswersFile() {
  const now = Date.now();
  if (answersCache && (now - answersCacheAt) < CACHE_MS) return answersCache;
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/answers.json`;
  const resp = await fetch(url, { headers: { Authorization: 'token ' + GITHUB_TOKEN } });
  if (!resp.ok) throw new Error('Could not load answers.json from GitHub: ' + resp.status);
  const meta = await resp.json();
  const decoded = Buffer.from(meta.content, 'base64').toString('utf-8');
  const data = JSON.parse(decoded);
  answersCache = data; answersCacheAt = now;
  return data;
}
async function getTestAnswers(testId) {
  const all = await getAnswersFile();
  const test = all.tests && all.tests[testId];
  if (!test) throw new Error('Unknown test id: ' + testId);
  return test;
}

// ============ generic GitHub file helpers ============
function safeRoll(roll) { return String(roll || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_'); }

async function ghGetJson(path) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: 'token ' + GITHUB_TOKEN } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('GitHub GET failed (' + resp.status + '): ' + path);
  const meta = await resp.json();
  return { data: JSON.parse(Buffer.from(meta.content, 'base64').toString('utf-8')), sha: meta.sha };
}
async function ghPutJson(path, obj, sha, message) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');
  const payload = { message: message || ('update ' + path), content };
  if (sha) payload.sha = sha;
  const resp = await fetch(url, { method: 'PUT', headers: { Authorization: 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!resp.ok) throw new Error('GitHub PUT failed (' + resp.status + '): ' + await resp.text());
  return (await resp.json()).content.sha;
}

function attemptPath(testId, roll) { return `attempts/${testId}/${safeRoll(roll)}.json`; }
function resultPath(testId, roll) { return `results/${testId}/${safeRoll(roll)}.json`; }

// ============ Routes ============
app.get('/', (req, res) => res.send('Java test backend is running (local-grading only).'));

app.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    switch (body.action) {
      case 'verifyAccess': return res.json(await handleVerifyAccess(body));
      case 'getGradingData': return res.json(await handleGetGradingData(body));
      case 'checkSubmitted': return res.json(await handleCheckSubmitted(body));
      case 'startAttempt': return res.json(await handleStartAttempt(body));
      case 'saveProgress': return res.json(await handleSaveProgress(body));
      case 'submitLocal': return res.json(await handleSubmitLocal(body));
      default: return res.json({ error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

async function handleVerifyAccess(body) {
  const test = await getTestAnswers(body.testId);
  return { ok: String(body.password || '') === String(test.accessPassword || '') };
}

async function handleGetGradingData(body) {
  const test = await getTestAnswers(body.testId);
  return {
    marksConfig: test.marksConfig || { mcqEach: 1 },
    mcqAnswers: test.mcqAnswers,
    codingSections: test.codingSections || {}
  };
}

async function handleCheckSubmitted(body) {
  const roll = safeRoll(body.rollNumber);
  const existing = await ghGetJson(resultPath(body.testId, roll));
  if (!existing) return { submitted: false };
  return { submitted: true, record: existing.data };
}

// Authoritative start time — fixes the bug where a stray earlier click
// silently kept ticking in a student's browser storage without them
// realizing it. First call creates the record; every later call (e.g. a
// page refresh) returns the SAME original startedAt, never a new one.
async function handleStartAttempt(body) {
  const roll = safeRoll(body.rollNumber);
  const name = String(body.name || '').trim();
  if (!roll) return { error: 'missing roll number' };
  const existing = await ghGetJson(attemptPath(body.testId, roll));
  if (existing) {
    return { startedAt: existing.data.startedAt, progress: existing.data.progress || null };
  }
  const now = new Date().toISOString();
  const data = { rollNumber: roll, name, startedAt: now, lastActivityAt: now, progress: null };
  await ghPutJson(attemptPath(body.testId, roll), data, null, 'start attempt: ' + roll);
  return { startedAt: now, progress: null };
}

// Server-side backup of in-progress answers — lets a student resume on a
// different device/browser, and lets the teacher see how far someone got
// even if they never clicked Submit.
async function handleSaveProgress(body) {
  const roll = safeRoll(body.rollNumber);
  if (!roll) return { error: 'missing roll number' };
  const existing = await ghGetJson(attemptPath(body.testId, roll));
  const now = new Date().toISOString();
  const data = existing ? existing.data : { rollNumber: roll, name: body.name || '', startedAt: now };
  data.lastActivityAt = now;
  data.progress = {
    mcqAnswers: body.mcqAnswers || {},
    codingCode: body.codingCode || {},
    warnings: (body.integrity && body.integrity.warnings) || 0
  };
  await ghPutJson(attemptPath(body.testId, roll), data, existing ? existing.sha : null, 'progress: ' + roll);
  return { ok: true };
}

// The ONLY submit path. Trusts the score the student's own machine
// computed (that machine actually compiled and ran the code — this server
// never does). Duration is computed from the authoritative attempt record,
// not from anything the client claims.
async function handleSubmitLocal(body) {
  const test = await getTestAnswers(body.testId);
  const marks = test.marksConfig || { mcqEach: 1 };
  const roll = safeRoll(body.rollNumber);
  const name = String(body.name || '').trim();
  if (!roll || !name) return { error: 'missing roll number or name' };

  const codingDetail = body.codingDetail || {};
  const mcqMax = Object.keys(test.mcqAnswers).length * marks.mcqEach;
  let codingMax = 0;
  const sectionTotals = {}; // sid -> { obtained, max } — names filled in client-side from TEST.codingSections
  for (const sid in (test.codingSections || {})) {
    const sec = test.codingSections[sid];
    const qids = Object.keys(sec.questions || {});
    const secMax = qids.length * sec.marksPerQuestion;
    codingMax += secMax;
    let obtained = 0;
    qids.forEach(qid => { if (codingDetail[qid]) obtained += codingDetail[qid].awarded || 0; });
    sectionTotals[sid] = { obtained, max: secMax };
  }
  const maxScore = mcqMax + codingMax;
  const clamp = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
  const mcqScore = clamp(body.mcqScore, mcqMax);
  const codingScore = clamp(body.codingScore, codingMax);
  const totalScore = mcqScore + codingScore;

  const attempt = await ghGetJson(attemptPath(body.testId, roll));
  const startedAt = attempt ? attempt.data.startedAt : null;
  const submittedAt = new Date().toISOString();
  const durationMinutes = startedAt ? Math.round((new Date(submittedAt) - new Date(startedAt)) / 60000) : null;

  const record = {
    testId: body.testId, rollNumber: roll, name,
    startedAt, submittedAt, durationMinutes,
    gradedBy: 'client-local-jdk',
    mcqScore, codingScore, totalScore, maxScore, mcqMax, codingMax, sectionTotals,
    mcqDetail: body.mcqDetail || {}, codingDetail,
    integrity: body.integrity || {}
  };

  const existingResult = await ghGetJson(resultPath(body.testId, roll));
  await ghPutJson(resultPath(body.testId, roll), record, existingResult ? existingResult.sha : null, 'submission: ' + roll);

  return { ok: true, totalScore, maxScore, mcqScore, codingScore, mcqMax, codingMax, sectionTotals, saved: true };
}

app.listen(PORT, () => console.log('Java test backend running on port ' + PORT));
