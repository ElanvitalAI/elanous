# Interactivity Patterns

Copy-paste JS + CSS code snippets for common interactive diagram patterns. Use these as building blocks when wiring up interactivity in Phase 2 of the section-by-section workflow.

---

## 1. Hover Highlight + Connected Elements Glow

When hovering a node, highlight it and glow its connected elements.

```js
// Define connections as adjacency list
const connections = {
  'node-api': ['node-auth', 'node-db', 'arrow-api-auth', 'arrow-api-db'],
  'node-auth': ['node-api', 'node-token', 'arrow-api-auth', 'arrow-auth-token'],
  // ... add all connections
};

document.querySelectorAll('.interactive-node').forEach(node => {
  node.addEventListener('mouseenter', () => {
    // Fade all nodes
    document.querySelectorAll('.interactive-node').forEach(n => {
      n.style.opacity = '0.3';
      n.style.transition = 'opacity 0.3s ease, filter 0.3s ease';
    });
    // Highlight this node and connected
    node.style.opacity = '1';
    node.querySelector('.node-bg').style.filter = 'brightness(1.1) drop-shadow(0 0 8px var(--c-glow-primary))';

    const connected = connections[node.id] || [];
    connected.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.opacity = '1';
        const bg = el.querySelector('.node-bg');
        if (bg) bg.style.filter = 'saturate(1.3) brightness(1.05)';
      }
    });
  });

  node.addEventListener('mouseleave', () => {
    document.querySelectorAll('.interactive-node').forEach(n => {
      n.style.opacity = '1';
      const bg = n.querySelector('.node-bg');
      if (bg) bg.style.filter = '';
    });
  });
});
```

---

## 2. Click to Show Detail Panel

Click a node to reveal a detail panel with evidence artifacts.

```html
<!-- Detail panel (outside SVG, in HTML body) -->
<div id="detail-panel" class="fixed right-0 top-0 h-full w-96 bg-white shadow-2xl transform translate-x-full transition-transform duration-300 z-50 overflow-y-auto">
  <div class="p-6">
    <button id="detail-close" class="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
    <h2 id="detail-title" class="text-xl font-bold text-blue-900 mb-4"></h2>
    <div id="detail-content" class="text-gray-600 text-sm leading-relaxed"></div>
  </div>
</div>
```

```js
const details = {
  'node-api': {
    title: 'API Gateway',
    content: `
      <p class="mb-3">Routes incoming HTTP requests to appropriate microservices.</p>
      <div class="bg-slate-800 rounded-lg p-4 mb-3">
        <pre class="text-green-400 text-xs"><code>GET /api/v1/users/:id
Authorization: Bearer &lt;token&gt;
Content-Type: application/json</code></pre>
      </div>
      <p class="text-xs text-gray-400">Click "Copy" to copy the code snippet.</p>
    `
  },
  // ... more details
};

function showDetail(nodeId) {
  const detail = details[nodeId];
  if (!detail) return;

  document.getElementById('detail-title').textContent = detail.title;
  document.getElementById('detail-content').innerHTML = detail.content;
  document.getElementById('detail-panel').classList.remove('translate-x-full');
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-panel').classList.add('translate-x-full');
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('detail-panel').classList.add('translate-x-full');
  }
});
```

---

## 3. Click to Show Modal

For evidence artifacts that need full-screen viewing.

```html
<!-- Modal overlay -->
<div id="modal-overlay" class="fixed inset-0 bg-black/50 hidden z-50 flex items-center justify-center p-8">
  <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto">
    <div class="p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 id="modal-title" class="text-lg font-bold text-slate-800"></h3>
        <button id="modal-close" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
      </div>
      <div id="modal-body"></div>
    </div>
  </div>
</div>
```

```js
function showModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
});
```

---

## 4. Animated Flow Arrows (stroke-dashoffset)

```css
@keyframes dash-flow {
  to { stroke-dashoffset: -24; }
}

.flow-animated {
  stroke-dasharray: 8 4;
  animation: dash-flow 2s linear infinite;
}

/* Pause animation by default, play on parent hover */
.flow-group .flow-animated {
  animation-play-state: paused;
}
.flow-group:hover .flow-animated {
  animation-play-state: running;
}
```

---

## 5. Decision Path Highlighting

Click a decision node to highlight the chosen path and fade alternatives.

```js
const decisionPaths = {
  'node-decision-auth': {
    yes: ['arrow-auth-yes', 'node-success', 'arrow-to-dashboard'],
    no: ['arrow-auth-no', 'node-error', 'arrow-to-login']
  }
};

let activeDecision = null;

function highlightPath(decisionId, path) {
  const paths = decisionPaths[decisionId];
  if (!paths) return;

  // Reset all
  Object.values(paths).flat().forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.opacity = '0.2'; el.style.transition = 'opacity 0.3s ease'; }
  });

  // Highlight chosen path
  paths[path].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.opacity = '1'; }
  });

  activeDecision = { decisionId, path };
}

function resetPaths(decisionId) {
  const paths = decisionPaths[decisionId];
  if (!paths) return;
  Object.values(paths).flat().forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.opacity = '1';
  });
  activeDecision = null;
}
```

---

## 6. Timeline Step-by-Step Reveal

Click timeline dots to progressively reveal steps.

```js
const timelineSteps = ['step-1', 'step-2', 'step-3', 'step-4'];
let currentStep = -1;

function revealStep(index) {
  timelineSteps.forEach((stepId, i) => {
    const el = document.getElementById(stepId);
    if (!el) return;
    if (i <= index) {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
      el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    } else {
      el.style.opacity = '0.15';
      el.style.transform = 'translateY(10px)';
    }
  });
  currentStep = index;
}

// Auto-play option
function autoPlayTimeline(interval = 1500) {
  let step = 0;
  const timer = setInterval(() => {
    if (step >= timelineSteps.length) { clearInterval(timer); return; }
    revealStep(step);
    step++;
  }, interval);
}
```

---

## 7. Layer Toggle (Summary / Detail / Code)

```html
<!-- Toggle bar (outside SVG) -->
<div class="flex gap-2 mb-4 justify-center">
  <button class="layer-btn px-4 py-2 rounded-lg text-sm font-medium bg-blue-100 text-blue-700"
          data-layer="summary" onclick="setLayer('summary')">Summary</button>
  <button class="layer-btn px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-500"
          data-layer="detail" onclick="setLayer('detail')">Full Detail</button>
  <button class="layer-btn px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-500"
          data-layer="code" onclick="setLayer('code')">Code View</button>
</div>
```

```js
function setLayer(layer) {
  // Update button styles
  document.querySelectorAll('.layer-btn').forEach(btn => {
    if (btn.dataset.layer === layer) {
      btn.className = 'layer-btn px-4 py-2 rounded-lg text-sm font-medium bg-blue-100 text-blue-700';
    } else {
      btn.className = 'layer-btn px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-500';
    }
  });

  // Toggle visibility
  document.querySelectorAll('[data-layer]').forEach(el => {
    if (el.tagName === 'BUTTON') return; // skip buttons
    const layers = el.dataset.layer.split(',');
    el.style.display = layers.includes(layer) ? '' : 'none';
    el.style.transition = 'opacity 0.3s ease';
  });
}

// Initialize
setLayer('summary');
```

Mark SVG groups with `data-layer`:
```html
<g data-layer="summary"><!-- Always visible in summary --></g>
<g data-layer="summary,detail"><!-- Visible in summary and detail --></g>
<g data-layer="detail,code"><!-- Only in detail and code views --></g>
<g data-layer="code"><!-- Only in code view --></g>
```

---

## 8. Export Buttons (PNG / SVG)

```html
<div class="flex gap-2 mt-4 justify-center">
  <button onclick="exportPNG()" class="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm hover:bg-slate-700">
    Export PNG
  </button>
  <button onclick="exportSVG()" class="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm hover:bg-slate-700">
    Export SVG
  </button>
</div>
```

```js
function exportPNG() {
  const svg = document.getElementById('diagram');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const data = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const svgBlob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    canvas.width = img.width * 2;
    canvas.height = img.height * 2;
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    const a = document.createElement('a');
    a.download = 'diagram.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  img.src = url;
}

function exportSVG() {
  const svg = document.getElementById('diagram');
  const data = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([data], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.download = 'diagram.svg';
  a.href = URL.createObjectURL(blob);
  a.click();
}
```

---

## 9. Dark Mode Toggle

```js
function toggleDarkMode() {
  const body = document.body;
  const isDark = body.classList.toggle('dark-mode');

  // Update SVG background
  const svg = document.getElementById('diagram');
  svg.style.backgroundColor = isDark ? '#0f172a' : '#ffffff';

  // Update CSS variables
  document.documentElement.style.setProperty('--c-bg', isDark ? '#0f172a' : '#ffffff');
  document.documentElement.style.setProperty('--c-text-body', isDark ? '#94a3b8' : '#64748b');
}
```

---

## 10. Copy Code Button (for Evidence Artifacts)

```js
function copyCode(codeId) {
  const codeEl = document.getElementById(codeId);
  const text = codeEl.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = codeEl.parentElement.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}
```

---

## 11. Keyboard Navigation

```js
// Add to all interactive elements
document.querySelectorAll('[data-interactive="true"]').forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.click();
    }
  });
});

// Tab focus styling
const style = document.createElement('style');
style.textContent = `
  [data-interactive="true"]:focus { outline: 2px solid var(--c-focus-ring); outline-offset: 2px; }
  [data-interactive="true"]:focus:not(:focus-visible) { outline: none; }
`;
document.head.appendChild(style);
```

---

## 12. Responsive SVG Container

```css
#diagram-container {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
}

#diagram {
  width: 100%;
  height: auto;
}

@media (max-width: 768px) {
  #diagram-container { padding: 1rem; }
  .detail-panel { width: 100% !important; }
}
```
