# DecodeClouds

Source for [decodeclouds.com](https://decodeclouds.com): take a photo of the sky to identify the cloud.

The site is one static page (`index.html`, plain HTML/CSS/JS) served by GitHub Pages from the `main` branch. Photos are sent to a separate Cloudflare Worker for classification. The worker and its API key are not in this repository.

- `index.html`: the whole site
- `CNAME`: custom domain for GitHub Pages
- `.nojekyll`: serve files as-is, no Jekyll build
- `robots.txt`, `sitemap.xml`
