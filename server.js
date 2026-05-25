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

// ── PDF GENERATION FROM STRUCTURED JSON ──
function buildPDF(cv, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: 'Curriculum Vitae' } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const ML = 52, MR = 52, CW = PW - ML - MR;

    // Colours
    const INK    = '#111827';
    const ACCENT = '#1d4ed8';
    const MID    = '#374151';
    const MUTED  = '#6b7280';
    const LIGHT  = '#9ca3af';
    const RULE   = '#e5e7eb';
    const HDR_BG = '#0f172a';
    const HDR_FG = '#ffffff';
    const HDR_SB = '#93c5fd';

    // Fonts
    const FB = 'Helvetica-Bold';
    const FR = 'Helvetica';

    // ── HEADER ──
    const HDR_H = cv.title ? 122 : 108;
    doc.rect(0, 0, PW, HDR_H).fill(HDR_BG);
    doc.rect(0, 0, 5, HDR_H).fill(ACCENT);

    let hy = 26;
    doc.font(FB).fontSize(27).fillColor(HDR_FG)
       .text(cv.name || 'Curriculum Vitae', ML, hy, { width: CW });
    hy = doc.y + 2;

    if (cv.title) {
      doc.font(FR).fontSize(11).fillColor(HDR_SB)
         .text(cv.title, ML, hy, { width: CW });
      hy = doc.y + 4;
    }

    // Contact line — only include fields that exist
    const contactParts = [cv.email, cv.phone, cv.location, cv.linkedin].filter(Boolean);
    if (contactParts.length) {
      doc.font(FR).fontSize(9).fillColor(HDR_SB)
         .text(contactParts.join('  ·  '), ML, hy, { width: CW });
    }

    let y = HDR_H + 26;

    // Helper: check remaining page space
    function checkPage(needed) {
      if (y + needed > PH - 44) {
        doc.addPage();
        doc.rect(0, 0, 5, PH).fill(ACCENT);
        y = 36;
      }
    }

    // Helper: draw section heading
    function sectionHeading(label) {
      checkPage(36);
      doc.font(FB).fontSize(7.5).fillColor(ACCENT)
         .text(label.toUpperCase(), ML, y, { width: CW, characterSpacing: 1.5 });
      y += 11;
      doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(RULE).lineWidth(0.6).stroke();
      y += 9;
    }

    // Helper: bullet point
    function bullet(text) {
      checkPage(16);
      doc.circle(ML + 5.5, y + 5, 1.6).fill(ACCENT);
      doc.font(FR).fontSize(9.5).fillColor(MID)
         .text(text, ML + 14, y, { width: CW - 14, lineGap: 1.5 });
      y = doc.y + 3;
    }

    // ── SUMMARY ──
    if (cv.summary) {
      sectionHeading('Professional Summary');
      checkPage(20);
      doc.font(FR).fontSize(9.5).fillColor(MID)
         .text(cv.summary, ML, y, { width: CW, lineGap: 2, align: 'justify' });
      y = doc.y + 18;
    }

    // ── EXPERIENCE ──
    if (cv.experience && cv.experience.length) {
      sectionHeading('Experience');
      cv.experience.forEach((role, i) => {
        checkPage(32);

        // Role title (left) + dates (right)
        const titleW = CW * 0.70;
        const dateW  = CW * 0.30;
        doc.font(FB).fontSize(10.5).fillColor(INK)
           .text(role.title || '', ML, y, { width: titleW, lineGap: 1 });
        if (role.dates) {
          doc.font(FR).fontSize(9).fillColor(MUTED)
             .text(role.dates, ML + titleW, y, { width: dateW, align: 'right' });
        }
        y = doc.y + 1;

        // Company + location
        const compParts = [role.company, role.location].filter(Boolean).join(', ');
        if (compParts) {
          doc.font(FR).fontSize(9.5).fillColor(MUTED)
             .text(compParts, ML, y, { width: CW });
          y = doc.y + 5;
        }

        // Bullets
        (role.bullets || []).forEach(b => bullet(b));

        if (i < cv.experience.length - 1) y += 10;
      });
      y += 16;
    }

    // ── EDUCATION ──
    if (cv.education && cv.education.length) {
      sectionHeading('Education');
      cv.education.forEach((edu, i) => {
        checkPage(24);
        doc.font(FB).fontSize(10.5).fillColor(INK)
           .text(edu.degree || '', ML, y, { width: CW * 0.70 });
        if (edu.dates) {
          doc.font(FR).fontSize(9).fillColor(MUTED)
             .text(edu.dates, ML + CW * 0.70, y, { width: CW * 0.30, align: 'right' });
        }
        y = doc.y + 1;
        const instParts = [edu.institution, edu.location].filter(Boolean).join(', ');
        if (instParts) {
          doc.font(FR).fontSize(9.5).fillColor(MUTED)
             .text(instParts, ML, y, { width: CW });
          y = doc.y + 2;
        }
        (edu.bullets || []).forEach(b => bullet(b));
        if (i < cv.education.length - 1) y += 8;
      });
      y += 16;
    }

    // ── SKILLS ──
    if (cv.skills && Object.keys(cv.skills).length) {
      sectionHeading('Skills');
      Object.entries(cv.skills).forEach(([key, val]) => {
        checkPage(14);
        doc.font(FB).fontSize(9.5).fillColor(INK)
           .text(key + ':', ML, y, { width: CW * 0.20, lineGap: 1 });
        const kvY = doc.y - 13.5;
        doc.font(FR).fontSize(9.5).fillColor(MID)
           .text(val, ML + CW * 0.22, kvY, { width: CW * 0.78, lineGap: 1 });
        y = doc.y + 4;
      });
      y += 12;
    }

    // ── PROJECTS ──
    if (cv.projects && cv.projects.length) {
      sectionHeading('Projects');
      cv.projects.forEach((proj, i) => {
        checkPage(24);
        doc.font(FB).fontSize(10).fillColor(INK)
           .text(proj.name || '', ML, y, { width: CW });
        y = doc.y + 2;
        if (proj.description) {
          doc.font(FR).fontSize(9.5).fillColor(MID)
             .text(proj.description, ML, y, { width: CW, lineGap: 1.5 });
          y = doc.y + 3;
        }
        (proj.bullets || []).forEach(b => bullet(b));
        if (i < cv.projects.length - 1) y += 8;
      });
      y += 12;
    }

    // ── EXTRA SECTIONS (anything else the AI adds) ──
    if (cv.extra_sections && cv.extra_sections.length) {
      cv.extra_sections.forEach(sec => {
        sectionHeading(sec.heading || 'Additional');
        (sec.items || []).forEach(item => {
          checkPage(14);
          doc.font(FR).fontSize(9.5).fillColor(MID)
             .text(item, ML, y, { width: CW, lineGap: 1.5 });
          y = doc.y + 3;
        });
        y += 12;
      });
    }

    // ── FOOTER ──
    doc.font(FR).fontSize(7).fillColor(LIGHT)
       .text('Generated by CV Agent', 0, PH - 22, { width: PW, align: 'center' });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

app.post('/api/generate-pdf', async (req, res) => {
  const { cv_json } = req.body;
  if (!cv_json) return res.status(400).json({ error: 'cv_json required' });

  const id  = crypto.randomBytes(8).toString('hex');
  const out = path.join(PDF_DIR, id + '.pdf');

  try {
    await buildPDF(cv_json, out);
    res.json({ pdf_id: id });
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
