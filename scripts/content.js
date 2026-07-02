// ScrollStop — content.js
// Runs inside Instagram & YouTube tabs.
// On every page load, checks with background if this platform is blocked.

(async () => {
  const url = window.location.href;
  const platform = detectPlatform(url);
  if (!platform) return;

  try {
    await chrome.runtime.sendMessage({ type: "CHECK_BLOCK", platform });
  } catch (e) {
    // extension context not ready yet, fail silently
  }
})();

function detectPlatform(url) {
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("youtube.com"))   return "youtube";
  return null;
}