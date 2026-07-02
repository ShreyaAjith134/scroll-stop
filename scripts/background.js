// ScrollStop — background.js
// The brain: initialises storage, tracks time, triggers blocks

const PLATFORMS = {
  instagram: { match: (url) => url.includes("instagram.com"), defaultLimit: 30 },
  youtube:   { match: (url) => url.includes("youtube.com"),  defaultLimit: 60  },
};

const TICK_INTERVAL = 5; // seconds
const BLOCKED_PAGE  = chrome.runtime.getURL("pages/blocked.html");

// ── 1. INIT ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);

  if (!existing.limits)    await chrome.storage.local.set({ limits:    { instagram: 30,    youtube: 60    } });
  if (!existing.usage)     await chrome.storage.local.set({ usage:     { instagram: 0,     youtube: 0     } });
  if (!existing.blocked)   await chrome.storage.local.set({ blocked:   { instagram: false,  youtube: false } });
  if (!existing.bonusUsed) await chrome.storage.local.set({ bonusUsed: { instagram: false,  youtube: false } });
  if (!existing.streaks)   await chrome.storage.local.set({ streaks:   { current: 0, lastSuccess: null   } });
  if (!existing.lastReset) await chrome.storage.local.set({ lastReset: todayStr() });

  chrome.alarms.create("tick",          { periodInMinutes: TICK_INTERVAL / 60 });
  chrome.alarms.create("midnightCheck", { periodInMinutes: 1 });
});

// re-create alarms on browser startup (service worker wakes fresh)
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("tick",          { periodInMinutes: TICK_INTERVAL / 60 });
  chrome.alarms.create("midnightCheck", { periodInMinutes: 1 });
});

// ── 2. ALARMS ────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "tick")          await tick();
  if (alarm.name === "midnightCheck") await midnightReset();

  // bonus expiry — re-blocks a platform after 5 min bonus expires
  if (alarm.name.startsWith("bonusExpire_")) {
    const platform = alarm.name.replace("bonusExpire_", "");
    const data = await chrome.storage.local.get("blocked");
    const blocked = data.blocked || {};
    blocked[platform] = true;
    await chrome.storage.local.set({ blocked });
    await blockAllTabsFor(platform);
  }
});

// ── 3. TICK ──────────────────────────────────────────────────────────────────

async function tick() {
  // get the active focused tab
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) return;

  const url = tabs[0].url || "";
  const platform = detectPlatform(url);
  if (!platform) return; // not on a tracked site

  const data = await chrome.storage.local.get(["usage", "limits", "blocked"]);
  const usage   = data.usage   || {};
  const limits  = data.limits  || {};
  const blocked = data.blocked || {};

  if (blocked[platform]) return; // already blocked, don't keep ticking

  // add tick interval (converted from seconds to minutes)
  usage[platform] = (usage[platform] || 0) + TICK_INTERVAL / 60;

  const limit = limits[platform] ?? PLATFORMS[platform].defaultLimit;

  if (usage[platform] >= limit) {
    usage[platform] = limit; // cap it exactly at limit
    blocked[platform] = true;
    await chrome.storage.local.set({ usage, blocked });
    blockTab(tabs[0].id, platform);
  } else {
    await chrome.storage.local.set({ usage });
  }
}

// ── 4. MIDNIGHT RESET ────────────────────────────────────────────────────────

async function midnightReset() {
  const data = await chrome.storage.local.get(["lastReset", "blocked", "usage", "limits", "streaks"]);
  const today = todayStr();
  if (data.lastReset === today) return; // already reset today

  // was yesterday a success? (never got blocked on either platform)
  const blocked = data.blocked || {};
  const success = !blocked.instagram && !blocked.youtube;

  const streaks = data.streaks || { current: 0, lastSuccess: null };
  if (success) {
    streaks.current = (streaks.current || 0) + 1;
    streaks.lastSuccess = data.lastReset;
  } else {
    streaks.current = 0;
  }

  await chrome.storage.local.set({
    usage:     { instagram: 0,     youtube: 0     },
    blocked:   { instagram: false,  youtube: false },
    bonusUsed: { instagram: false,  youtube: false },
    lastReset: today,
    streaks,
  });
}

// ── 5. MESSAGES (from popup, content, block page) ────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_BLOCK") {
    handleCheckBlock(msg.platform, sender.tab?.id).then(sendResponse);
    return true; // keeps the message channel open for async response
  }
  if (msg.type === "USE_BONUS") {
    handleBonus(msg.platform).then(sendResponse);
    return true;
  }
  if (msg.type === "GET_STATUS") {
    chrome.storage.local.get(["usage", "limits", "blocked", "streaks", "bonusUsed"])
      .then(sendResponse);
    return true;
  }
  if (msg.type === "SET_LIMIT") {
    setLimit(msg.platform, msg.minutes).then(sendResponse);
    return true;
  }
});

async function handleCheckBlock(platform, tabId) {
  const data = await chrome.storage.local.get("blocked");
  const isBlocked = data.blocked?.[platform] ?? false;
  if (isBlocked && tabId) blockTab(tabId, platform);
  return { blocked: isBlocked };
}

async function handleBonus(platform) {
  const data = await chrome.storage.local.get(["bonusUsed", "blocked"]);
  const bonusUsed = data.bonusUsed || {};
  const blocked   = data.blocked   || {};

  if (bonusUsed[platform]) return { success: false };

  bonusUsed[platform] = true;
  blocked[platform]   = false;
  await chrome.storage.local.set({ bonusUsed, blocked });

  // re-block after 5 minutes
  chrome.alarms.create(`bonusExpire_${platform}`, { delayInMinutes: 5 });

  return { success: true };
}

async function setLimit(platform, minutes) {
  const data = await chrome.storage.local.get("limits");
  const limits = data.limits || {};
  limits[platform] = minutes;
  await chrome.storage.local.set({ limits });
  return { success: true };
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

function detectPlatform(url) {
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (p.match(url)) return key;
  }
  return null;
}

function blockTab(tabId, platform) {
  chrome.tabs.update(tabId, { url: `${BLOCKED_PAGE}?platform=${platform}` }).catch(() => {});
}

async function blockAllTabsFor(platform) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && detectPlatform(tab.url) === platform) {
      blockTab(tab.id, platform);
    }
  }
}

function todayStr() {
  return new Date().toISOString().split("T")[0]; // "2025-01-15"
}