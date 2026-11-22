// Eklenti simgesine tıklanınca ya da tarama panelinden istenince sonuç sayfasını açar.
function openResults() {
  chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
}

chrome.action.onClicked.addListener(openResults);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "openResults") openResults();
});
