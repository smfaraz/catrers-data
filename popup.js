const startBtn = document.getElementById("startBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const downloadJsonBtn = document.getElementById("downloadJsonBtn");
const progressCountEl = document.getElementById("progressCount");
const statusEl = document.getElementById("status");

let currentCount = 0;

const setStatus = (message, isError = false) => {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
};

const setProgress = (count) => {
  currentCount = count || 0;
  progressCountEl.textContent = `${currentCount} listing${currentCount === 1 ? "" : "s"}`;
  const canDownload = currentCount > 0;
  downloadCsvBtn.disabled = !canDownload;
  downloadJsonBtn.disabled = !canDownload;
};

const getActiveMapsTab = async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id || !tab.url?.includes("https://www.google.com/maps/search/")) {
    throw new Error("Open a Google Maps search results page first.");
  }

  return tab;
};

const sendMessageToTab = async (tabId, message) => {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (initialError) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return await chrome.tabs.sendMessage(tabId, message);
  }
};

const getScrapedData = async () => {
  const tab = await getActiveMapsTab();
  const response = await sendMessageToTab(tab.id, { type: "GET_DATA" });

  if (!response?.ok) {
    throw new Error(response?.message || "Failed to retrieve data.");
  }

  return response.data || [];
};

const toCsv = (rows) => {
  if (!rows.length) return "";

  const headers = [
    "Business Name",
    "Rating",
    "Number of Reviews",
    "Category",
    "Address",
    "Phone",
    "Website",
    "Google Maps Link"
  ];

  const escapeCell = (value) => {
    const text = String(value ?? "");
    const escaped = text.replace(/"/g, '""');
    return `"${escaped}"`;
  };

  const lines = [headers.map(escapeCell).join(",")];

  for (const item of rows) {
    const values = [
      item.businessName,
      item.rating,
      item.numberOfReviews,
      item.category,
      item.address,
      item.phone,
      item.website,
      item.googleMapsLink
    ];

    lines.push(values.map(escapeCell).join(","));
  }

  return lines.join("\n");
};

const triggerDownload = (filename, content, mimeType) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const refreshStatus = async () => {
  try {
    const tab = await getActiveMapsTab();
    const response = await sendMessageToTab(tab.id, { type: "GET_STATUS" });

    if (response?.ok) {
      setProgress(response.count || 0);
      if (response.running) {
        setStatus("Scraping in progress...");
      } else if (response.lastError) {
        setStatus(`Last error: ${response.lastError}`, true);
      } else {
        setStatus("Ready.");
      }
    }
  } catch (error) {
    setStatus(error.message, true);
    setProgress(0);
  }
};

startBtn.addEventListener("click", async () => {
  try {
    startBtn.disabled = true;
    setStatus("Starting scrape...");

    const tab = await getActiveMapsTab();
    const response = await sendMessageToTab(tab.id, { type: "START_SCRAPE" });

    if (!response?.ok) {
      throw new Error(response?.message || "Scraping failed.");
    }

    setProgress(response.count || 0);
    setStatus(response.message || "Scraping completed.");
  } catch (error) {
    console.error("[Popup] Failed to start scraping:", error);
    setStatus(error.message || "An unexpected error occurred.", true);
  } finally {
    startBtn.disabled = false;
  }
});

downloadCsvBtn.addEventListener("click", async () => {
  try {
    const data = await getScrapedData();
    if (!data.length) throw new Error("No scraped data available.");
    triggerDownload("google-maps-listings.csv", toCsv(data), "text/csv;charset=utf-8");
    setStatus(`CSV downloaded (${data.length} listings).`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

downloadJsonBtn.addEventListener("click", async () => {
  try {
    const data = await getScrapedData();
    if (!data.length) throw new Error("No scraped data available.");
    triggerDownload("google-maps-listings.json", JSON.stringify(data, null, 2), "application/json;charset=utf-8");
    setStatus(`JSON downloaded (${data.length} listings).`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type) return;

  if (message.type === "SCRAPE_STARTED") {
    setStatus("Scraping in progress...");
    setProgress(0);
    return;
  }

  if (message.type === "SCRAPE_PROGRESS") {
    const count = message.payload?.count || 0;
    setProgress(count);
    setStatus(`Scraping... ${count} listings found.`);
    return;
  }

  if (message.type === "SCRAPE_DONE") {
    const count = message.payload?.count || 0;
    setProgress(count);
    setStatus(`Scraping complete. ${count} listings collected.`);
    return;
  }

  if (message.type === "SCRAPE_ERROR") {
    setStatus(`Error: ${message.payload?.message || "Unknown error"}`, true);
  }
});

refreshStatus();
