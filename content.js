(() => {
  const state = {
    running: false,
    data: [],
    keys: new Set(),
    lastError: null,
    progressCount: 0
  };

  const SCROLL_CONFIG = {
    maxStagnantScrolls: 8,
    maxTotalScrolls: 200,
    scrollDelayMs: 900,
    loadWaitMs: 1100,
    minNewItemsToContinue: 1
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const safeSendMessage = (payload) => {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (err) {
      console.debug("[Maps Scraper] Popup not listening for messages.", err);
    }
  };

  const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();

  const parseNumber = (text) => {
    if (!text) return "";
    const digits = text.replace(/[^\d.,]/g, "").replace(/,(?=\d{3}\b)/g, "");
    return digits || "";
  };

  const getMapsResultContainer = () => {
    const selectors = [
      'div[role="feed"]',
      'div[aria-label][role="main"] div[role="feed"]',
      'div.m6QErb[aria-label]',
      'div.m6QErb.DxyBCb'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.scrollHeight > el.clientHeight) {
        return el;
      }
    }

    const allScrollable = Array.from(document.querySelectorAll('div[role="feed"], div.m6QErb'))
      .filter((el) => el.scrollHeight > el.clientHeight)
      .sort((a, b) => b.scrollHeight - a.scrollHeight);

    return allScrollable[0] || null;
  };

  const getListingCards = (container) => {
    if (!container) return [];

    const cards = new Set();

    container.querySelectorAll('div.Nv2PK, div[role="article"], div[jsaction*="mouseover:pane"]')
      .forEach((el) => cards.add(el));

    container.querySelectorAll('a[href*="/maps/place/"]').forEach((anchor) => {
      const card = anchor.closest('div.Nv2PK, div[role="article"], div[jsaction*="mouseover:pane"]');
      if (card) cards.add(card);
    });

    return Array.from(cards);
  };

  const extractFromCard = (card) => {
    if (!card) return null;

    const linkEl = card.querySelector('a[href*="/maps/place/"], a.hfpxzc');
    const rawLink = linkEl?.href || "";
    const mapsLink = rawLink ? new URL(rawLink, window.location.origin).href : "";

    const titleEl =
      card.querySelector('div.qBF1Pd, div.fontHeadlineSmall, span[role="heading"]') ||
      linkEl;

    const businessName = normalizeText(
      titleEl?.textContent || titleEl?.getAttribute("aria-label") || ""
    );

    const ratingEl =
      card.querySelector('span[aria-label*="star" i], div[role="img"][aria-label*="star" i]') ||
      null;
    const ratingText = ratingEl?.getAttribute("aria-label") || ratingEl?.textContent || "";
    const ratingMatch = ratingText.match(/\d+(?:[.,]\d+)?/);
    const rating = ratingMatch ? ratingMatch[0].replace(",", ".") : "";

    const reviewsNode = Array.from(card.querySelectorAll("span, button, div"))
      .find((el) => /reviews?/i.test(el.getAttribute("aria-label") || el.textContent || ""));
    const numberOfReviews = parseNumber(reviewsNode?.getAttribute("aria-label") || reviewsNode?.textContent || "");

    const infoBlock =
      card.querySelector('div.W4Efsd, div.UaQhfb, div.ah5Ghc') ||
      null;
    const infoText = normalizeText(infoBlock?.textContent || "");

    let category = "";
    let address = "";

    if (infoText) {
      const chunks = infoText
        .split("·")
        .map((x) => normalizeText(x))
        .filter(Boolean);

      if (chunks.length > 0) category = chunks[0];

      address = chunks.find((chunk) =>
        /\d|street|st\b|road|rd\b|avenue|ave\b|boulevard|blvd\b|lane|ln\b|drive|dr\b|way\b|plaza|square|suite|#|floor|fl\b/i.test(chunk)
      ) || "";

      if (!address && chunks.length > 1) {
        address = chunks[1];
      }
    }

    const textBlob = normalizeText(card.textContent || "");
    const phoneMatch = textBlob.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
    const phone = phoneMatch ? normalizeText(phoneMatch[0]) : "";

    const websiteEl = Array.from(card.querySelectorAll('a[href^="http"]')).find((a) => {
      const href = a.getAttribute("href") || "";
      return !href.includes("google.com/maps") && !href.includes("google.com/search") && !href.startsWith("tel:");
    });
    const website = websiteEl?.href || "";

    if (!businessName && !mapsLink) {
      return null;
    }

    return {
      businessName,
      rating,
      numberOfReviews,
      category,
      address,
      phone,
      website,
      googleMapsLink: mapsLink
    };
  };

  const buildKey = (item) => `${(item.businessName || "").toLowerCase()}|${(item.address || "").toLowerCase()}`;

  const addUniqueItems = (items) => {
    let added = 0;

    for (const item of items) {
      if (!item) continue;

      const key = buildKey(item);
      if (!key || state.keys.has(key)) continue;

      state.keys.add(key);
      state.data.push(item);
      added += 1;
    }

    state.progressCount = state.data.length;
    return added;
  };

  const scrapeVisibleListings = () => {
    const container = getMapsResultContainer();
    const cards = getListingCards(container);
    const extracted = cards.map(extractFromCard).filter(Boolean);
    const addedNow = addUniqueItems(extracted);

    console.log(`[Maps Scraper] Visible cards: ${cards.length}, extracted: ${extracted.length}, total unique: ${state.data.length}`);

    safeSendMessage({
      type: "SCRAPE_PROGRESS",
      payload: {
        count: state.data.length,
        visibleCards: cards.length,
        newlyAdded: addedNow
      }
    });

    return { container, visibleCount: cards.length, addedNow };
  };

  const runScrollingScrape = async () => {
    const firstPass = scrapeVisibleListings();
    const container = firstPass.container;

    if (!container) {
      throw new Error("Could not find Google Maps results container. Make sure a search results page is open.");
    }

    let stagnantScrolls = 0;
    let totalScrolls = 0;
    let lastCount = state.data.length;

    while (stagnantScrolls < SCROLL_CONFIG.maxStagnantScrolls && totalScrolls < SCROLL_CONFIG.maxTotalScrolls) {
      totalScrolls += 1;

      container.scrollBy({ top: Math.max(600, Math.floor(container.clientHeight * 0.85)), behavior: "auto" });
      await sleep(SCROLL_CONFIG.scrollDelayMs);
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(SCROLL_CONFIG.loadWaitMs);

      scrapeVisibleListings();

      const currentCount = state.data.length;
      const growth = currentCount - lastCount;

      if (growth >= SCROLL_CONFIG.minNewItemsToContinue) {
        stagnantScrolls = 0;
      } else {
        stagnantScrolls += 1;
      }

      lastCount = currentCount;

      console.log(
        `[Maps Scraper] Scroll ${totalScrolls} | total: ${currentCount} | growth: ${growth} | stagnant: ${stagnantScrolls}/${SCROLL_CONFIG.maxStagnantScrolls}`
      );
    }

    console.log(`[Maps Scraper] Scrolling finished. Total unique results: ${state.data.length}`);
  };

  const startScraping = async () => {
    if (state.running) {
      return {
        ok: true,
        message: "Scraping is already running.",
        count: state.data.length,
        running: true
      };
    }

    state.running = true;
    state.lastError = null;
    state.data = [];
    state.keys = new Set();
    state.progressCount = 0;

    safeSendMessage({ type: "SCRAPE_STARTED" });

    try {
      await runScrollingScrape();
      safeSendMessage({ type: "SCRAPE_DONE", payload: { count: state.data.length } });
      return {
        ok: true,
        message: "Scraping completed successfully.",
        count: state.data.length,
        running: false
      };
    } catch (error) {
      state.lastError = error?.message || "Unknown scraping error";
      console.error("[Maps Scraper] Scraping failed:", error);
      safeSendMessage({ type: "SCRAPE_ERROR", payload: { message: state.lastError } });
      return {
        ok: false,
        message: state.lastError,
        count: state.data.length,
        running: false
      };
    } finally {
      state.running = false;
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type) {
      sendResponse({ ok: false, message: "Invalid message." });
      return;
    }

    if (message.type === "PING") {
      sendResponse({ ok: true, ready: true });
      return;
    }

    if (message.type === "START_SCRAPE") {
      startScraping().then(sendResponse);
      return true;
    }

    if (message.type === "GET_DATA") {
      sendResponse({ ok: true, data: state.data, count: state.data.length, running: state.running });
      return;
    }

    if (message.type === "GET_STATUS") {
      sendResponse({
        ok: true,
        running: state.running,
        count: state.data.length,
        lastError: state.lastError
      });
      return;
    }

    sendResponse({ ok: false, message: `Unhandled message type: ${message.type}` });
  });

  console.log("[Maps Scraper] Content script loaded.");
})();
