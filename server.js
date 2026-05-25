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
function parseCVText(raw) {
  // Strip any agent commentary — only keep content from the first real CV line
  // CV always starts with a name (no special chars, not a sentence)
  const lines = raw.split('\n');
  let startIdx = 0;

  // Find the first line that looks like a name or the CV header
  // Skip lines that look like agent reasoning (contain "---", "document", "let me", etc.)
  const agentPhrases = /let me|i have|all doc|reading|now i|here is the|tailored|summary of|key tailor|decisions|---/i;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (agentPhrases.test(l)) continue;
    // Looks like a name line: 1-4 words, no punctuation except hyphens
    if (/^[A-ZÄÖÜ][a-zA-ZäöüÄÖÜ\s\-]{1,40}$/.test(l)) { startIdx = i; break; }
    // Or starts with a known CV section
    if (/^(PROFESSIONAL SUMMARY|EXPERIENCE|EDUCATION|SKILLS|PROJECTS|NAME)/i.test(l)) { startIdx = i; break; }
  }

  const cvLines = lines.slice(startIdx);

  // Parse into structured sections
  const result = { name: '', contact: '', sections: [] };
  let currentSection = null;
  let nameFound = false;

  for (const raw of cvLines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      if (currentSection) { result.sections.push(currentSection); currentSection = null; }
      continue;
    }

    // Name — first non-empty line
    if (!nameFound) {
      result.name = trimmed.replace(/\*\*/g, '');
      nameFound = true;
      continue;
    }

    // Contact line — contains @ or · or |
    if (!result.contact && (trimmed.includes('@') || trimmed.includes('·') || trimmed.includes('linkedin') || trimmed.includes('|'))) {
      result.contact = trimmed.replace(/\*\*/g, '');
      continue;
    }

    // Section heading — ALL CAPS or markdown ##
    const cleanLine = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '');
    const isHeading = /^[A-Z][A-Z\s\/&]{3,}$/.test(cleanLine) || /^#{1,3}\s/.test(trimmed);
    if (isHeading) {
      if (currentSection) result.sections.push(currentSection);
      currentSection = { heading: cleanLine, items: [] };
      continue;
    }

    if (!currentSection) currentSection = { heading: '', items: [] };

    // Sub-heading (role — company | date)
    if (/^\*\*/.test(trimmed) || (/^[A-Z]/.test(trimmed) && (trimmed.includes('—') || trimmed.includes('–') || trimmed.includes('|')) && !trimmed.startsWith('-'))) {
      currentSection.items.push({ type: 'role', text: cleanLine });
      continue;
    }

    // Bullet
    if (/^[-•*]\s/.test(trimmed)) {
      currentSection.items.push({ type: 'bullet', text: trimmed.replace(/^[-•*]\s*/, '') });
      continue;
    }

    // Key: value
    const kv = trimmed.match(/^([^:]{1,28}):\s+(.+)$/);
    if (kv) {
      currentSection.items.push({ type: 'kv', key: kv[1].replace(/\*\*/g,''), val: kv[2] });
      continue;
    }

    currentSection.items.push({ type: 'text', text: cleanLine });
  }
  if (currentSection) result.sections.push(currentSection);
  return result;
}

app.post('/api/generate-pdf', (req, res) => {
  const { cv_text } = req.body;
  if (!cv_text) return res.status(400).json({ error: 'cv_text required' });

  const id  = crypto.randomBytes(8).toString('hex');
  const out = path.join(PDF_DIR, id + '.pdf');

  try {
    const cv  = parseCVText(cv_text);
    const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: 'Curriculum Vitae' } });
    const stream = fs.createWriteStream(out);
    doc.pipe(stream);

    const PW = doc.page.width;   // 595
    const PH = doc.page.height;  // 842
    const ML = 52, MR = 52, MT = 0;
    const CW = PW - ML - MR;     // content width

    // ── COLOUR PALETTE ──
    const INK      = '#1a1a2e';
    const ACCENT   = '#1d4ed8';
    const MID      = '#374151';
    const MUTED    = '#6b7280';
    const RULE     = '#e5e7eb';
    const HDR_BG   = '#1a1a2e';
    const HDR_TEXT = '#ffffff';
    const HDR_SUB  = '#93c5fd';

    // ── HEADER BAND ──
    const HDR_H = 110;
    doc.rect(0, 0, PW, HDR_H).fill(HDR_BG);

    // Accent side strip
    doc.rect(0, 0, 5, HDR_H).fill(ACCENT);

    // Name
    doc.font('Helvetica-Bold').fontSize(28).fillColor(HDR_TEXT)
       .text(cv.name || 'Curriculum Vitae', ML, 28, { width: CW, lineGap: 2 });

    // Contact
    if (cv.contact) {
      doc.font('Helvetica').fontSize(9.5).fillColor(HDR_SUB)
         .text(cv.contact, ML, doc.y + 6, { width: CW, lineGap: 2 });
    }

    // ── BODY ──
    let y = HDR_H + 28;

    function checkPage(needed) {
      if (y + needed > PH - 40) {
        doc.addPage();
        // Repeat thin accent bar on new page
        doc.rect(0, 0, 5, PH).fill(ACCENT);
        y = 36;
      }
    }

    for (const sec of cv.sections) {
      if (!sec.heading && !sec.items.length) continue;
      checkPage(40);

      // Section heading
      if (sec.heading) {
        // Label
        doc.font('Helvetica-Bold').fontSize(8).fillColor(ACCENT)
           .text(sec.heading.toUpperCase(), ML, y, { width: CW, characterSpacing: 1.4 });
        y += 13;
        // Rule
        doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(RULE).lineWidth(0.75).stroke();
        y += 10;
      }

      for (const item of sec.items) {
        checkPage(20);

        if (item.type === 'role') {
          // Split "Title — Company, City | Date"
          const pipeIdx = item.text.lastIndexOf('|');
          const dashIdx = item.text.search(/[—–]/);
          let title = item.text, company = '', date = '';

          if (pipeIdx > -1) {
            date    = item.text.slice(pipeIdx + 1).trim();
            const left = item.text.slice(0, pipeIdx).trim();
            const di = left.search(/[—–]/);
            if (di > -1) { title = left.slice(0, di).trim(); company = left.slice(di + 1).trim(); }
            else title = left;
          } else if (dashIdx > -1) {
            title   = item.text.slice(0, dashIdx).trim();
            company = item.text.slice(dashIdx + 1).trim();
          }

          // Job title
          doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
             .text(title, ML, y, { width: CW * 0.68 });
          // Date right-aligned
          if (date) {
            doc.font('Helvetica').fontSize(9).fillColor(MUTED)
               .text(date, ML + CW * 0.68, y, { width: CW * 0.32, align: 'right' });
          }
          y = doc.y + 1;
          // Company
          if (company) {
            doc.font('Helvetica').fontSize(9.5).fillColor(MID)
               .text(company, ML, y, { width: CW });
            y = doc.y + 4;
          }

        } else if (item.type === 'bullet') {
          checkPage(16);
          // Bullet dot
          doc.circle(ML + 5, y + 4.5, 1.8).fill(ACCENT);
          // Text
          const bx = ML + 15;
          doc.font('Helvetica').fontSize(9.5).fillColor(MID)
             .text(item.text, bx, y, { width: CW - 15, lineGap: 1.5 });
          y = doc.y + 3;

        } else if (item.type === 'kv') {
          checkPage(14);
          doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
             .text(item.key + ':', ML, y, { width: CW * 0.20, lineGap: 1 });
          const kvY = doc.y - 13;
          doc.font('Helvetica').fontSize(9.5).fillColor(MID)
             .text(item.val, ML + CW * 0.22, kvY, { width: CW * 0.78, lineGap: 1 });
          y = doc.y + 3;

        } else if (item.type === 'text') {
          checkPage(14);
          doc.font('Helvetica').fontSize(9.5).fillColor(MID)
             .text(item.text, ML, y, { width: CW, lineGap: 1.5 });
          y = doc.y + 3;
        }
      }
      y += 16;
    }

    // ── FOOTER ──
    doc.font('Helvetica').fontSize(7.5).fillColor(RULE)
       .text('Curriculum Vitae', 0, PH - 24, { width: PW, align: 'center' });

    doc.end();
    stream.on('finish', () => res.json({ pdf_id: id }));
    stream.on('error',  e  => res.status(500).json({ error: e.message }));
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

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.listen(PORT, () => console.log(`CV Agent running on port ${PORT}`));
