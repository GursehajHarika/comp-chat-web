const { chromium } = require('playwright-core');
const { BRANDS, resolveBrandUrl } = require('./brands');

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

function resolveVapiAssistantId(useCase, language) {
  const uc = /sale/i.test(useCase || '') ? 'SALES' : 'BILLING';
  const lang = /^fr/i.test(language || '') ? 'FR' : 'EN';
  return (
    process.env[`VAPI_ASSISTANT_ID_${uc}_${lang}`] ||
    process.env[`VAPI_ASSISTANT_ID_${uc}`] ||
    process.env.VAPI_ASSISTANT_ID ||
    ''
  );
}

async function createVapiSession(structuredOutputs) {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = resolveVapiAssistantId(
    structuredOutputs.useCase,
    structuredOutputs.language
  );
  if (!apiKey || !assistantId) return null;

  const res = await fetch('https://api.vapi.ai/session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assistantId,
      assistantOverrides: {
        variableValues: {
          brand: structuredOutputs.brand,
          segment: structuredOutputs.segment,
          useCase: structuredOutputs.useCase,
          language: structuredOutputs.language
        }
      }
    })
  });

  if (!res.ok) {
    throw new Error(`Vapi /session failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return { sessionId: data.id, assistantId };
}

async function askVapiChat(sessionId, inputText) {
  const apiKey = process.env.VAPI_API_KEY;
  const res = await fetch('https://api.vapi.ai/chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sessionId, input: inputText })
  });

  if (!res.ok) {
    throw new Error(`Vapi /chat failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return (data.output || [])
    .filter((m) => m.role === 'assistant' && m.content)
    .map((m) => m.content.trim())
    .join(' ')
    .trim();
}

const AGENT_JOIN_REGEX =
  /(connected with|you are now chatting with|my name is|agent has joined|specialist has joined|vous clavardez maintenant avec|je m'appelle|un agent s'est joint)/i;
const WAIT_TIME_REGEX =
  /(\b\d+\s*(?:to|-)\s*\d+\s*min(?:ute)?s?\b|\b\d+\s*min(?:ute)?s?\b|position\s*#?\d+|\b\d+\s*in\s*queue\b)/i;
const HOOPS_REGEX =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h)\s*(?:to|-|–|à)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h))/i;

const IGNORED_BUTTON_REGEX =
  /^(close|minimize|minimise|maximize|end chat|end|send|envoyer|fermer|réduire|feedback|help|need help\??|ask anna|menu|back|x|×)$/i;

async function findInFrames(page, selector) {
  for (const frame of page.frames()) {
    try {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible({ timeout: 600 })) return loc;
    } catch (_) {}
  }
  return null;
}

async function findInputWithFrame(page, selector) {
  for (const frame of page.frames()) {
    try {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible({ timeout: 600 })) {
        return { frame, locator: loc };
      }
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

async function scrapeMessages(page, selector, inputSelector) {
  const foundInput = await findInputWithFrame(page, inputSelector);
  const framesToCheck = foundInput ? [foundInput.frame] : page.frames();
  const texts = [];

  for (const frame of framesToCheck) {
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

// Finds clickable chat option buttons scoped to the chat frame or chat container around #chatMessage
async function getChatOptionButtons(page, inputSelector) {
  const found = await findInputWithFrame(page, inputSelector);
  const frames = found ? [found.frame] : page.frames();
  const results = [];

  for (const frame of frames) {
    const isMain = frame === page.mainFrame();
    try {
      const items = await frame.evaluate(
        ({ sel, isMainFrame }) => {
          let root = document.body;
          if (isMainFrame) {
            const inputEl = document.querySelector(sel);
            if (inputEl) {
              // Walk up from #chatMessage to find the enclosing chat panel (narrower than full page)
              let cur = inputEl.parentElement;
              let best = cur;
              while (cur && cur !== document.body) {
                const r = cur.getBoundingClientRect();
                if (r.width >= 260 && r.width <= 650 && r.height >= 260) {
                  best = cur;
                }
                cur = cur.parentElement;
              }
              root = best || inputEl.parentElement || document.body;
            }
          }

          const candidates = root.querySelectorAll(
            'button, [role="button"], a, li, div, span'
          );
          const out = [];
          const seen = new Set();

          for (const el of candidates) {
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              Number(style.opacity) === 0 ||
              el.disabled
            ) {
              continue;
            }

            const tag = el.tagName;
            const isExplicit =
              tag === 'BUTTON' ||
              tag === 'A' ||
              el.getAttribute('role') === 'button' ||
              el.hasAttribute('tabindex');
            const isPointer = style.cursor === 'pointer';

            if (!isExplicit && !isPointer) continue;

            // Avoid selecting container wrappers that hold nested clickable elements
            if (!isExplicit && el.querySelector('button, a, [role="button"], input, textarea')) {
              continue;
            }

            const rect = el.getBoundingClientRect();
            if (rect.width < 24 || rect.width > 460 || rect.height < 18 || rect.height > 96) {
              continue;
            }

            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length < 2 || text.length > 90) continue;
            if (seen.has(text)) continue;
            seen.add(text);

            out.push({
              text,
              cx: Math.round(rect.left + rect.width / 2),
              cy: Math.round(rect.top + rect.height / 2)
            });
          }
          return out;
        },
        { sel: inputSelector, isMainFrame: isMain }
      );

      for (const item of items) {
        if (IGNORED_BUTTON_REGEX.test(item.text)) continue;
        results.push({ ...item, frame });
      }
    } catch (_) {}
  }

  return results;
}

async function tryClickChatOption(page, replyText, inputSelector) {
  const cleanReply = String(replyText || '')
    .replace(/^["'`[\]()]+|["'`[\]()]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanReply) return null;

  const options = await getChatOptionButtons(page, inputSelector);
  if (!options.length) return null;

  const targetLower = cleanReply.toLowerCase();

  // 1. Exact case-insensitive match
  let match = options.find((o) => o.text.toLowerCase() === targetLower);
  // 2. Substring match (handles Vapi adding/dropping minor words or punctuation)
  if (!match) {
    match = options.find(
      (o) =>
        o.text.toLowerCase().includes(targetLower) ||
        targetLower.includes(o.text.toLowerCase())
    );
  }
  if (!match) return null;

  try {
    const loc = match.frame.getByText(match.text, { exact: true }).first();
    if (await loc.isVisible({ timeout: 1000 })) {
      await loc.click({ timeout: 4000 });
      return match.text;
    }
  } catch (_) {}

  // Coordinate click inside the frame as fallback
  try {
    const frameEl = await match.frame.frameElement().catch(() => null);
    if (frameEl) {
      const box = await frameEl.boundingBox();
      if (box) {
        await page.mouse.click(box.x + match.cx, box.y + match.cy);
        return match.text;
      }
    } else {
      await page.mouse.click(match.cx, match.cy);
      return match.text;
    }
  } catch (_) {}

  return null;
}

async function isChatInputEnabled(page, inputSelector) {
  const found = await findInputWithFrame(page, inputSelector);
  if (!found) return false;
  try {
    return await found.locator.isEnabled({ timeout: 500 });
  } catch (_) {
    return false;
  }
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

async function runChatSession(
  chat,
  { onUpdate, onTranscript, onComplete, onRegisterController, shouldStop }
) {
  const s = chat.structuredOutputs;
  const brandCfg = BRANDS[s.brand] || BRANDS.Rogers;
  const endpoint = getBrowserEndpoint();
  const aiMaxDurationMs = Number(process.env.MAX_CHAT_DURATION_SEC || 240) * 1000;
  const manualMaxDurationMs = Number(process.env.MAX_MANUAL_DURATION_SEC || 900) * 1000;
  const maxVapiTurns = Number(process.env.MAX_VAPI_TURNS || 15);
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
  let page;
  let screenshotTimer;

  const seenMessages = new Set();
  const sentByUs = new Set();
  const pendingManualNotes = [];
  let firstMessageSentAt = null;
  let vapiStarted = false;
  let lastButtonsKey = '';
  let actionLock = Promise.resolve();

  const enqueueAction = (fn) => {
    const next = actionLock.then(fn, fn);
    actionLock = next.catch(() => {});
    return next;
  };

  const captureFrame = async () => {
    if (!page) return;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
      chat.lastScreenshot = `data:image/jpeg;base64,${buf.toString('base64')}`;
      onUpdate();
    } catch (_) {}
  };

  const sendToCarrier = async (replyText, senderRole = 'assistant') => {
    if (!page || !replyText) return false;
    return enqueueAction(async () => {
      // 1. Always try matching an on-screen chat option button first
      const clickedLabel = await tryClickChatOption(page, replyText, brandCfg.selectors.input);
      if (clickedLabel) {
        sentByUs.add(clickedLabel);
        sentByUs.add(replyText);
        pathSteps.push(`${senderRole === 'operator' ? 'Manual' : 'AI'} clicked "${clickedLabel}"`);
        pushTranscript(senderRole, `[Clicked] ${clickedLabel}`);
        if (!firstMessageSentAt) firstMessageSentAt = Date.now();
        if (senderRole === 'operator') pendingManualNotes.push(`Clicked "${clickedLabel}"`);
        await page.waitForTimeout(1500);
        await captureFrame();
        return true;
      }

      // 2. Otherwise type into the chat input ONLY if it is enabled (never crash on disabled textarea)
      const found = await findInputWithFrame(page, brandCfg.selectors.input);
      const enabled = found ? await found.locator.isEnabled({ timeout: 500 }).catch(() => false) : false;

      if (!found || !enabled) {
        const opts = (await getChatOptionButtons(page, brandCfg.selectors.input)).map((o) => o.text);
        pushTranscript(
          'system',
          `Text box is currently disabled — must click an on-screen option first.${
            opts.length ? ` Available: ${opts.join(' | ')}` : ''
          }`
        );
        return false;
      }

      try {
        await found.locator.fill(replyText, { timeout: 5000 });
        await found.locator.press('Enter').catch(async () => {
          const sendBtn = await findInFrames(page, brandCfg.selectors.send);
          if (sendBtn) await sendBtn.click({ timeout: 3000 }).catch(() => {});
        });
        sentByUs.add(replyText);
        pushTranscript(senderRole, replyText);
        if (!firstMessageSentAt) firstMessageSentAt = Date.now();
        if (senderRole === 'operator') pendingManualNotes.push(replyText);
        await page.waitForTimeout(1000);
        await captureFrame();
        return true;
      } catch (fillErr) {
        pushTranscript('system', `Could not type message (${fillErr.message.split('\n')[0]})`);
        return false;
      }
    });
  };

  onRegisterController?.({
    setAiPaused: (paused) => {
      chat.aiPaused = Boolean(paused);
      pushTranscript(
        'system',
        chat.aiPaused
          ? 'Human Takeover active — Vapi AI disengaged.'
          : 'Vapi AI re-engaged.'
      );
      onUpdate();
    },
    sendManualMessage: async (text) => {
      const clean = String(text || '').trim();
      if (!clean) return false;
      return sendToCarrier(clean, 'operator');
    },
    clickAtRatio: async (xRatio, yRatio) => {
      if (!page) return false;
      return enqueueAction(async () => {
        const vp = page.viewportSize() || { width: 1280, height: 800 };
        const x = Math.max(1, Math.min(vp.width - 1, Math.round(xRatio * vp.width)));
        const y = Math.max(1, Math.min(vp.height - 1, Math.round(yRatio * vp.height)));
        await page.mouse.click(x, y);
        pushTranscript('system', `Manual click at (${x}, ${y})`);
        await page.waitForTimeout(1200);
        await captureFrame();
        return true;
      });
    }
  });

  try {
    chat.status = 'in-progress';
    onUpdate();

    let vapi = null;
    try {
      vapi = await createVapiSession(s);
      if (vapi) {
        pushTranscript('system', `Vapi Chat Session started (${vapi.sessionId})`);
      } else {
        chat.aiPaused = true;
        pushTranscript('system', 'VAPI_API_KEY / VAPI_ASSISTANT_ID not set — running in Manual Mode.');
        onUpdate();
      }
    } catch (vErr) {
      chat.aiPaused = true;
      pushTranscript('system', `Vapi init failed (${vErr.message}) — switched to Manual Mode.`);
      onUpdate();
    }

    browser = await chromium.connectOverCDP(endpoint, { timeout: 25000 });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: /^fr/i.test(s.language) ? 'fr-CA' : 'en-CA',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    });
    page = await context.newPage();

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

    // Click launcher (Need Help? / bottom-right yellow icon)
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
      pushTranscript(
        'system',
        'No launcher detected — you can click directly on the live screenshot to open chat.'
      );
    }

    s.systemUsed = await detectChatSystem(page);
    onUpdate();

    let turns = 0;
    let botReplied = false;
    let agentConnected = false;

    const initialInput = await waitForInFrames(page, brandCfg.selectors.input, 8000);
    if (!initialInput) {
      pushTranscript(
        'system',
        'Chat widget not detected yet — click the screenshot or Take Over to navigate manually.'
      );
    }

    const buildVapiPrompt = ({ header, msgs, btns, inputEnabled, manualNote }) => {
      const lines = [];
      if (header) lines.push(header);
      if (manualNote) lines.push(manualNote);
      if (msgs.length) lines.push(`Carrier said: ${msgs.join(' | ')}`);
      if (btns.length) {
        lines.push(`On-screen buttons: ${btns.map((b) => `"${b}"`).join(', ')}`);
      }
      if (!inputEnabled && btns.length) {
        lines.push(
          'IMPORTANT: The text input is DISABLED until you click one of the on-screen buttons above. Reply with ONLY the exact text of the single button you want to click (do not write a sentence).'
        );
      } else if (btns.length) {
        lines.push(
          'Reply with either the exact text of one of the buttons above OR a short message to type.'
        );
      }
      return lines.join('\n');
    };

    while (!shouldStop()) {
      const elapsed = Date.now() - startedAt;
      const limit = chat.aiPaused ? manualMaxDurationMs : aiMaxDurationMs;
      if (elapsed >= limit) break;

      if (!chat.aiPaused && turns >= maxVapiTurns) {
        pushTranscript('system', 'Max AI turns reached — switching to Human Takeover.');
        chat.aiPaused = true;
        onUpdate();
      }

      const currentMessages = await scrapeMessages(
        page,
        brandCfg.selectors.messages,
        brandCfg.selectors.input
      );
      const currentButtons = (await getChatOptionButtons(page, brandCfg.selectors.input)).map(
        (o) => o.text
      );
      const inputEnabled = await isChatInputEnabled(page, brandCfg.selectors.input);
      const buttonsKey = currentButtons.join('||');

      const freshBatch = [];
      for (const msg of currentMessages) {
        if (seenMessages.has(msg) || sentByUs.has(msg)) continue;
        // Skip duplicating pure button text as a chat bubble if it matches a current button
        if (currentButtons.includes(msg)) {
          seenMessages.add(msg);
          continue;
        }
        seenMessages.add(msg);
        freshBatch.push(msg);

        if (!botReplied && firstMessageSentAt) {
          botReplied = true;
          const botSec = Math.round((Date.now() - firstMessageSentAt) / 1000);
          s.botResponseSec = botSec;
          if (!s.waitTimes || s.waitTimes === '—') s.waitTimes = `Bot: ${botSec}s`;
        }

        const waitMatch = msg.match(WAIT_TIME_REGEX);
        if (waitMatch) s.waitTimes = waitMatch[1];

        const hoopsMatch = msg.match(HOOPS_REGEX);
        if (hoopsMatch && !s.hoops) s.hoops = hoopsMatch[1];

        pushTranscript('user', msg);

        if (!agentConnected && AGENT_JOIN_REGEX.test(msg)) {
          const ttaSec = Math.round((Date.now() - (firstMessageSentAt || startedAt)) / 1000);
          s.timeToAgent = `${ttaSec}s`;
          agentConnected = true;
          pathSteps.push(`Live agent joined in ${ttaSec}s`);
          s.cxToAgent = `Live agent connected in ${ttaSec}s via ${s.systemUsed}.`;
          onUpdate();
        }
      }

      const buttonsChanged = Boolean(buttonsKey && buttonsKey !== lastButtonsKey);
      if (buttonsChanged) {
        lastButtonsKey = buttonsKey;
        pushTranscript('system', `Detected options: ${currentButtons.join(' | ')}`);
      }

      if (agentConnected && !chat.aiPaused) break;

      const chatIsReady = inputEnabled || currentButtons.length > 0;
      const shouldAskVapi =
        vapi &&
        !chat.aiPaused &&
        chatIsReady &&
        (!vapiStarted || freshBatch.length > 0 || buttonsChanged);

      if (shouldAskVapi) {
        const manualNote = pendingManualNotes.length
          ? `Note: Human operator manually did earlier: ${pendingManualNotes.splice(0).join(' | ')}`
          : '';

        const prompt = buildVapiPrompt({
          header: !vapiStarted
            ? `Chat opened on ${s.brand} (${s.segment} - ${s.useCase} - ${s.language}).`
            : '',
          msgs: freshBatch,
          btns: currentButtons,
          inputEnabled,
          manualNote
        });

        vapiStarted = true;
        const vapiReply = await askVapiChat(vapi.sessionId, prompt);

        if (!chat.aiPaused && vapiReply) {
          if (/\[END_CHAT\]/i.test(vapiReply)) {
            pathSteps.push('Vapi ended chat');
            pushTranscript('system', 'Vapi assistant signaled end of chat.');
            break;
          }
          const ok = await sendToCarrier(vapiReply, 'assistant');
          if (ok) turns++;
        }
      }

      await page.waitForTimeout(2500);
    }

    if (!agentConnected && !s.cxToAgent) {
      s.cxToAgent = shouldStop()
        ? 'Session ended manually.'
        : 'Timed out waiting for live agent.';
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
