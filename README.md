# The Archive — Class Website Starter

A responsive, static HTML/CSS/JavaScript starter for a class of 30 students.

## Run locally
- Extract the ZIP.
- Open `index.html` in a browser, or use VS Code's Live Server extension.
- Internet is currently used for Google Fonts and sample portrait images. Replace sample portraits with images you have permission to use.

## Customize the 30 student profiles
Open `script.js` and edit the `students` data. Each entry has:
- `name`
- `caption`
- `quote`
- `traits`
- `category` (`legend`, `chaos`, or `quiet`)
- `photo`

The starter generates 30 demo entries. Click a student row to expand their profile with a larger portrait, additional sample details, and room for a longer bio. Only one profile stays open at a time. The names, bios, quotes, traits, categories, and portraits are placeholders, not facts about real students. For local images, add files such as `assets/student-01.jpg` and set `photo: "assets/student-01.jpg"`.

## Customize quotes
Edit the `quotes` array near the top of `script.js`. The home-page quote rotates automatically and also has previous/next controls.

## Gallery
The gallery currently uses designed placeholder tiles. Replace each `.gallery-placeholder` in `index.html` with an `<img>` tag for your own photos. Update `data-title` and `data-caption` on the corresponding `.gallery-item` button. The click-to-open dialog is already wired up.

## Games
Both game panels are placeholders and intentionally not playable yet.
- Flappy Bird integration notes are at the bottom of `script.js`.
- Snake integration notes are at the bottom of `script.js`.
- A simple iframe integration can work if your game is in a separate HTML file. Make sure the game supports mobile sizing and touch controls if you want it playable on phones.

## Publish on GitHub Pages
1. Create a GitHub repository.
2. Upload `index.html`, `styles.css`, `script.js`, and the `assets` folder.
3. In the repository settings, open **Pages** and select the branch/folder you uploaded to.
4. Use the published URL GitHub provides.

## Before going public
- Replace all sample content.
- Use classmates' photos only with their permission.
- Avoid publishing personal contact details or sensitive information.
- Test the site on a phone as well as a desktop browser.
