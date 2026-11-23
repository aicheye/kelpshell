// Kelpshell theme for Firefox: Firefox only reads chrome/userChrome.css and
// chrome/userContent.css from the profile when this preference is true.
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);

// Keep the toolbars and the tabs (tab strip or vertical tabs) in a fullscreen
// window. With the default, true, Firefox hides them until the pointer reaches
// the top edge. A fullscreen video still covers the whole monitor.
user_pref("browser.fullscreen.autohide", false);
