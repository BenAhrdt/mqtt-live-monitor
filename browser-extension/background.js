const DISPLAY_MODE_KEY = 'displayMode';

async function applyDisplayMode() {
  const { [DISPLAY_MODE_KEY]: displayMode = 'popup' } =
    await chrome.storage.local.get(DISPLAY_MODE_KEY);
  const useSidePanel = displayMode === 'sidePanel';

  await Promise.all([
    chrome.action.setPopup({ popup: useSidePanel ? '' : 'popup.html' }),
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: useSidePanel })
  ]);
}

chrome.runtime.onInstalled.addListener(() => {
  applyDisplayMode().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  applyDisplayMode().catch(console.error);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[DISPLAY_MODE_KEY]) return;
  applyDisplayMode().catch(console.error);
});

applyDisplayMode().catch(console.error);
