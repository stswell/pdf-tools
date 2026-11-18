# PDF Tools · Star Sleep & Wellness

> **For internal use only.** Please do not use or release this tool to the public. For any issues or concerns, reach out to SDA Team (integrations@stswell.com).

A set of PDF tools that run entirely in the browser. **Documents are never uploaded.** All the work happens on the computer that has the page open, so there's no server, no account and no hosting cost.

## Tools

| Group | Tool | What it does |
|---|---|---|
| Organize | **Merge** | Pick pages from several PDFs, drag them into any order, download one PDF. Pages already added are marked "✓ #n". |
| | **Split** | Click ✂ between pages to cut there, or split every page / every N pages. Downloads a ZIP. |
| | **Rotate** | Rotate single pages or a selection, left or right. |
| | **Delete pages** | Click (or type a range like `2-4, 7`) to mark pages for removal. |
| | **Extract pages** | Save selected pages as one new PDF, or one PDF per page (ZIP). |
| Optimize & convert | **Compress** | *Basic* (lossless), *Recommended* (shrinks photos/scans, text stays selectable), *Strong* (pages become images). Never returns a bigger file. |
| | **PDF to image** | JPG or PNG at 96, 150 or 300 dpi. One page → image; several → ZIP. |
| | **Image to PDF** | JPG/PNG/WebP/GIF/BMP → one PDF. Letter/A4/Legal/fit, orientation, margins. Phone photos come out the right way up. |
| | **OCR** | Makes scanned PDFs searchable by adding invisible text over the page. English, Spanish or both. |
| Edit & sign | **Edit** | Text, freehand drawing, highlight, rectangle, ellipse, line, images, signature, **redact**, watermark, crop. Undo/redo, zoom, move/resize. |
| | **Sign** | Draw, type or upload a signature (or initials), place it; add date, text, checkmarks. |

### Good to know

- **Redaction is real.** A page with a redaction is flattened into an image when you download, so the covered text is deleted from the file, not just hidden behind a black box. Other pages keep their selectable text.
- **Signatures** can be remembered "on this computer". They are stored only in that browser's local storage; leave the box unticked on shared computers.
- **OCR** downloads the text-recognition model (about 10–20 MB) the first time it's used. Documents are still processed locally.
- Not included, because they would need a server that receives the files: PDF ↔ Word/Excel/PowerPoint, PDF/A, and inviting other people to sign.

## Run it on your computer

Python is already installed on this machine. From this folder:

```bash
python serve.py
```

Then open http://localhost:8765. (`serve.py` is Python's built-in web server plus a setting that makes the browser pick up changes with a normal refresh.)

The page loads its libraries (pdf-lib, PDF.js, JSZip, Tesseract.js) and fonts from public CDNs, so it needs an internet connection. Only the program code and fonts are downloaded; documents stay on the computer.

## Files

| Path | What it is |
|---|---|
| `index.html` | "All tools" home page |
| `merge.html`, `split.html`, `rotate.html`, `delete-pages.html`, `extract-pages.html`, `compress.html`, `pdf-to-image.html`, `image-to-pdf.html`, `ocr.html`, `edit.html`, `sign.html` | One page per tool |
| `style.css` | Brand colors and the Merge board (navy `#17386b`, orange `#f08a24`, cream `#f8f3ec`) |
| `css/tools.css` | Sidebar layout, shared tool styles, editor |
| `js/shell.js` | Top bar, sidebar, footer notice, and the list of tools |
| `js/lib.js` | Shared helpers: opening PDFs, thumbnails, downloads, icons |
| `js/merge.js` | Merge |
| `js/organize.js` | Split, Rotate, Delete pages, Extract pages |
| `js/compress.js`, `js/pdf-to-image.js`, `js/image-to-pdf.js`, `js/ocr.js` | The other single-purpose tools |
| `js/editor.js` | Edit and Sign (shared page editor) |
| `js/home.js` | Builds the home page cards |
| `assets/logo.png` | Company logo |

## Putting it online for free (later)

1. Create a **private** repository on GitHub and push this folder to it.
2. Sign in to [Cloudflare Pages](https://pages.cloudflare.com/) (or Netlify/Vercel) with GitHub and pick the repository.
3. Build settings: no framework, no build command, output directory `/`.
4. You get a free link like `pdf-tools.pages.dev`, and every push updates it automatically.
5. To limit it to staff, turn on Cloudflare Access for the site (free for small teams) so people sign in with their company email.
