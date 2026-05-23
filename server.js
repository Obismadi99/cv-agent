const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Docs are stored as plain .txt files in /docs-store
const DOCS_DIR = path.join(__dirname, 'docs-store');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

// Seed example docs if empty
function seedDocs() {
  const existing = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.txt'));
  if (existing.length === 0) {
    const cv = `Name: Your Name
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
Java, Python, JavaScript, Spring Boot, Docker, Kubernetes, PostgreSQL, AWS`;

    const skills = `TECHNICAL SKILLS
Languages: Java, Python, JavaScript, TypeScript, SQL
Backend: Spring Boot, Node.js, Django
Cloud: AWS (EC2, S3, Lambda, RDS), GCP basics
DevOps: Docker, Kubernetes, GitHub Actions, Jenkins
Databases: PostgreSQL, MongoDB, Redis

PROJECTS
Real-time Analytics Pipeline
- Built a streaming data pipeline using Kafka + Flink
- Processed 1M events/day, reduced latency to <100ms

AI Document Search
- Embeddings-based search over internal knowledge base
- Used OpenAI + Pinecone + FastAPI

Open Source Contributions
- Contributed to Spring Framework (2 merged PRs)
- Maintainer of a small CLI tool (800+ GitHub stars)`;

    fs.writeFileSync(path.join(DOCS_DIR, 'CV.txt'), cv);
    fs.writeFileSync(path.join(DOCS_DIR, 'Skills & Projects.txt'), skills);
  }
}
seedDocs();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- DOCS API ---

// List all docs (name + char count)
app.get('/api/docs', (req, res) => {
  try {
    const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.txt'));
    const docs = files.map(f => {
      const name = f.replace(/\.txt$/, '');
      const content = fs.readFileSync(path.join(DOCS_DIR, f), 'utf8');
      return { name, chars: content.length };
    });
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single doc
app.get('/api/docs/:name', (req, res) => {
  const filePath = path.join(DOCS_DIR, req.params.name + '.txt');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.json({ name: req.params.name, content: fs.readFileSync(filePath, 'utf8') });
});

// Save (create or update) a doc
app.put('/api/docs/:name', (req, res) => {
  const { content } = req.body;
  const name = req.params.name;
  // Prevent path traversal
  if (name.includes('/') || name.includes('..') || name.includes('\\')) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  fs.writeFileSync(path.join(DOCS_DIR, name + '.txt'), content || '', 'utf8');
  res.json({ ok: true });
});

// Rename a doc
app.post('/api/docs/:name/rename', (req, res) => {
  const { newName } = req.body;
  if (!newName || newName.includes('/') || newName.includes('..')) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const oldPath = path.join(DOCS_DIR, req.params.name + '.txt');
  const newPath = path.join(DOCS_DIR, newName + '.txt');
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Not found' });
  fs.renameSync(oldPath, newPath);
  res.json({ ok: true });
});

// Delete a doc
app.delete('/api/docs/:name', (req, res) => {
  const filePath = path.join(DOCS_DIR, req.params.name + '.txt');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// --- ANTHROPIC PROXY ---
app.post('/api/agent', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`CV Agent running on port ${PORT}`);
});
