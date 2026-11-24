# Extras

Optional styles for two apps, so they match the desktop. Kelpshell does not need them.

## Firefox theme

`firefox/` holds a Firefox theme in libadwaita's greys, so a Firefox window has the same greys as the GTK apps and the terminal next to it. It follows the dark and the light style and uses the system accent colour.

Link it into a profile (the profile directory is listed on `about:profiles`), then restart Firefox:

```bash
profile=~/.config/mozilla/firefox/XXXXXXXX.default-release
mkdir -p "$profile/chrome"
ln -s "$PWD/extras/firefox/userChrome.css" "$PWD/extras/firefox/userContent.css" "$profile/chrome/"
cat extras/firefox/user.js >> "$profile/user.js"
```

`user.js` also sets `browser.fullscreen.autohide` to false, so a fullscreen Firefox window keeps its toolbars and tabs. A fullscreen video still covers the whole monitor.

To remove the theme, delete the two links and the lines in `user.js`. The colours are the `--kelp-*` variables at the top of `userChrome.css`.

## Ghostty stylesheet

`ghostty/resize.css` removes a grey band that Ghostty 1.4 shows for one or two frames after its window grows.

```bash
ln -s "$PWD/extras/ghostty/resize.css" ~/.config/ghostty/resize.css
echo "gtk-custom-css = resize.css" >> ~/.config/ghostty/config.ghostty
```

Reload the configuration in Ghostty (`Ctrl+Shift+,`). The colour equals the backgrounds of the Ghostty themes "Adwaita" and "Adwaita Dark".
