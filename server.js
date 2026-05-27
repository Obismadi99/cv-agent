const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const crypto   = require('crypto');
const PDFDocument = require('pdfkit');
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const app  = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY  = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Service-role client (bypasses RLS for server operations)
let supabaseAdmin = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
}

app.use(express.json({ limit: '4mb' }));
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ── AUTH MIDDLEWARE ──
// Verifies Supabase JWT and attaches user to req
async function requireAuth(req, res, next) {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error) {
      console.error('Auth error:', error.message, error.status);
      return res.status(401).json({ error: 'Invalid token: ' + error.message });
    }
    if (!user) return res.status(401).json({ error: 'No user found for token' });
    req.user = user;
    next();
  } catch(e) { console.error('Auth exception:', e); res.status(401).json({ error: 'Auth error: ' + e.message }); }
}

// ── SAMPLE DOCS ──
const SAMPLE_DOCS = [
  {
    name: 'CV',
    content: `Name: Your Name
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
Java, Python, JavaScript, Spring Boot, Docker, Kubernetes, PostgreSQL, AWS`
  },
  {
    name: 'Skills & Projects',
    content: `TECHNICAL SKILLS
Languages: Java, Python, JavaScript, TypeScript, SQL
Backend: Spring Boot, Node.js, Django
Cloud: AWS (EC2, S3, Lambda, RDS)
DevOps: Docker, Kubernetes, GitHub Actions
Databases: PostgreSQL, MongoDB, Redis

PROJECTS
Real-time Analytics Pipeline
- Built streaming pipeline using Kafka + Flink
- Processed 1M events/day, reduced latency to <100ms

Payment Processing Service
- Built high-throughput API handling 500 transactions/second
- Used Kafka for async processing, reduced latency by 45%`
  }
];

// ── DOCS API ──
app.get('/api/docs', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('documents')
      .select('id, name, content')
      .eq('user_id', req.user.id)
      .order('created_at');
    if (error) throw error;

    // First login — seed sample docs
    if (data.length === 0) {
      const toInsert = SAMPLE_DOCS.map(d => ({ user_id: req.user.id, name: d.name, content: d.content }));
      const { data: seeded, error: seedErr } = await supabaseAdmin
        .from('documents')
        .insert(toInsert)
        .select('id, name, content');
      if (seedErr) throw seedErr;
      return res.json(seeded.map(d => ({ id: d.id, name: d.name, chars: (d.content || '').length })));
    }

    res.json(data.map(d => ({ id: d.id, name: d.name, chars: (d.content || '').length })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docs/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('documents')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/docs', requireAuth, async (req, res) => {
  try {
    const { name, content } = req.body;
    const { data, error } = await supabaseAdmin
      .from('documents')
      .insert({ user_id: req.user.id, name: name || 'Untitled', content: content || '' })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/docs/:id', requireAuth, async (req, res) => {
  try {
    const { name, content } = req.body;
    const updates = {};
    if (name !== undefined)    updates.name    = name;
    if (content !== undefined) updates.content = content;
    const { error } = await supabaseAdmin
      .from('documents')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/docs/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('documents')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CV HISTORY API ──
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('cv_history')
      .select('id, created_at, job_title, company, style, match_score')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('cv_history')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/history', requireAuth, async (req, res) => {
  try {
    const { cv_json, job_description, style, match_score, match_breakdown } = req.body;
    const jobTitle = req.body.job_title || cv_json?.experience?.[0]?.title || '';
    const company  = req.body.company  || cv_json?.experience?.[0]?.company || '';
    const { data, error } = await supabaseAdmin
      .from('cv_history')
      .insert({
        user_id: req.user.id,
        cv_json,
        job_description,
        style: style || 'modern',
        job_title: jobTitle,
        company,
        match_score,
        match_breakdown
      })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('cv_history')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANTHROPIC PROXY ──
app.post('/api/agent', requireAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── JOB DESCRIPTION SCRAPER ──
app.post('/api/scrape', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CVAgent/1.0)' }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    // Strip tags, collapse whitespace
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    res.json({ text });
  } catch(e) { res.status(500).json({ error: `Could not fetch URL: ${e.message}` }); }
});

// ── PDF GENERATION ──
const STYLES = {
  modern: {
    hdrBg: '#0f172a', hdrFg: '#ffffff', hdrSub: '#93c5fd',
    accent: '#1d4ed8', ink: '#111827', mid: '#374151',
    muted: '#6b7280', rule: '#e5e7eb', light: '#9ca3af',
    sideBar: true, sideBarColor: '#1d4ed8'
  },
  classic: {
    hdrBg: '#1a1a1a', hdrFg: '#ffffff', hdrSub: '#cccccc',
    accent: '#1a1a1a', ink: '#000000', mid: '#333333',
    muted: '#555555', rule: '#cccccc', light: '#999999',
    sideBar: false
  },
  minimal: {
    hdrBg: '#ffffff', hdrFg: '#111827', hdrSub: '#6b7280',
    accent: '#059669', ink: '#111827', mid: '#374151',
    muted: '#6b7280', rule: '#e5e7eb', light: '#9ca3af',
    sideBar: false
  }
};

function buildPDF(cv, outputPath, styleName) {
  return new Promise((resolve, reject) => {
    const S   = STYLES[styleName] || STYLES.modern;
    const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: 'Curriculum Vitae' } });
    const fs  = require('fs');
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const ML = 52, MR = 52, CW = PW - ML - MR;
    const FB = 'Helvetica-Bold', FR = 'Helvetica';

    // ── HEADER ──
    const isMinimal = styleName === 'minimal';
    const HDR_H = isMinimal ? 80 : (cv.title ? 118 : 104);

    if (!isMinimal) {
      doc.rect(0, 0, PW, HDR_H).fill(S.hdrBg);
      if (S.sideBar) doc.rect(0, 0, 5, HDR_H).fill(S.sideBarColor);
    } else {
      // minimal: just a bottom border
      doc.moveTo(ML, HDR_H - 1).lineTo(ML + CW, HDR_H - 1).strokeColor(S.accent).lineWidth(2).stroke();
    }

    let hy = isMinimal ? 22 : 24;
    doc.font(FB).fontSize(isMinimal ? 24 : 27).fillColor(isMinimal ? S.ink : S.hdrFg)
       .text(cv.name || 'Curriculum Vitae', ML, hy, { width: CW });
    hy = doc.y + 2;

    if (cv.title) {
      doc.font(FR).fontSize(11).fillColor(isMinimal ? S.muted : S.hdrSub)
         .text(cv.title, ML, hy, { width: CW });
      hy = doc.y + 4;
    }

    const contactParts = [cv.email, cv.phone, cv.location, cv.linkedin].filter(Boolean);
    if (contactParts.length) {
      doc.font(FR).fontSize(9).fillColor(isMinimal ? S.muted : S.hdrSub)
         .text(contactParts.join('  ·  '), ML, hy, { width: CW });
    }

    let y = HDR_H + (isMinimal ? 22 : 24);

    function checkPage(needed) {
      if (y + needed > PH - 44) {
        doc.addPage();
        if (S.sideBar) doc.rect(0, 0, 5, PH).fill(S.sideBarColor);
        y = 36;
      }
    }

    function sectionHeading(label) {
      checkPage(36);
      if (styleName === 'classic') {
        doc.font(FB).fontSize(10).fillColor(S.ink).text(label.toUpperCase(), ML, y, { width: CW, characterSpacing: 0.8 });
        y += 12;
        doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(S.ink).lineWidth(0.8).stroke();
      } else if (styleName === 'minimal') {
        doc.font(FB).fontSize(9).fillColor(S.accent).text(label.toUpperCase(), ML, y, { width: CW, characterSpacing: 1.5 });
        y += 11;
        doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(S.rule).lineWidth(0.6).stroke();
      } else {
        doc.font(FB).fontSize(7.5).fillColor(S.accent).text(label.toUpperCase(), ML, y, { width: CW, characterSpacing: 1.5 });
        y += 11;
        doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(S.rule).lineWidth(0.6).stroke();
      }
      y += 9;
    }

    function bullet(text) {
      checkPage(16);
      if (styleName === 'classic') {
        doc.font(FR).fontSize(9.5).fillColor(S.mid).text('•  ' + text, ML + 8, y, { width: CW - 8, lineGap: 1.5 });
      } else {
        doc.circle(ML + 5.5, y + 5, 1.6).fill(S.accent);
        doc.font(FR).fontSize(9.5).fillColor(S.mid).text(text, ML + 14, y, { width: CW - 14, lineGap: 1.5 });
      }
      y = doc.y + 3;
    }

    function roleHeader(role) {
      checkPage(32);
      doc.font(FB).fontSize(10.5).fillColor(S.ink)
         .text(role.title || '', ML, y, { width: CW * 0.70 });
      if (role.dates) {
        doc.font(FR).fontSize(9).fillColor(S.muted)
           .text(role.dates, ML + CW * 0.70, y, { width: CW * 0.30, align: 'right' });
      }
      y = doc.y + 1;
      const compParts = [role.company, role.location].filter(Boolean).join(', ');
      if (compParts) {
        doc.font(styleName === 'classic' ? FB : FR).fontSize(9.5).fillColor(S.muted)
           .text(compParts, ML, y, { width: CW });
        y = doc.y + 5;
      }
    }

    // SUMMARY
    if (cv.summary) {
      sectionHeading('Professional Summary');
      doc.font(FR).fontSize(9.5).fillColor(S.mid)
         .text(cv.summary, ML, y, { width: CW, lineGap: 2, align: 'justify' });
      y = doc.y + 18;
    }

    // EXPERIENCE
    if (cv.experience?.length) {
      sectionHeading('Experience');
      cv.experience.forEach((role, i) => {
        roleHeader(role);
        (role.bullets || []).forEach(b => bullet(b));
        if (i < cv.experience.length - 1) y += 10;
      });
      y += 16;
    }

    // EDUCATION
    if (cv.education?.length) {
      sectionHeading('Education');
      cv.education.forEach((edu, i) => {
        checkPage(24);
        doc.font(FB).fontSize(10.5).fillColor(S.ink)
           .text(edu.degree || '', ML, y, { width: CW * 0.70 });
        if (edu.dates) doc.font(FR).fontSize(9).fillColor(S.muted).text(edu.dates, ML + CW * 0.70, y, { width: CW * 0.30, align: 'right' });
        y = doc.y + 1;
        const inst = [edu.institution, edu.location].filter(Boolean).join(', ');
        if (inst) { doc.font(FR).fontSize(9.5).fillColor(S.muted).text(inst, ML, y, { width: CW }); y = doc.y + 2; }
        (edu.bullets || []).forEach(b => bullet(b));
        if (i < cv.education.length - 1) y += 8;
      });
      y += 16;
    }

    // SKILLS
    if (cv.skills && Object.keys(cv.skills).length) {
      sectionHeading('Skills');
      Object.entries(cv.skills).forEach(([key, val]) => {
        checkPage(14);
        doc.font(FB).fontSize(9.5).fillColor(S.ink).text(key + ':', ML, y, { width: CW * 0.20, lineGap: 1 });
        const kvY = doc.y - 13.5;
        doc.font(FR).fontSize(9.5).fillColor(S.mid).text(val, ML + CW * 0.22, kvY, { width: CW * 0.78, lineGap: 1 });
        y = doc.y + 4;
      });
      y += 12;
    }

    // PROJECTS
    if (cv.projects?.length) {
      sectionHeading('Projects');
      cv.projects.forEach((proj, i) => {
        checkPage(24);
        doc.font(FB).fontSize(10).fillColor(S.ink).text(proj.name || '', ML, y, { width: CW });
        y = doc.y + 2;
        if (proj.description) { doc.font(FR).fontSize(9.5).fillColor(S.mid).text(proj.description, ML, y, { width: CW, lineGap: 1.5 }); y = doc.y + 3; }
        (proj.bullets || []).forEach(b => bullet(b));
        if (i < cv.projects.length - 1) y += 8;
      });
      y += 12;
    }

    // EXTRA SECTIONS
    if (cv.extra_sections?.length) {
      cv.extra_sections.forEach(sec => {
        sectionHeading(sec.heading || 'Additional');
        (sec.items || []).forEach(item => {
          checkPage(14);
          doc.font(FR).fontSize(9.5).fillColor(S.mid).text(item, ML, y, { width: CW, lineGap: 1.5 });
          y = doc.y + 3;
        });
        y += 12;
      });
    }

    // FOOTER
    doc.font(FR).fontSize(7).fillColor(S.light)
       .text('Generated by CV Agent', 0, PH - 22, { width: PW, align: 'center' });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

app.post('/api/generate-pdf', requireAuth, async (req, res) => {
  const { cv_json, style } = req.body;
  if (!cv_json) return res.status(400).json({ error: 'cv_json required' });
  const fs = require('fs');
  const os = require('os');
  const id  = crypto.randomBytes(8).toString('hex');
  const out = path.join(os.tmpdir(), id + '.pdf');
  try {
    await buildPDF(cv_json, out, style || 'modern');
    const pdfBytes = fs.readFileSync(out);
    fs.unlinkSync(out);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cv.pdf"`);
    res.send(pdfBytes);
  } catch(e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: e.message });
  }
});


// ── COVER LETTER PDF ──
function buildCoverLetterPDF(cl, outputPath) {
  return new Promise((resolve, reject) => {
    const fs2 = require('fs');
    const doc = new PDFDocument({ size:'A4', margins:{top:0,bottom:0,left:0,right:0}, info:{Title:'Cover Letter'} });
    const stream = fs2.createWriteStream(outputPath);
    doc.pipe(stream);
    const PW=doc.page.width, PH=doc.page.height;
    const ML=62, MR=62, CW=PW-ML-MR;
    const FB='Helvetica-Bold', FR='Helvetica';
    const INK='#111827', MID='#374151', MUTED='#6b7280', LIGHT='#9ca3af', ACCENT='#1d4ed8';
    let y=52;

    // Sender block — top right
    const sender=cl.sender||{};
    const senderLines=[sender.name,sender.address,sender.email,sender.phone].filter(Boolean);
    const senderW=200, senderX=PW-MR-senderW;
    senderLines.forEach((line,i)=>{
      doc.font(i===0?FB:FR).fontSize(9.5).fillColor(i===0?INK:MUTED).text(line,senderX,y,{width:senderW,align:'right'});
      y=doc.y+1;
    });
    y=Math.max(y,130);

    // Recipient block — top left
    const recipient=cl.recipient||{};
    let ry=130;
    [recipient.company,recipient.department,recipient.address].filter(Boolean).forEach((line,i)=>{
      doc.font(i===0?FB:FR).fontSize(9.5).fillColor(i===0?INK:MID).text(line,ML,ry,{width:CW*0.55});
      ry=doc.y+1;
    });

    // Date — right aligned
    y=Math.max(ry+20,200);
    doc.font(FR).fontSize(9.5).fillColor(MUTED).text(cl.date||'',ML,y,{width:CW,align:'right'});
    y=doc.y+20;

    // Subject line
    doc.font(FB).fontSize(11).fillColor(INK).text(cl.subject||'',ML,y,{width:CW});
    y=doc.y+6;
    doc.moveTo(ML,y).lineTo(ML+CW,y).strokeColor(ACCENT).lineWidth(1.5).stroke();
    y+=20;

    // Salutation
    doc.font(FR).fontSize(10).fillColor(INK).text(cl.salutation||'Dear Sir or Madam,',ML,y,{width:CW});
    y=doc.y+14;

    // Paragraphs
    (cl.paragraphs||[]).forEach((para,i)=>{
      if (y+40>PH-100) { doc.addPage(); y=52; }
      doc.font(FR).fontSize(10).fillColor(MID).text(para,ML,y,{width:CW,lineGap:2.5,align:'justify'});
      y=doc.y+(i<(cl.paragraphs.length-1)?10:14);
    });

    // Closing + signature space
    if (y+55>PH) { doc.addPage(); y=52; }
    doc.font(FR).fontSize(10).fillColor(INK).text(cl.closing||'Yours sincerely,',ML,y,{width:CW});
    y=doc.y+18;
    doc.font(FB).fontSize(10).fillColor(INK).text(cl.name||'',ML,y,{width:CW});

    // Footer
    

    doc.end();
    stream.on('finish',resolve);
    stream.on('error',reject);
  });
}

app.post('/api/generate-cover-letter-pdf', requireAuth, async (req, res) => {
  const { cl_json } = req.body;
  if (!cl_json) return res.status(400).json({ error: 'cl_json required' });
  const fs2=require('fs'), os=require('os');
  const id=crypto.randomBytes(8).toString('hex');
  const out=path.join(os.tmpdir(),id+'.pdf');
  try {
    await buildCoverLetterPDF(cl_json, out);
    const pdfBytes=fs2.readFileSync(out); fs2.unlinkSync(out);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','inline; filename="cover-letter.pdf"');
    res.send(pdfBytes);
  } catch(e) { console.error('CL PDF error:',e); res.status(500).json({error:e.message}); }
});

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.listen(PORT, () => console.log(`CV Agent running on port ${PORT}`));
