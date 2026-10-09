# Privacy Policy

**Last updated:** 2026-10-10

**Chat Downloader for ChatGPT** (the "Extension") lets you save your ChatGPT conversations to your own device.

**Data we collect:** None. As the developer we do not collect, store, sell or share any data about you or your usage. There is no analytics, advertising, tracking or remote server.

**What the Extension does:**
- Its UI opens in the browser side panel. The export code runs in the open `chatgpt.com` tab only when you start an action: the Download button, the on-page "Download" button, the right-click menu, or opening a list.
- It fetches your conversation and attachments through your browser, using the account you are already signed in to. Requests go to `chatgpt.com` and to the download URLs ChatGPT provides for attachments. They go directly from your browser to ChatGPT and never pass through any server of ours.
- It builds the files (including PDF, Word and ZIP) in your browser's memory and either downloads them to your computer or writes them only to a folder you choose. PDFs are created on the Extension's own page with your browser's print feature; nothing is sent to a server.
- The session token is used only for `chatgpt.com` requests; it is never sent anywhere else and never stored.

**Stored locally on your device** (in `chrome.storage` and the Extension's IndexedDB, in your browser only):
- Your chosen formats and options, and the on-page button preference.
- For incremental backups: the IDs and last-updated times of previously exported conversations, not their content. You can clear this with "Reset backup history" in the side panel.
- The browser handle of the folder you chose for "Save to a folder". The Extension writes to it only with your permission.

**Permissions:**
- `sidePanel`: the side panel UI.
- `scripting`: runs the export code in the chatgpt.com tab.
- `storage`: the local settings above.
- `contextMenus`: the right-click menu on chatgpt.com.
- Site access to `https://chatgpt.com/*` only, including a small content script that adds an optional "Download" button to the chat header on that site. The Extension accesses no other site.

**Third-party components:** KaTeX (MIT license) is bundled in the package for rendering math; nothing is loaded from the network.

**Third parties:** No data is shared. What you do with the downloaded files (your conversations) is your responsibility.

**Affiliation:** The Extension is not affiliated with, endorsed by or sponsored by OpenAI. "ChatGPT" is a trademark of OpenAI. The Extension relies on ChatGPT's unofficial internal endpoints, which may change.

**Changes:** This page will be updated if the policy changes.

**Contact:** For questions and issues, open an issue at https://github.com/aselamt/chat-downloader-for-chatgpt/issues
