# Clean Text

Paste messy text, press one button, get clean formatted text on your clipboard.

Live at **https://cleantext.withmagic.ai**.

## What it does

Takes text that came out of an email, a text message or a document, removes the damage, and puts
real formatting back. Then it copies the result as rich text and plain text at the same time, so
the target editor takes whichever one it understands.

Removes: invisible and zero-width characters, non-breaking spaces, forwarded mail headers, quoted
replies, signatures, "Sent from my iPhone", WhatsApp export stamps, unsubscribe boilerplate,
confidentiality notices, tracking parameters on links, and the hard line breaks an email client
puts in the middle of sentences.

Puts back: paragraphs, headings, bullet and numbered lists, bold labels on lines like `When:` and
`RSVP:`, and clickable links.

## How it is built

A static page. No backend, no database, no accounts, no build step, no dependencies.

```
public/clean.js    the product. A pure ES module: text in, blocks out
public/app.js      the only file that touches the DOM
tests/test-clean.js   imports clean.js directly, so it tests the shipped file
```

Everything runs in the browser. Nothing you paste is uploaded, stored or logged, and the page
makes no network requests at all once it has loaded. The Content-Security-Policy in
`netlify.toml` enforces that rather than just claiming it.

## Running it

```bash
node tests/test-clean.js     # the test suite
npx serve public             # any static server will do
```

No `npm install`. There are no dependencies.

## License

MIT. See `LICENSE`.
