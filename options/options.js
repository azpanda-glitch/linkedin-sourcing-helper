const $ = (id) => document.getElementById(id);

async function load() {
  const { extractionMode, anthropicApiKey, model, pdlApiKey } = await chrome.storage.sync.get([
    "extractionMode",
    "anthropicApiKey",
    "model",
    "pdlApiKey"
  ]);
  const mode = extractionMode || "local";
  document.querySelector(`input[name=mode][value="${mode}"]`).checked = true;
  $("apiKey").value = anthropicApiKey || "";
  $("model").value = model || "claude-haiku-4-5-20251001";
  $("pdlKey").value = pdlApiKey || "";
}

async function save() {
  const mode = document.querySelector("input[name=mode]:checked")?.value || "local";
  await chrome.storage.sync.set({
    extractionMode: mode,
    anthropicApiKey: $("apiKey").value.trim(),
    model: $("model").value,
    pdlApiKey: $("pdlKey").value.trim()
  });
  const saved = $("saved");
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 1500);
}

$("save").addEventListener("click", save);
load();
