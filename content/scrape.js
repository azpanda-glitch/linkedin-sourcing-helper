// Reads the job posting currently on screen. Only reads the page the user
// is actively viewing — no automated navigation or bulk collection.

function textOf(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return "";
}

function scrapePosting() {
  const title = textOf([
    ".job-details-jobs-unified-top-card__job-title",
    ".jobs-unified-top-card__job-title",
    "h1.t-24",
    "h1"
  ]);

  const company = textOf([
    ".job-details-jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__company-name",
    'a[data-test-app-aware-link][href*="/company/"]'
  ]);

  const location = textOf([
    ".job-details-jobs-unified-top-card__primary-description-container",
    ".jobs-unified-top-card__bullet"
  ]);

  const description = textOf([
    "#job-details",
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-description-content__text"
  ]);

  return {
    title,
    company: company.split("\n")[0].trim(),
    location,
    description,
    url: location && window.location.href || window.location.href
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SCRAPE_POSTING") {
    try {
      sendResponse({ ok: true, posting: scrapePosting() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  }
  return true;
});
