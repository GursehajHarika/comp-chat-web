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

  // Forward optional Canadian proxy to Browserless launch args if configured
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  if (proxyUrl && !endpoint.includes('--proxy-server=')) {
    endpoint +=
      (endpoint.includes('?') ? '&' : '?') +
      `--proxy-server=${encodeURIComponent(proxyUrl)}`;
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
  /(connected with|you are now chatting with|my name is|agent has joined|specialist has joined|representative has joined|vous clavardez maintenant avec|je m'appelle|un agent s'est joint)/i;
const WAIT_TIME_REGEX =
  /(\b\d+\s*(?:to|-)\s*\d+\s*min(?:ute)?s?\b|\b\d+\s*min(?:ute)?s?\b|position\s*#?\d+|\b\d+\s*in\s*queue\b)/i;
const HOOPS_REGEX =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h)\s*(?:to|-|–|à)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h))/i;

const IGNORED_BUTTON_REGEX =
  /^(close|minimize|minimise|maximize|end chat|end|send|envoyer|fermer|réduire|feedback|help|need help\??|ask anna|menu|back|x|×|privacy|terms|accessibility|clear|reset|download transcript|save transcript|update browser|ignore)$/i;

const IGNORED_MESSAGE_REGEX =
  /^(\d{1,2}:\d{2}(\s?[ap]m)?|just now|today|yesterday|delivered|sent|read|typing\.{0,3}|loading\.{0,3}|ask anna|live chat|rogers|videotron|vidéotron|virtual assistant|assistant virtuel|type your message|send|envoyer|undefined|\d+\/\d+|powered by .+)$/i;

const CHAT_API_URL_REGEX =
  /(chat|va\.|genesys|mypurecloud|nuance|liveperson|lpsnmedia|touchcommerce|kore|cognigy|bot|conversation|agent|rogers\.com\/api|videotron\.com\/api)/i;

async function findInFrames(page, selector) {
  for (const frame of page.frames()) {
    try {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible({ timeout: 600 })) return loc;
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

async function inspectChatState(page, inputSelector) {
  let best = {
    found: false,
    frame: null,
    inputFound: false,
    inputEnabled: false,
    inputCoords: null,
    isTyping: false,
    buttons: [],
    messages: [],
    score: -1
  };

  for (const frame of page.frames()) {
    const isMain = frame === page.mainFrame();
    try {
      const data = await frame.evaluate(
        ({ sel, isMainFrame }) => {
          const isVisible = (el) => {
            if (!el || el.nodeType !== 1) return false;
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              Number(style.opacity) === 0
            ) {
              return false;
            }
            // Exclude screen-reader-only / visually-hidden accessibility containers
            const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
            if (/(sr-only|visually-hidden|cdk-visually-hidden|screen-reader)/.test(cls)) {
              return false;
            }
            if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') {
              return false;
            }
            const r = el.getBoundingClientRect();
            return r.width > 4 && r.height > 4;
          };

          const collectDeep = (root) => {
            const list = [];
            const stack = [root];
            while (stack.length) {
              const node = stack.pop();
              if (!node) continue;
              if (node.nodeType === 1) list.push(node);
              if (node.shadowRoot) stack.push(node.shadowRoot);
              const children = node.children || [];
              for (let i = children.length - 1; i >= 0; i--) {
                stack.push(children[i]);
              }
            }
            return list;
          };

          const allInDoc = collectDeep(document.body);
          const findInputEl = (els) => {
            for (const el of els) {
              const tag = el.tagName;
              const matches =
                tag === 'TEXTAREA' ||
                (tag === 'INPUT' &&
                  ['text', 'search', 'email', 'tel'].includes((el.type || 'text').toLowerCase())) ||
                el.getAttribute('contenteditable') === 'true' ||
                (sel &&
                  el.matches &&
                  (() => {
                    try {
                      return el.matches(sel);
                    } catch (_) {
                      return false;
                    }
                  })());

              if (matches && isVisible(el)) {
                if (isMainFrame) {
                  const r = el.getBoundingClientRect();
                  const ph = (el.placeholder || el.getAttribute('aria-label') || '').toLowerCase();
                  if (ph.includes('search') && !ph.includes('message') && r.top < 200) continue;
                }
                return el;
              }
            }
            return null;
          };

          let inputEl = findInputEl(allInDoc);
          let root = null;

          if (!isMainFrame) {
            const frameRect = document.body.getBoundingClientRect();
            if (inputEl || (frameRect.width >= 240 && frameRect.height >= 240)) {
              root = document.body;
            }
          } else if (inputEl) {
            let cur = inputEl;
            let bestPanel = inputEl.parentElement;
            while (cur && cur !== document.body) {
              const parent =
                cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
              if (!parent || parent === document.body) break;
              const r = parent.getBoundingClientRect();
              if (r.width >= 260 && r.width <= 680 && r.height >= 250) {
                bestPanel = parent;
              }
              cur = parent;
            }
            root = bestPanel;
          } else {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            for (const el of allInDoc) {
              if (!isVisible(el)) continue;
              const style = window.getComputedStyle(el);
              if (style.position !== 'fixed') continue;
              const r = el.getBoundingClientRect();
              if (
                r.width >= 280 &&
                r.width <= 650 &&
                r.height >= 320 &&
                r.right >= vw - 60 &&
                r.bottom >= vh - 80
              ) {
                root = el;
                break;
              }
            }
          }

          if (!root) return { found: false };

          const panelEls = collectDeep(root);

          for (const el of panelEls) {
            if (el.scrollHeight > el.clientHeight + 24) {
              const ov = window.getComputedStyle(el).overflowY;
              if (ov === 'auto' || ov === 'scroll') {
                el.scrollTop = el.scrollHeight;
              }
            }
          }

          if (!inputEl) inputEl = findInputEl(panelEls);
          let inputEnabled = false;
          let inputCoords = null;
          if (inputEl) {
            const r = inputEl.getBoundingClientRect();
            inputCoords = {
              cx: Math.round(r.left + r.width / 2),
              cy: Math.round(r.top + r.height / 2)
            };
            inputEnabled =
              !inputEl.disabled &&
              !inputEl.readOnly &&
              !inputEl.classList.contains('disabled') &&
              inputEl.getAttribute('aria-disabled') !== 'true';
          }

          let isTyping = false;
          for (const el of panelEls) {
            if (!isVisible(el)) continue;
            const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            if (
              /(typing|spinner|loader|loading-dots|dot-flashing|thinking|is-typing)/.test(cls) ||
              /(typing|loading|connecting)/.test(aria) ||
              role === 'progressbar'
            ) {
              isTyping = true;
              break;
            }
          }

          const buttons = [];
          const seenBtn = new Set();
          const buttonEls = new Set();

          for (const el of panelEls) {
            if (!isVisible(el) || el.disabled) continue;
            const style = window.getComputedStyle(el);
            const tag = el.tagName;
            const isExplicit =
              tag === 'BUTTON' ||
              tag === 'A' ||
              el.getAttribute('role') === 'button' ||
              el.hasAttribute('tabindex');
            const isPointer = style.cursor === 'pointer';

            if (!isExplicit && !isPointer) continue;
            if (!isExplicit && el.querySelector('button, a, [role="button"], input, textarea')) {
              continue;
            }

            const r = el.getBoundingClientRect();
            if (r.width < 24 || r.width > 480 || r.height < 18 || r.height > 96) continue;

            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length < 2 || text.length > 90) continue;

            buttonEls.add(el);
            if (!seenBtn.has(text)) {
              seenBtn.add(text);
              buttons.push({
                text,
                cx: Math.round(r.left + r.width / 2),
                cy: Math.round(r.top + r.height / 2)
              });
            }
          }

          const isExcludedAncestor = (el) => {
            let cur = el;
            while (cur && cur !== root) {
              if (
                buttonEls.has(cur) ||
                ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'HEADER', 'FOOTER', 'NAV', 'SCRIPT', 'STYLE'].includes(cur.tagName) ||
                cur.getAttribute?.('role') === 'button' ||
                cur.getAttribute?.('aria-live')
              ) {
                return true;
              }
              cur = cur.parentElement;
            }
            return false;
          };

          const rawMessages = [];
          const rootRect = root.getBoundingClientRect();

          for (const el of panelEls) {
            if (!isVisible(el)) continue;
            if (isExcludedAncestor(el)) continue;

            const r = el.getBoundingClientRect();
            if (r.bottom <= rootRect.top + 46) continue;
            if (r.top >= rootRect.bottom - 52) continue;

            // Skip containers that hold nested block/interactive elements or multiple paragraphs
            let hasNestedBlock = false;
            for (const child of el.children || []) {
              if (!isVisible(child)) continue;
              const cTag = child.tagName;
              const cText = (child.innerText || '').trim();
              if (
                cText.length > 0 &&
                ['DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'BUTTON', 'A', 'FORM', 'SPAN'].includes(cTag) &&
                el.children.length > 1
              ) {
                hasNestedBlock = true;
                break;
              }
              if (
                cText.length > 0 &&
                ['DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'BUTTON', 'A', 'FORM'].includes(cTag)
              ) {
                hasNestedBlock = true;
                break;
              }
            }
            if (hasNestedBlock) continue;

            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length < 3 || text.length > 800) continue;
            if (/^live chat\b/i.test(text)) continue;

            const relLeft = r.left - rootRect.left;
            const relRight = rootRect.right - r.right;
            const looksOutgoing = relLeft > rootRect.width * 0.32 && relRight < 55;

            rawMessages.push({ text, looksOutgoing });
          }

          const messages = [];
          const seenMsg = new Set();
          for (const item of rawMessages) {
            if (seenMsg.has(item.text)) continue;
            seenMsg.add(item.text);
            messages.push(item);
          }

          return {
            found: true,
            inputFound: Boolean(inputEl),
            inputEnabled,
            inputCoords,
            isTyping,
            buttons,
            messages
          };
        },
        { sel: inputSelector, isMainFrame: isMain }
      );

      if (!data || !data.found) continue;

      const filteredButtons = (data.buttons || []).filter(
        (b) => !IGNORED_BUTTON_REGEX.test(b.text)
      );
      const buttonTextSet = new Set(filteredButtons.map((b) => b.text.toLowerCase()));

      const filteredMessages = (data.messages || []).filter((m) => {
        if (IGNORED_MESSAGE_REGEX.test(m.text)) return false;
        if (buttonTextSet.has(m.text.toLowerCase())) return false;
        return true;
      });

      const score =
        (data.inputFound ? 10 : 0) +
        (data.inputEnabled ? 5 : 0) +
        filteredButtons.length * 3 +
        filteredMessages.length * 2 +
        (isMain ? 0 : 4);

      if (score > best.score) {
        best = {
          found: true,
          frame,
          inputFound: data.inputFound,
          inputEnabled: data.inputEnabled,
          inputCoords: data.inputCoords,
          isTyping: data.isTyping,
          buttons: filteredButtons,
          messages: filteredMessages,
          score
        };
      }
    } catch (_) {}
  }

  return best;
}

async function clickCoordsInFrame(page, frame, cx, cy) {
  const frameEl = await frame.frameElement().catch(() => null);
  if (frameEl) {
    const box = await frameEl.boundingBox();
    if (box) {
      await page.mouse.click(box.x + cx, box.y + cy);
      return true;
    }
  }
  await page.mouse.click(cx, cy);
  return true;
}

async function clickOptionButton(page, state, replyText) {
  const cleanReply = String(replyText || '')
    .replace(/^["'`[\]()]+|["'`[\]()]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanReply || !state.buttons.length) return null;

  const targetLower = cleanReply.toLowerCase();

  let match = state.buttons.find((o) => o.text.toLowerCase() === targetLower);
  if (!match) {
    match = state.buttons.find(
      (o) =>
        o.text.toLowerCase().includes(targetLower) ||
        targetLower.includes(o.text.toLowerCase())
    );
  }
  if (!match) return null;

  try {
    const loc = state.frame.getByText(match.text, { exact: true }).first();
    if (await loc.isVisible({ timeout: 1000 })) {
      await loc.click({ timeout: 4000 });
      return match.text;
    }
  } catch (_) {}

  try {
    await clickCoordsInFrame(page, state.frame, match.cx, match.cy);
    return match.text;
  } catch (_) {}

  return null;
}

async function typeMessageInState(page, state, inputSelector, sendSelector, text) {
  if (!state.frame || !state.inputEnabled) return false;

  try {
    const loc = state.frame.locator(inputSelector).first();
    if ((await loc.isVisible({ timeout: 800 })) && (await loc.isEnabled({ timeout: 500 }))) {
      await loc.click({ timeout: 2000 }).catch(() => {});
      await loc.fill(text, { timeout: 4000 });
      await loc.press('Enter').catch(async () => {
        const sendBtn = state.frame.locator(sendSelector).first();
        if (await sendBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await sendBtn.click({ timeout: 2000 }).catch(() => {});
        }
      });
      return true;
    }
  } catch (_) {}

  if (state.inputCoords) {
    try {
      await clickCoordsInFrame(page, state.frame, state.inputCoords.cx, state.inputCoords.cy);
      await page.waitForTimeout(200);
      await page.keyboard.type(text, { delay: 15 });
      await page.keyboard.press('Enter');
      return true;
    } catch (_) {}
  }

  return false;
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

function normalizeForCompare(str) {
  return String(str || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function runChatSession(
  chat,
  { onUpdate, onTranscript, onComplete, onRegisterController, shouldStop }
) {
  const s = chat.structuredOutputs;
  const brandCfg = BRANDS[s.brand] || BRANDS.Rogers;
  const endpoint = getBrowserEndpoint();
  const aiMaxDurationMs = Number(process.env.MAX_CHAT_DURATION_SEC || 300) * 1000;
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

  const seenNormalized = new Set();
  const sentByUsNormalized = new Set();
  const loggedNetErrors = new Set();
  const pendingManualNotes = [];
  let firstActionAt = null;
  let lastActionAt = 0;
  let waitingForBrandReply = false;
  let agentConnected = false;
  let botReplied = false;
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

  const executeReply = async (replyText, senderRole = 'assistant') => {
    if (!page || !replyText) return { ok: false, reason: 'empty' };
    return enqueueAction(async () => {
      const state = await inspectChatState(page, brandCfg.selectors.input);

      const clickedLabel = await clickOptionButton(page, state, replyText);
      if (clickedLabel) {
        sentByUsNormalized.add(normalizeForCompare(clickedLabel));
        sentByUsNormalized.add(normalizeForCompare(replyText));
        pathSteps.push(`${senderRole === 'operator' ? 'Manual' : 'AI'} clicked "${clickedLabel}"`);
        pushTranscript(senderRole, `[Clicked] ${clickedLabel}`);
        if (!firstActionAt) firstActionAt = Date.now();
        lastActionAt = Date.now();
        waitingForBrandReply = true;
        if (senderRole === 'operator') pendingManualNotes.push(`Clicked "${clickedLabel}"`);
        await page.waitForTimeout(1200);
        await captureFrame();
        return { ok: true, mode: 'button', label: clickedLabel };
      }

      if (!state.inputEnabled) {
        return {
          ok: false,
          reason: 'input_disabled',
          buttons: state.buttons.map((b) => b.text)
        };
      }

      const typed = await typeMessageInState(
        page,
        state,
        brandCfg.selectors.input,
        brandCfg.selectors.send,
        replyText
      );
      if (!typed) return { ok: false, reason: 'type_failed' };

      sentByUsNormalized.add(normalizeForCompare(replyText));
      pushTranscript(senderRole, replyText);
      if (!firstActionAt) firstActionAt = Date.now();
      lastActionAt = Date.now();
      waitingForBrandReply = true;
      if (senderRole === 'operator') pendingManualNotes.push(replyText);
      await page.waitForTimeout(1000);
      await captureFrame();
      return { ok: true, mode: 'typed' };
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
      const res = await executeReply(clean, 'operator');
      if (!res.ok && res.reason === 'input_disabled') {
        pushTranscript(
          'system',
          `Input is disabled — click an option or type its exact label.${
            res.buttons?.length ? ` Available: ${res.buttons.join(' | ')}` : ''
          }`
        );
      }
      return res.ok;
    },
    clickAtRatio: async (xRatio, yRatio) => {
      if (!page) return false;
      return enqueueAction(async () => {
        const vp = page.viewportSize() || { width: 1280, height: 800 };
        const x = Math.max(1, Math.min(vp.width - 1, Math.round(xRatio * vp.width)));
        const y = Math.max(1, Math.min(vp.height - 1, Math.round(yRatio * vp.height)));
        await page.mouse.click(x, y);
        lastActionAt = Date.now();
        waitingForBrandReply = true;
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

    // Match the real Chromium version installed in Browserless (avoids Chrome 128 warning & Akamai UA mismatch)
    const rawVer = browser.version() || '140.0.0.0';
    const chromeVer = rawVer.replace(/^[^0-9]*/, '') || '140.0.0.0';
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      locale: /^fr/i.test(s.language) ? 'fr-CA' : 'en-CA',
      timezoneId: 'America/Toronto',
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`
    };

    if (process.env.PROXY_URL) {
      contextOptions.proxy = { server: process.env.PROXY_URL };
      if (process.env.PROXY_USERNAME) contextOptions.proxy.username = process.env.PROXY_USERNAME;
      if (process.env.PROXY_PASSWORD) contextOptions.proxy.password = process.env.PROXY_PASSWORD;
    }

    context = await browser.newContext(contextOptions);

    // Mask automation flag so WAFs don't reject chat API calls
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en-US', 'en'] });
    });

    page = await context.newPage();

    // Surface failed chat API responses (e.g. 403 WAF or geo-block) directly in Live Feed
    page.on('response', (res) => {
      const status = res.status();
      const url = res.url();
      if (status >= 400 && CHAT_API_URL_REGEX.test(url)) {
        const shortUrl = url.split('?')[0].slice(0, 110);
        const key = `${status}:${shortUrl}`;
        if (!loggedNetErrors.has(key)) {
          loggedNetErrors.add(key);
          pushTranscript('system', `Chat API HTTP ${status} on ${shortUrl}`);
        }
      }
    });

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
      await page.waitForTimeout(3500);
      await captureFrame();
    } else if (await clickBottomRightLauncher(page)) {
      pathSteps.push('Clicked bottom-right floating launcher');
      pushTranscript('system', 'Clicked bottom-right floating chat launcher');
      await page.waitForTimeout(3500);
      await captureFrame();
    } else {
      pathSteps.push('Launcher not detected');
      pushTranscript(
        'system',
        'No launcher detected — click directly on the live screenshot to open chat.'
      );
    }

    s.systemUsed = await detectChatSystem(page);
    onUpdate();

    let turns = 0;
    let vapiStarted = false;
    let lastButtonsKey = '';
    let prevInputEnabled = false;
    let prevFingerprint = '';
    let stableChecks = 0;
    let pendingFreshMessages = [];
    let pendingStateTrigger = false;

    const buildVapiPrompt = ({ header, msgs, btns, inputEnabled, manualNote, strictButtonsOnly }) => {
      const lines = [];
      if (header) lines.push(header);
      if (manualNote) lines.push(manualNote);
      if (msgs.length) lines.push(`Carrier assistant said: ${msgs.join(' | ')}`);
      if (btns.length) {
        lines.push(`Available on-screen buttons: ${btns.map((b) => `"${b}"`).join(', ')}`);
      }
      if (strictButtonsOnly || (!inputEnabled && btns.length)) {
        lines.push(
          'CRITICAL: The chat text input is DISABLED. You MUST reply with ONLY the exact label of one button from the list above (no extra words, no quotes).'
        );
      } else if (inputEnabled && btns.length) {
        lines.push(
          'The text input is enabled and buttons are shown. Reply with either the exact button label to click OR a short message to type.'
        );
      } else if (inputEnabled) {
        lines.push(
          'The text input is now enabled with no buttons. Reply with a short message to type into the chat box.'
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

      const state = await inspectChatState(page, brandCfg.selectors.input);
      const buttonLabels = state.buttons.map((b) => b.text);
      const buttonsKey = buttonLabels.join('||');

      for (const m of state.messages) {
        const norm = normalizeForCompare(m.text);
        if (!norm || seenNormalized.has(norm) || sentByUsNormalized.has(norm)) continue;

        let isMutationOfSeen = false;
        for (const prev of seenNormalized) {
          if (norm.includes(prev) && norm.length < prev.length + 65) {
            isMutationOfSeen = true;
            break;
          }
        }
        seenNormalized.add(norm);
        if (isMutationOfSeen || m.looksOutgoing) continue;

        pendingFreshMessages.push(m.text);
        waitingForBrandReply = false;

        if (!botReplied && firstActionAt) {
          botReplied = true;
          const botSec = Math.round((Date.now() - firstActionAt) / 1000);
          s.botResponseSec = botSec;
          if (!s.waitTimes || s.waitTimes === '—') s.waitTimes = `Bot: ${botSec}s`;
        }

        const waitMatch = m.text.match(WAIT_TIME_REGEX);
        if (waitMatch) s.waitTimes = waitMatch[1];

        const hoopsMatch = m.text.match(HOOPS_REGEX);
        if (hoopsMatch && !s.hoops) s.hoops = hoopsMatch[1];

        pushTranscript('user', m.text);

        if (!agentConnected && AGENT_JOIN_REGEX.test(m.text)) {
          const ttaSec = Math.round((Date.now() - (firstActionAt || startedAt)) / 1000);
          s.timeToAgent = `${ttaSec}s`;
          agentConnected = true;
          pathSteps.push(`Live agent joined in ${ttaSec}s`);
          s.cxToAgent = `Live agent connected in ${ttaSec}s via ${s.systemUsed}.`;
          onUpdate();
        }
      }

      if (buttonsKey && buttonsKey !== lastButtonsKey) {
        lastButtonsKey = buttonsKey;
        waitingForBrandReply = false;
        pendingStateTrigger = true;
        pushTranscript('system', `Detected options: ${buttonLabels.join(' | ')}`);
      }

      if (state.inputEnabled && !prevInputEnabled) {
        waitingForBrandReply = false;
        pendingStateTrigger = true;
        pushTranscript('system', 'Chat text input is now enabled.');
      }
      prevInputEnabled = state.inputEnabled;

      if (agentConnected && !chat.aiPaused) break;

      const fingerprint = `${state.messages.map((m) => m.text).join('|')}##${buttonsKey}##${state.inputEnabled}`;
      if (state.isTyping || fingerprint !== prevFingerprint) {
        prevFingerprint = fingerprint;
        stableChecks = 0;
        await page.waitForTimeout(1500);
        continue;
      }
      stableChecks++;

      if (stableChecks < 2) {
        await page.waitForTimeout(1500);
        continue;
      }

      const msSinceAction = Date.now() - lastActionAt;
      if (waitingForBrandReply && msSinceAction < 20000) {
        await page.waitForTimeout(1500);
        continue;
      }
      if (waitingForBrandReply && msSinceAction >= 20000) {
        waitingForBrandReply = false;
        if (state.inputEnabled || buttonLabels.length > 0) {
          pendingStateTrigger = true;
        }
      }

      const canAct = state.inputEnabled || buttonLabels.length > 0;
      const hasWorkForVapi =
        !vapiStarted || pendingFreshMessages.length > 0 || pendingStateTrigger;

      if (vapi && !chat.aiPaused && canAct && hasWorkForVapi) {
        const msgsToSend = pendingFreshMessages.splice(0);
        pendingStateTrigger = false;

        const manualNote = pendingManualNotes.length
          ? `Note: Human operator manually did earlier: ${pendingManualNotes.splice(0).join(' | ')}`
          : '';

        const prompt = buildVapiPrompt({
          header: !vapiStarted
            ? `Chat opened on ${s.brand} (${s.segment} - ${s.useCase} - ${s.language}).`
            : '',
          msgs: msgsToSend,
          btns: buttonLabels,
          inputEnabled: state.inputEnabled,
          manualNote,
          strictButtonsOnly: false
        });

        vapiStarted = true;
        let vapiReply = await askVapiChat(vapi.sessionId, prompt);

        if (!chat.aiPaused && vapiReply) {
          if (/\[END_CHAT\]/i.test(vapiReply)) {
            pathSteps.push('Vapi ended chat');
            pushTranscript('system', 'Vapi assistant signaled end of chat.');
            break;
          }

          let execRes = await executeReply(vapiReply, 'assistant');

          if (!execRes.ok && execRes.reason === 'input_disabled' && execRes.buttons?.length) {
            const retryPrompt = buildVapiPrompt({
              header: 'Your previous reply could not be typed because the text input is disabled.',
              msgs: [],
              btns: execRes.buttons,
              inputEnabled: false,
              strictButtonsOnly: true
            });
            vapiReply = await askVapiChat(vapi.sessionId, retryPrompt);
            if (!chat.aiPaused && vapiReply) {
              execRes = await executeReply(vapiReply, 'assistant');
            }
          }

          if (execRes.ok) {
            turns++;
            stableChecks = 0;
            prevFingerprint = '';
          }
        }
      }

      await page.waitForTimeout(1500);
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
