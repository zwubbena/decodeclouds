# decodeclouds.com — FINAL

This folder is the website. When the GitHub repo is created, its contents go to
the repo root and GitHub Pages serves them at decodeclouds.com.

- index.html   the whole site: tool, result cards, cloud-type list, footer (plain HTML/CSS/JS)
- CNAME        decodeclouds.com
- .nojekyll    serve files raw
- robots.txt, sitemap.xml
- worker/      the Cloudflare Worker backend ("decode-clouds"); deploy with
               npm install · npx wrangler login · npx wrangler secret put ANTHROPIC_API_KEY · npx wrangler deploy
               (never commit worker/.dev.vars; it is gitignored)

Design source of truth: ../decode_clouds_website/Main.dc.html (desktop) and
../decode_clouds_iphone/Phone.dc.html (phone). index.html follows their values.

Everything else in ../ (ONLY-USE-PARTS, the draft, the mockup exports) is reference, not the site.
