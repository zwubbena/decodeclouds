# DecodeClouds

Source for [decodeclouds.com](https://decodeclouds.com): take a photo of the sky to identify the cloud.

The site is one static page (plain HTML, CSS and JavaScript, no build step) served by GitHub Pages from the `main` branch. Photos are sent to a separate Cloudflare Worker for classification. The worker and its API key are not in this repository.

- `index.html`: the page markup, plus its Content-Security-Policy
- `site.css`: styles
- `app.js`: behavior (photo handling, the call to the worker, results, sharing)
- `fonts/`: Source Serif 4 and Nunito (SIL Open Font License), served from this site
- `photos/`: example cloud photos from Wikimedia Commons, resized; author, license and source for each are in `app.js` and shown on the photo
- `CNAME`: custom domain for GitHub Pages
- `.nojekyll`: serve files as-is, no Jekyll build
- `robots.txt`, `sitemap.xml`
