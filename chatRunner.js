const { chromium } = require('playwright-core');
const { BRANDS, PROMPTS, resolveBrandUrl } = require('./brands');

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
  /(connected with|you are now chatting with|my name is|agent has joined|specialist has joined|vous clavardez maintenant avec|je m'appelle|un agent s'est joint)/i;
const WAIT_TIME_REGEX =
  /(\b\d+\s*(?:to|-)\s*\d+\s*min(?:ute)?s?\b|\b\d+\s*min(?:ute)?s?\b|position\s*#?\d+|\b\d+\s*in\s*queue\b)/i;
const HOOPS_REGEX =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h)\s*(?:to|-|–|à)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h))/i;

async function findInFrames(page, selector) {
  for (const frame of page.frames()) {
    try {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible({ timeout: 800 })) return loc;
    } catch (_) {}
  }
  return null;
}

async function waitForInFrames(page, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findInFrames(page, selector);
    if (found) return found;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function clickBottomRightLauncher(page) {
  const target = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"], iframe, div')
    );

    let best = null;
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width < 32 || rect.width > 220 || rect.height < 32 || rect.height > 100) continue;
      if (rect.right < vw - 80 || rect.bottom < vh - 100) continue;

      let isFixed = style.position === 'fixed';
      let p = el.parentElement;
      while (!isFixed && p) {
        if (window.getComputedStyle(p).position === 'fixed') isFixed = true;
        p = p.parentElement;
      }
      if (!isFixed) continue;

      const z = parseInt(style.zIndex, 10) || 0;
      const isInteractive =
        ['BUTTON', 'A', 'IFRAME'].includes(el.tagName) ||
        el.getAttribute('role') === 'button' ||
        style.cursor === 'pointer';

      if (!isInteractive) continue;
      if (!best || z >= best.z) {
        best = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, z };
      }
    }
    return best;
  });

  if (!target) return false;
  await page.mouse.click(target.x, target.y);
  return true;
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

async function detectChatSystem(page) {
  try {
    const urls = page.frames().map((f) => f.url().toLowerCase()).join(' ');
    if (urls.includes('genesys') || urls.includes('mypurecloud')) return 'Genesys Web Messenger';
    if (urls.includes('liveperson') || urls.includes('lpsnmedia')) return 'LivePerson';
    if (urls.includes('salesforce') || urls.includes('force.com')) return 'Salesforce Live Chat';
    if (urls.includes('nuance') || urls.includes('touchcommerce')) return 'Nuance / TouchCommerce';
    if (urls.includes('ada.support')) return 'Ada Virtual Assistant';
    if (urls.includes('zendesk')) return 'Zendesk Messaging';
    if (urls.includes('intercom')) return 'Intercom';
    return 'Web Virtual Assistant / Live Chat';
  } catch (_) {
    return 'Web Chat';
  }
}

async function runChatSession(chat, { onUpdate, onTranscript, onComplete, shouldStop }) {
  const s = chat.structuredOutputs;
  const brandCfg = BRANDS[s.brand] || BRANDS.Rogers;
  const endpoint = getBrowserEndpoint();
  const maxDurationMs = Number(process.env.MAX_CHAT_DURATION_SEC || 240) * 1000;
  const startedAt = Date.now();
  const pathSteps = [];

  const pushTranscript = (role, text) => {
    const segment = { role, text, isFinal: true, timestamp: new Date().toISOString() };
    chat.transcript.push(segment);
    onTranscript(chat.id, segment);
  };

  if (!endpoint) {
    chat.status = 'ended';
    s.cxToAgent = 'Missing BROWSER_WS_ENDPOINT environment variable.';
    pushTranscript('system', s.cxToAgent);
    chat.endedAt = new Date().toISOString();
    onComplete();
    return;
  }

  let browser;
  let context;
  let screenshotTimer;

  try {
    chat.status = 'in-progress';
    onUpdate();

    browser = await chromium.connectOverCDP(endpoint, { timeout: 25000 });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: /^fr/i.test(s.language) ? 'fr-CA' : 'en-CA',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const captureFrame = async () => {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
        chat.lastScreenshot = `data:image/jpeg;base64,${buf.toString('base64')}`;
        onUpdate();
      } catch (_) {}
    };

    const targetUrl =
      chat.targetUrl || resolveBrandUrl(s.brand, s.segment, s.useCase, s.language);
    chat.targetUrl = targetUrl;
    pathSteps.push(`Loaded ${targetUrl}`);
    pushTranscript('system', `Navigating to ${targetUrl}`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.scrollBy(0, 250)).catch(() => {});
    await captureFrame();

    screenshotTimer = setInterval(captureFrame, 3000);

    // 1. Wait for launcher button (Need Help? / bottom-right chat icon)
    const launcher = await waitForInFrames(page, brandCfg.selectors.openChat, 15000);
    if (launcher) {
      await launcher
        .click({ timeout: 5000 })
        .catch(() => launcher.click({ force: true }).catch(() => {}));
      pathSteps.push('Clicked chat launcher');
      pushTranscript('system', 'Clicked chat widget launcher');
      await page.waitForTimeout(4000);
      await captureFrame();
    } else if (await clickBottomRightLauncher(page)) {
      pathSteps.push('Clicked bottom-right floating launcher');
      pushTranscript('system', 'Clicked bottom-right floating chat launcher');
      await page.waitForTimeout(4000);
      await captureFrame();
    } else {
      pathSteps.push('Launcher not detected');
      pushTranscript('system', 'No launcher button detected — checking for open chat input');
    }

    s.systemUsed = await detectChatSystem(page);
    onUpdate();

    // 2. Locate chat input inside page or frames
    const input = await waitForInFrames(page, brandCfg.selectors.input, 10000);
    const langKey = /^fr/i.test(s.language) ? 'FR' : 'EN';
    const ucKey = /sale/i.test(s.useCase) ? 'Sales' : 'Billing';
    const scriptPrompts = PROMPTS[langKey]?.[ucKey] || PROMPTS.EN.Billing;

    const seenMessages = new Set(await scrapeMessages(page, brandCfg.selectors.messages));
    let firstPromptSentAt = null;
    let escalationRequestedAt = null;
    let botReplied = false;
    let agentConnected = false;

    if (input) {
      await input.fill(scriptPrompts[0]);
      await input.press('Enter').catch(async () => {
        const sendBtn = await findInFrames(page, brandCfg.selectors.send);
        if (sendBtn) await sendBtn.click().catch(() => {});
      });
      firstPromptSentAt = Date.now();
      pathSteps.push('Sent opening prompt');
      pushTranscript('assistant', scriptPrompts[0]);

      let escalated = false;

      while (!shouldStop() && Date.now() - startedAt < maxDurationMs) {
        await page.waitForTimeout(2500);
        const currentMessages = await scrapeMessages(page, brandCfg.selectors.messages);

        for (const msg of currentMessages) {
          if (seenMessages.has(msg) || msg === scriptPrompts[0] || msg === scriptPrompts[1]) {
            continue;
          }
          seenMessages.add(msg);

          // Capture first bot reply speed
          if (!botReplied && firstPromptSentAt) {
            botReplied = true;
            const botSec = Math.round((Date.now() - firstPromptSentAt) / 1000);
            s.botResponseSec = botSec;
            if (!s.waitTimes || s.waitTimes === '—') {
              s.waitTimes = `Bot: ${botSec}s`;
            }
          }

          // Extract reported wait time & HOOPs if mentioned
          const waitMatch = msg.match(WAIT_TIME_REGEX);
          if (waitMatch) s.waitTimes = waitMatch[1];

          const hoopsMatch = msg.match(HOOPS_REGEX);
          if (hoopsMatch && !s.hoops) s.hoops = hoopsMatch[1];

          pushTranscript('user', msg);

          if (escalated && AGENT_JOIN_REGEX.test(msg)) {
            const ttaSec = Math.round((Date.now() - escalationRequestedAt) / 1000);
            s.timeToAgent = `${ttaSec}s`;
            agentConnected = true;
            pathSteps.push(`Live agent joined in ${ttaSec}s`);
            s.cxToAgent = `Live agent connected in ${ttaSec}s via ${s.systemUsed}.`;
            onUpdate();
            break;
          }
        }

        if (agentConnected) break;

        if (
          !escalated &&
          firstPromptSentAt &&
          (botReplied || Date.now() - firstPromptSentAt > 15000)
        ) {
          const activeInput = await findInFrames(page, brandCfg.selectors.input);
          if (activeInput) {
            await activeInput.fill(scriptPrompts[1]).catch(() => {});
            await activeInput.press('Enter').catch(async () => {
              const sendBtn = await findInFrames(page, brandCfg.selectors.send);
              if (sendBtn) await sendBtn.click().catch(() => {});
            });
            escalationRequestedAt = Date.now();
            escalated = true;
            pathSteps.push('Requested live agent');
            pushTranscript('assistant', scriptPrompts[1]);
          }
        }
      }

      if (!agentConnected) {
        s.cxToAgent = shouldStop()
          ? 'Session ended manually before live agent connected.'
          : 'Timed out waiting for live agent connection.';
      }
    } else {
      pathSteps.push('Chat input not found');
      s.cxToAgent =
        'Could not locate chat input automatically. Check the captured Chromium screenshot to inspect pre-chat buttons or geo-blocking.';
      pushTranscript('system', s.cxToAgent);
    }

    s.ivrOptions = pathSteps.join(' → ');
    await captureFrame();
  } catch (err) {
    s.cxToAgent = `Error: ${err.message}`;
    s.ivrOptions = pathSteps.join(' → ') || 'Failed during launch';
    pushTranscript('system', s.cxToAgent);
  } finally {
    if (screenshotTimer) clearInterval(screenshotTimer);
    chat.status = 'ended';
    chat.endedAt = new Date().toISOString();
    try {
      if (context) await context.close();
      if (browser) await browser.close();
    } catch (_) {}
    onComplete();
  }
}

module.exports = { runChatSession, getBrowserEndpoint };
