"use strict";

// sidebarAction.toggle() must be called synchronously from a user-input
// handler. A keyboard command counts as one, so call it directly.
browser.commands.onCommand.addListener((name) => {
  if (name === "toggle-downloads-sidebar") {
    browser.sidebarAction.toggle().catch((err) => {
      console.error("Could not toggle the Downloads sidebar:", err);
    });
  }
});
