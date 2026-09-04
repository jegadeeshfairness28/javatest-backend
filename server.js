require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ type: () => true, limit: '2mb' }));

const PORT = process.env.PORT || 8080;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO; // private results repo: answers.json + results/

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('Missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO in environment.');
  process.exit(1);
}

// ============ answers.json cache (all tests, keyed by testId) ============
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

// ============ concurrency limiter ============
let activeJobs = 0;
const MAX_CONCURRENT = 2;
const queue = [];
function runWithLimit(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      activeJobs++;
      fn().then(resolve, reject).finally(() => { activeJobs--; if (queue.length) queue.shift()(); });
    };
    if (activeJobs < MAX_CONCURRENT) task(); else queue.push(task);
  });
}
function cleanup(dir) { fs.rm(dir, { recursive: true, force: true }, () => {}); }

function detectClassInfo(code) {
  const pm = code.match(/public\s+(?:final\s+|abstract\s+)?class\s+(\w+)/);
  if (pm) return { compileFileName: pm[1], runClass: pm[1] };

  const classRe = /class\s+(\w+)/g;
  const names = [], starts = [];
  let m;
  while ((m = classRe.exec(code)) !== null) { names.push(m[1]); starts.push(m.index); }
  for (let i = 0; i < names.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : code.length;
    const segment = code.slice(start, end);
    if (/static\s+void\s+main/.test(segment)) return { compileFileName: 'Submission', runClass: names[i] };
  }
  return { compileFileName: 'Main', runClass: 'Main' };
}

function runJavaOnce(code, stdin) {
  return runWithLimit(() => new Promise((resolve) => {
    let dir;
    const { compileFileName, runClass } = detectClassInfo(code);
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'));
      fs.writeFileSync(path.join(dir, compileFileName + '.java'), code, 'utf-8');
    } catch (e) { return resolve({ error: 'Server error preparing sandbox: ' + e.message }); }

    execFile('javac', [compileFileName + '.java'], { cwd: dir, timeout: 10000 }, (compErr, _out, compStderr) => {
      if (compErr) { cleanup(dir); return resolve({ error: 'Compile error:\n' + (compStderr || compErr.message) }); }
      let finished = false;
      const child = spawn('java', ['-Xmx128m', '-cp', dir, runClass], { cwd: dir });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => {
        if (!finished) { finished = true; child.kill(); cleanup(dir); resolve({ error: 'Time limit exceeded (5s)' }); }
      }, 5000);
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      child.on('close', () => { if (finished) return; finished = true; clearTimeout(timer); cleanup(dir); resolve({ stdout, stderr }); });
      child.on('error', (e) => { if (finished) return; finished = true; clearTimeout(timer); cleanup(dir); resolve({ error: 'Could not run java: ' + e.message }); });
      try { child.stdin.write(stdin || ''); child.stdin.end(); } catch (e) {}
    });
  }));
}

async function runCodeAgainstTests(code, tests) {
  const results = [];
  for (const t of tests) {
    const run = await runJavaOnce(code, t.input);
    if (run.error) { results.push({ pass: false, error: run.error }); continue; }
    const actual = (run.stdout || '').replace(/\s+$/, '');
    const expected = (t.expectedOutput || '').replace(/\s+$/, '');
    results.push({ pass: actual === expected, expected, actual, stderr: run.stderr || '' });
  }
  return results;
}

async function pushResultToGitHub(testId, roll, record) {
  const filePath = 'results/' + testId + '/' + roll.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const content = Buffer.from(JSON.stringify(record, null, 2)).toString('base64');
  let sha = null;
  try {
    const getResp = await fetch(apiUrl, { headers: { Authorization: 'token ' + GITHUB_TOKEN } });
    if (getResp.ok) sha = (await getResp.json()).sha;
  } catch (e) {}
  const payload = { message: 'Submission: ' + roll, content };
  if (sha) payload.sha = sha;
  const putResp = await fetch(apiUrl, {
    method: 'PUT', headers: { Authorization: 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (putResp.ok) return { ok: true };
  return { ok: false, error: 'GitHub push failed (' + putResp.status + '): ' + await putResp.text() };
}

app.get('/', (req, res) => res.send('Java test backend is running.'));

app.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.action === 'verifyAccess') return res.json(await handleVerifyAccess(body));
    if (body.action === 'getGradingData') return res.json(await handleGetGradingData(body));
    if (body.action === 'checkSubmitted') return res.json(await handleCheckSubmitted(body));
    if (body.action === 'run') return res.json(await handleRun(body)); // fallback path only
    if (body.action === 'submit') return res.json(await handleSubmit(body)); // slow, authoritative server-side recompute (fallback)
    if (body.action === 'submitLocal') return res.json(await handleSubmitLocal(body)); // fast path: trusts client-computed score
    return res.json({ error: 'unknown action' });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Server-authoritative "already submitted?" check — this is what actually
// gates re-entry, not the student's own browser storage. To grant a
// reattempt, delete that student's result file (see results.html's
// "Allow Reattempt" button) and this check will pass again.
async function handleCheckSubmitted(body) {
  const roll = String(body.rollNumber || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = 'results/' + body.testId + '/' + roll + '.json';
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const resp = await fetch(apiUrl, { headers: { Authorization: 'token ' + GITHUB_TOKEN } });
  if (resp.status === 404) return { submitted: false };
  if (!resp.ok) return { submitted: false, checkError: 'status ' + resp.status };
  const meta = await resp.json();
  const decoded = Buffer.from(meta.content, 'base64').toString('utf-8');
  const record = JSON.parse(decoded);
  return { submitted: true, record };
}

// Fast path support: hand the full answer key (including hidden test cases)
// to the browser so the student's own JDK can grade it. This is faster but
// means hidden test cases are no longer secret from a technically inclined
// student at submit time — a deliberate trade-off requested for speed.
async function handleGetGradingData(body) {
  const test = await getTestAnswers(body.testId);
  return {
    marksConfig: test.marksConfig || { mcqEach: 1, codingEach: 5 },
    mcqAnswers: test.mcqAnswers,
    codingTests: test.codingTests
  };
}

// Fast path: store whatever score the client (local JDK) computed, with
// basic sanity clamping. No server-side recompilation — this is the whole
// point of the fast path. Use action "submit" instead for the slower,
// independently-verified version.
// Builds a student-safe breakdown: which questions scored what, and WHY,
// without ever exposing the actual hidden test inputs/outputs.
function buildBreakdown(test, codingDetail) {
  const breakdown = [];
  const codingEach = (test.marksConfig || {}).codingEach || 5;
  for (const cid in test.codingTests) {
    const tests = test.codingTests[cid];
    const detail = codingDetail[cid];
    if (!detail || !detail.results || !detail.results.length) {
      breakdown.push({ id: cid, awarded: 0, max: codingEach, message: 'Not attempted or no output produced' });
      continue;
    }
    const results = detail.results;
    const allPassed = results.every(r => r.pass);
    const visibleIdx = tests.map((t, i) => (t.visible ? i : -1)).filter(i => i >= 0);
    const visiblePassed = visibleIdx.length > 0 && visibleIdx.every(i => results[i] && results[i].pass);
    let message;
    if (allPassed) message = 'Passed all tests';
    else if (visiblePassed) message = 'Sample tests passed, but hidden tests failed — your solution likely does not handle cases beyond the examples shown';
    else message = 'Some sample tests failed — review your code';
    breakdown.push({ id: cid, awarded: detail.awarded || 0, max: codingEach, message });
  }
  return breakdown;
}

async function handleSubmitLocal(body) {
  const test = await getTestAnswers(body.testId);
  const marks = test.marksConfig || { mcqEach: 1, codingEach: 5 };
  const roll = String(body.rollNumber || '').trim();
  const name = String(body.name || '').trim();
  if (!roll || !name) return { error: 'missing roll number or name' };

  const maxScore = (Object.keys(test.mcqAnswers).length * marks.mcqEach) +
                    (Object.keys(test.codingTests).length * marks.codingEach);
  const clamp = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
  const mcqMax = Object.keys(test.mcqAnswers).length * marks.mcqEach;
  const codingMax = Object.keys(test.codingTests).length * marks.codingEach;
  const mcqScore = clamp(body.mcqScore, mcqMax);
  const codingScore = clamp(body.codingScore, codingMax);
  const totalScore = mcqScore + codingScore;

  const record = {
    testId: body.testId, rollNumber: roll, name, submittedAt: new Date().toISOString(),
    gradedBy: 'client-local-jdk',
    mcqScore, codingScore, totalScore, maxScore,
    mcqDetail: body.mcqDetail || {}, codingDetail: body.codingDetail || {},
    integrity: body.integrity || {}
  };

  const pushResult = await pushResultToGitHub(body.testId, roll, record);
  const breakdown = buildBreakdown(test, record.codingDetail);
  return { ok: true, totalScore, maxScore, mcqScore, codingScore, breakdown, saved: pushResult.ok, saveError: pushResult.error || null };
}

async function handleVerifyAccess(body) {
  const test = await getTestAnswers(body.testId);
  return { ok: String(body.password || '') === String(test.accessPassword || '') };
}

// Fallback run path (used only if a student's local runner is unreachable and
// the frontend chooses to fall back here — not used for scoring).
async function handleRun(body) {
  const test = await getTestAnswers(body.testId);
  const tests = test.codingTests[body.questionId];
  if (!tests) return { error: 'invalid question id' };
  const visibleOnly = tests.filter(t => t.visible);
  return { results: await runCodeAgainstTests(body.code, visibleOnly.length ? visibleOnly : tests) };
}

async function handleSubmit(body) {
  const test = await getTestAnswers(body.testId);
  const marks = test.marksConfig || { mcqEach: 1, codingEach: 5 };
  const roll = String(body.rollNumber || '').trim();
  const name = String(body.name || '').trim();
  if (!roll || !name) return { error: 'missing roll number or name' };

  const mcqAnswers = body.mcqAnswers || {};
  const codingCode = body.codingCode || {};

  let mcqScore = 0;
  const mcqDetail = {};
  for (const qid in test.mcqAnswers) {
    const correct = test.mcqAnswers[qid];
    const given = Object.prototype.hasOwnProperty.call(mcqAnswers, qid) ? mcqAnswers[qid] : null;
    const isRight = given === correct;
    if (isRight) mcqScore += marks.mcqEach;
    mcqDetail[qid] = { given, correct: isRight };
  }

  let codingScore = 0;
  const codingDetail = {};
  for (const cid in test.codingTests) {
    const code = codingCode[cid] || '';
    const tests = test.codingTests[cid]; // ALL test cases (visible + hidden) count for grading
    const results = code.trim()
      ? await runCodeAgainstTests(code, tests)
      : tests.map(() => ({ pass: false, error: 'no code submitted' }));
    const allPass = results.every(r => r.pass);
    if (allPass) codingScore += marks.codingEach;
    codingDetail[cid] = { code, results, awarded: allPass ? marks.codingEach : 0 };
  }

  const totalScore = mcqScore + codingScore;
  const maxScore = (Object.keys(test.mcqAnswers).length * marks.mcqEach) +
                   (Object.keys(test.codingTests).length * marks.codingEach);

  const record = {
    testId: body.testId, rollNumber: roll, name, submittedAt: new Date().toISOString(),
    gradedBy: 'server-recompute',
    mcqScore, codingScore, totalScore, maxScore, mcqDetail, codingDetail,
    integrity: body.integrity || {}
  };

  const pushResult = await pushResultToGitHub(body.testId, roll, record);
  const breakdown = buildBreakdown(test, codingDetail);

  return {
    ok: true, totalScore, maxScore, mcqScore, codingScore, breakdown,
    saved: pushResult.ok, saveError: pushResult.error || null
  };
}

app.listen(PORT, () => console.log('Java test backend running on port ' + PORT));
