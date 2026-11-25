const { chromium } = require('playwright-core');
const { BRANDS, PROMPTS } = require('./brands');

function getBrowserEndpoint() {
  let endpoint =
    process.env.BROWSER_WS_ENDPOINT ||
    process.env.BROWSER_WS_ENDPOINT_PRIVATE ||
    process.env.BROWSER_PLAYWRIGHT_ENDPOINT ||
    '';

  if (!endpoint) return '';
  if (endpoint.startsWith('http://')) endpoint = endpoint.replace('http://', 'ws://');
  if (endpoint.startsWith('https://')) endpoint = endpoint.replace('https://', 'wss://');

  const token = process.env.BROWSER_TOKEN || process.env.TOKEN || '';
  if (token && !endpoint.includes('token=')) {
    endpoint += (endpoint.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
  }
  return endpoint;
}

const AGENT_JOIN_REGEX =
  /(connected with|you are now chatting with|my name is|agent has joined|vous clavardez maintenant avec|je m'appelle|un agent)/i;

async function findInFrames(page, selector) {
  for (const frame of page.frames()) {
    try {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible({ timeout: 800 })) return loc;
    } catch (_) {}
  }
  return null;
}

async function scrapeMessages(page, selector) {
  const texts = [];
  for (const frame of page.frames()) {
    try {
      const items = await frame.locator(selector).allInnerTexts();
      for (const raw of items) {
        const clean = raw.replace(/\s+/g, ' ').trim();
        if (clean.length > 2 && clean.length < 800 && !texts.includes(clean)) {
          texts.push(clean);
        }
      }
    } catch (_) {}
  }
  return texts;
}

async function runChatSession(session, { onUpdate, onComplete, shouldStop }) {
  const brand = BRANDS[session.brandId];
  const endpoint = getBrowserEndpoint();
  const maxDurationMs = Number(process.env.MAX_CHAT_DURATION_SEC || 240) * 1000;
  const startedAt = Date.now();

  const log = (sender, text) => {
    session.transcript.push({ sender, text, time: new Date().toISOString() });
    onUpdate();
  };

  if (!endpoint) {
    session.status = 'failed';
    session.error = 'Missing BROWSER_WS_ENDPOINT environment variable.';
    log('system', session.error);
    session.endedAt = new Date().toISOString();
    onComplete();
    return;
  }

  let browser;
  let context;
  let screenshotTimer;

  try {
    session.step = 'Connecting to Chromium...';
    onUpdate();

    browser = await chromium.connectOverCDP(endpoint, { timeout: 25000 });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: session.language === 'FR' ? 'fr-CA' : 'en-CA',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const captureFrame = async () => {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
        session.lastScreenshot = `data:image/jpeg;base64,${buf.toString('base64')}`;
        session.totalDurationSec = Math.round((Date.now() - startedAt) / 1000);
        onUpdate();
      } catch (_) {}
    };

    const targetUrl = session.customUrl || brand.urls[session.language] || brand.urls.EN;
    session.targetUrl = targetUrl;
    session.step = `Loading ${brand.name} (${session.language})...`;
    log('system', `Navigating to ${targetUrl}`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    await captureFrame();

    screenshotTimer = setInterval(captureFrame, 3000);

    // 1. Open chat launcher if present
    session.step = 'Looking for chat launcher...';
    onUpdate();
    const launcher = await findInFrames(page, brand.selectors.openChat);
    if (launcher) {
      await launcher.click({ timeout: 5000 }).catch(() => {});
      log('system', 'Clicked chat widget launcher');
      await page.waitForTimeout(3500);
    } else {
      log('system', 'No separate launcher button detected — checking for open chat input');
    }

    // 2. Locate chat input
    const input = await findInFrames(page, brand.selectors.input);
    const scriptPrompts =
      PROMPTS[session.language]?.[session.segment] || PROMPTS.EN.Billing;

    const seenMessages = new Set(await scrapeMessages(page, brand.selectors.messages));
    let firstPromptSentAt = null;
    let escalationRequestedAt = null;

    if (input) {
      session.step = 'Sending opening message...';
      onUpdate();

      await input.fill(scriptPrompts[0]);
      await input.press('Enter').catch(async () => {
        const sendBtn = await findInFrames(page, brand.selectors.send);
        if (sendBtn) await sendBtn.click().catch(() => {});
      });
      firstPromptSentAt = Date.now();
      log('user', scriptPrompts[0]);

      // 3. Poll for bot reply, then request live agent and track wait time
      let escalated = false;
      while (!shouldStop() && Date.now() - startedAt < maxDurationMs) {
        await page.waitForTimeout(2500);
        const currentMessages = await scrapeMessages(page, brand.selectors.messages);

        for (const msg of currentMessages) {
          if (seenMessages.has(msg) || msg === scriptPrompts[0] || msg === scriptPrompts[1]) {
            continue;
          }
          seenMessages.add(msg);

          if (session.botResponseSec === null && firstPromptSentAt) {
            session.botResponseSec = Number(((Date.now() - firstPromptSentAt) / 1000).toFixed(1));
          }

          if (escalated && AGENT_JOIN_REGEX.test(msg)) {
            session.agentWaitSec = Number(((Date.now() - escalationRequestedAt) / 1000).toFixed(1));
            log('agent', msg);
            session.step = 'Live agent connected';
            session.status = 'completed';
            break;
          } else {
            log('bot', msg);
          }
        }

        if (session.status === 'completed') break;

        // Escalate to live agent after bot responds or 15s passes
        if (
          !escalated &&
          firstPromptSentAt &&
          (session.botResponseSec !== null || Date.now() - firstPromptSentAt > 15000)
        ) {
          session.step = 'Requesting live agent...';
          onUpdate();
          const activeInput = await findInFrames(page, brand.selectors.input);
          if (activeInput) {
            await activeInput.fill(scriptPrompts[1]).catch(() => {});
            await activeInput.press('Enter').catch(() => {});
            escalationRequestedAt = Date.now();
            escalated = true;
            log('user', scriptPrompts[1]);
            session.step = 'Waiting in queue for live agent...';
            onUpdate();
          }
        }
      }
    } else {
      session.step = 'Chat input not detected (check screenshot)';
      log('system', 'Could not locate chat input automatically. Inspect screenshot to tune selector in brands.js.');
    }

    if (shouldStop()) {
      session.status = 'stopped';
      session.step = 'Stopped by user';
      log('system', 'Session stopped manually.');
    } else if (session.status === 'running') {
      session.status = 'completed';
      session.step = session.agentWaitSec !== null ? 'Completed' : 'Timed out waiting for agent';
    }

    await captureFrame();
  } catch (err) {
    session.status = 'failed';
    session.error = err.message;
    session.step = 'Error';
    log('system', `Error: ${err.message}`);
  } finally {
    if (screenshotTimer) clearInterval(screenshotTimer);
    session.totalDurationSec = Math.round((Date.now() - startedAt) / 1000);
    session.endedAt = new Date().toISOString();
    try {
      if (context) await context.close();
      if (browser) await browser.close();
    } catch (_) {}
    onComplete();
  }
}

module.exports = { runChatSession, getBrowserEndpoint };
