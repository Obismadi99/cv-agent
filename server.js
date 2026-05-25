const express = require('express');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const PDFDocument = require('pdfkit');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const DOCS_DIR = path.join(__dirname, 'docs-store');
const PDF_DIR  = path.join(__dirname, 'pdf-cache');
[DOCS_DIR, PDF_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── SEED DOCS ──
function seedDocs() {
  if (fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.txt')).length > 0) return;
  fs.writeFileSync(path.join(DOCS_DIR, 'CV.txt'),
`Name: Your Name
Email: your@email.com
Phone: +49 000 0000000
Location: Berlin, Germany
LinkedIn: linkedin.com/in/yourname

SUMMARY
Experienced software engineer with a passion for building scalable systems.

EXPERIENCE
Senior Software Engineer — Acme Corp (2021–present)
- Led migration of monolith to microservices architecture
- Reduced API latency by 40% through caching strategy

Software Engineer — StartupXYZ (2018–2021)
- Built REST APIs in Java Spring Boot
- Deployed to AWS using Kubernetes

EDUCATION
M.Sc. Computer Science — TU Berlin (2018)

SKILLS
Java, Python, JavaScript, Spring Boot, Docker, Kubernetes, PostgreSQL, AWS`);

  fs.writeFileSync(path.join(DOCS_DIR, 'Skills & Projects.txt'),
`TECHNICAL SKILLS
Languages: Java, Python, JavaScript, TypeScript, SQL
Backend: Spring Boot, Node.js, Django
Cloud: AWS (EC2, S3, Lambda, RDS)
DevOps: Docker, Kubernetes, GitHub Actions
Databases: PostgreSQL, MongoDB, Redis

PROJECTS
Real-time Analytics Pipeline
- Built streaming pipeline using Kafka + Flink
- Processed 1M events/day, reduced latency to <100ms`);
}
seedDocs();

app.use(express.json({ limit: '4mb' }));
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ── DOCS API ──
app.get('/api/docs', (req, res) => {
  try {
    const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.txt'));
    res.json(files.map(f => ({
      name: f.replace(/\.txt$/, ''),
      chars: fs.readFileSync(path.join(DOCS_DIR, f), 'utf8').length
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docs/:name', (req, res) => {
  const fp = path.join(DOCS_DIR, req.params.name + '.txt');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.json({ name: req.params.name, content: fs.readFileSync(fp, 'utf8') });
});

app.put('/api/docs/:name', (req, res) => {
  const name = req.params.name;
  if (name.includes('/') || name.includes('..')) return res.status(400).json({ error: 'Invalid name' });
  fs.writeFileSync(path.join(DOCS_DIR, name + '.txt'), req.body.content || '', 'utf8');
  res.json({ ok: true });
});

app.post('/api/docs/:name/rename', (req, res) => {
  const { newName } = req.body;
  if (!newName || newName.includes('/') || newName.includes('..')) return res.status(400).json({ error: 'Invalid' });
  const old = path.join(DOCS_DIR, req.params.name + '.txt');
  if (!fs.existsSync(old)) return res.status(404).json({ error: 'Not found' });
  fs.renameSync(old, path.join(DOCS_DIR, newName + '.txt'));
  res.json({ ok: true });
});

app.delete('/api/docs/:name', (req, res) => {
  const fp = path.join(DOCS_DIR, req.params.name + '.txt');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── ANTHROPIC PROXY ──
app.post('/api/agent', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    res.status(r.status).json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PDF GENERATION ──
// Parses structured CV text into sections
function parseCVSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Detect name (first non-empty line if no section yet)
    if (!sections.length && line.trim()) {
      sections.push({ type: 'name', text: line.trim() });
      continue;
    }

    // Detect contact line (contains @ or phone patterns)
    if (sections.length === 1 && line.trim() && (line.includes('@') || line.includes('+') || line.includes('linkedin') || line.includes('·') || line.includes('|'))) {
      sections.push({ type: 'contact', text: line.trim() });
      continue;
    }

    // Blank line — close current section body if needed
    if (!line.trim()) {
      if (current) { sections.push(current); current = null; }
      continue;
    }

    // Detect section headings (ALL CAPS words, or markdown ##)
    const isHeading = /^#{1,3}\s/.test(line) || /^[A-Z][A-Z\s&]{3,}$/.test(line.trim());
    if (isHeading) {
      if (current) sections.push(current);
      current = { type: 'section', heading: line.replace(/^#+\s*/, '').replace(/\*\*/g,'').trim(), items: [] };
      continue;
    }

    // Bold line inside section = sub-heading (company / role)
    if (current && (/^\*\*/.test(line) || /^###/.test(line))) {
      current.items.push({ type: 'subheading', text: line.replace(/\*\*/g,'').replace(/^#+\s*/,'').trim() });
      continue;
    }

    // Bullet
    if (current && /^[-•*]\s/.test(line.trim())) {
      current.items.push({ type: 'bullet', text: line.trim().replace(/^[-•*]\s/, '') });
      continue;
    }

    // Regular line
    if (current) {
      current.items.push({ type: 'text', text: line.trim() });
    } else {
      sections.push({ type: 'text', text: line.trim() });
    }
  }
  if (current) sections.push(current);
  return sections;
}

app.post('/api/generate-pdf', (req, res) => {
  const { cv_text } = req.body;
  if (!cv_text) return res.status(400).json({ error: 'cv_text required' });

  const id  = crypto.randomBytes(8).toString('hex');
  const out = path.join(PDF_DIR, id + '.pdf');

  try {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 52, bottom: 52, left: 58, right: 58 },
      info: { Title: 'Curriculum Vitae', Author: 'CV Agent' }
    });

    const stream = fs.createWriteStream(out);
    doc.pipe(stream);

    // ── DESIGN TOKENS ──
    const W        = doc.page.width - 116;   // usable width
    const C_DARK   = '#1a1a2e';
    const C_ACCENT = '#2563eb';
    const C_MID    = '#4b5563';
    const C_LIGHT  = '#9ca3af';
    const C_LINE   = '#e5e7eb';

    const F_HEAD   = 'Helvetica-Bold';
    const F_BODY   = 'Helvetica';
    const F_BOLD   = 'Helvetica-Bold';

    const sections = parseCVSections(cv_text);
    let nameText    = '';
    let contactText = '';
    const bodySections = [];

    for (const s of sections) {
      if (s.type === 'name')    nameText    = s.text;
      else if (s.type === 'contact') contactText = s.text;
      else bodySections.push(s);
    }

    // ── HEADER BLOCK ──
    // Accent left bar
    doc.rect(58, 52, 3, 64).fill(C_ACCENT);

    // Name
    doc.font(F_HEAD).fontSize(26).fillColor(C_DARK)
       .text(nameText || 'Curriculum Vitae', 70, 56, { width: W - 12 });

    // Contact
    if (contactText) {
      doc.font(F_BODY).fontSize(9).fillColor(C_MID)
         .text(contactText, 70, doc.y + 4, { width: W - 12 });
    }

    // Header rule
    const afterHeader = Math.max(doc.y + 14, 120);
    doc.moveTo(58, afterHeader).lineTo(58 + W, afterHeader)
       .strokeColor(C_ACCENT).lineWidth(1.5).stroke();
    doc.y = afterHeader + 16;

    // ── BODY SECTIONS ──
    for (const sec of bodySections) {
      if (sec.type === 'section') {
        // Check page space
        if (doc.y > doc.page.height - 120) { doc.addPage(); }

        // Section heading
        doc.font(F_HEAD).fontSize(9).fillColor(C_ACCENT)
           .text(sec.heading.toUpperCase(), 58, doc.y, { width: W, characterSpacing: 1.2 });

        doc.y += 4;
        doc.moveTo(58, doc.y).lineTo(58 + W, doc.y)
           .strokeColor(C_LINE).lineWidth(0.75).stroke();
        doc.y += 8;

        for (const item of sec.items) {
          if (doc.y > doc.page.height - 80) { doc.addPage(); doc.y = 52; }

          if (item.type === 'subheading') {
            // Could be "Role — Company | Date" or "**Bold**"
            const parts = item.text.split(/\s*[|·—–]\s*/);
            if (parts.length >= 2) {
              const left  = parts.slice(0, parts.length - 1).join(' — ');
              const right = parts[parts.length - 1];
              doc.font(F_BOLD).fontSize(10).fillColor(C_DARK).text(left, 58, doc.y, { continued: false, width: W * 0.72 });
              const savedY = doc.y;
              doc.font(F_BODY).fontSize(9).fillColor(C_MID)
                 .text(right, 58 + W * 0.72, savedY - 14.5, { width: W * 0.28, align: 'right' });
              doc.y = savedY;
            } else {
              doc.font(F_BOLD).fontSize(10).fillColor(C_DARK).text(item.text, 58, doc.y, { width: W });
              doc.y += 2;
            }

          } else if (item.type === 'bullet') {
            doc.font(F_BODY).fontSize(9.5).fillColor(C_MID)
               .text('•', 62, doc.y, { continued: false, width: 10 });
            const bulletY = doc.y - 13.5;
            doc.font(F_BODY).fontSize(9.5).fillColor(C_DARK)
               .text(item.text, 76, bulletY, { width: W - 20 });
            doc.y += 2;

          } else if (item.type === 'text') {
            // Could be a table row (key: value)
            const kvMatch = item.text.match(/^([^:]{1,30}):\s+(.+)$/);
            if (kvMatch) {
              doc.font(F_BOLD).fontSize(9.5).fillColor(C_DARK)
                 .text(kvMatch[1] + ':', 58, doc.y, { continued: false, width: W * 0.22 });
              const rowY = doc.y - 13.5;
              doc.font(F_BODY).fontSize(9.5).fillColor(C_MID)
                 .text(kvMatch[2], 58 + W * 0.24, rowY, { width: W * 0.76 });
            } else {
              doc.font(F_BODY).fontSize(9.5).fillColor(C_DARK)
                 .text(item.text, 58, doc.y, { width: W });
            }
            doc.y += 2;
          }
        }
        doc.y += 14;

      } else if (sec.type === 'text') {
        doc.font(F_BODY).fontSize(9.5).fillColor(C_DARK)
           .text(sec.text, 58, doc.y, { width: W });
        doc.y += 6;
      }
    }

    // ── FOOTER ──
    const pageCount = doc.bufferedPageRange ? doc.bufferedPageRange().count : 1;
    const footerY = doc.page.height - 36;
    doc.font(F_BODY).fontSize(8).fillColor(C_LIGHT)
       .text('Generated by CV Agent', 58, footerY, { width: W, align: 'center' });

    doc.end();

    stream.on('finish', () => res.json({ pdf_id: id }));
    stream.on('error', e => res.status(500).json({ error: e.message }));
  } catch(e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── SERVE PDF ──
app.get('/api/pdf/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-f0-9]/g, '');
  const fp = path.join(PDF_DIR, id + '.pdf');
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="cv.pdf"');
  res.sendFile(fp);
});

// ── CATCH-ALL ──
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => console.log(`CV Agent running on port ${PORT}`));
