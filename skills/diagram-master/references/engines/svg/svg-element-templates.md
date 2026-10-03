# SVG Element Templates

Copy-paste SVG + JS templates for each interactive element type. Always pull colors from `color-palette.md`.

---

## Interactive Rectangle (Process/Action Node)

```html
<g id="node-process-name" class="interactive-node" role="button" tabindex="0"
   aria-label="Process Name - click for details" data-interactive="true">
  <rect x="100" y="100" width="180" height="90" rx="8" ry="8"
        fill="var(--c-primary-fill)" stroke="var(--c-primary-stroke)" stroke-width="2"
        class="node-bg" />
  <text x="190" y="150" text-anchor="middle" dominant-baseline="central"
        fill="var(--c-text-on-light)" font-size="16" font-family="Inter, system-ui, sans-serif">
    Process Name
  </text>
</g>
```

### With hover + click JS:
```js
const node = document.getElementById('node-process-name');
node.addEventListener('mouseenter', () => {
  node.querySelector('.node-bg').style.filter = 'brightness(1.1) drop-shadow(0 0 8px var(--c-glow-primary))';
});
node.addEventListener('mouseleave', () => {
  node.querySelector('.node-bg').style.filter = '';
});
node.addEventListener('click', () => showDetail('process-name'));
node.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail('process-name'); }
});
```

---

## Decision Diamond

```html
<g id="node-decision-name" class="interactive-node" role="button" tabindex="0"
   aria-label="Decision: condition?" data-interactive="true">
  <polygon points="190,80 280,140 190,200 100,140"
           fill="var(--c-decision-fill)" stroke="var(--c-decision-stroke)" stroke-width="2"
           class="node-bg" />
  <text x="190" y="145" text-anchor="middle" dominant-baseline="central"
        fill="var(--c-text-on-light)" font-size="14" font-family="Inter, system-ui, sans-serif">
    Condition?
  </text>
</g>
```

---

## Start/Trigger Circle

```html
<g id="node-start" class="interactive-node" role="button" tabindex="0"
   aria-label="Start" data-interactive="true">
  <circle cx="60" cy="60" r="30"
          fill="var(--c-start-fill)" stroke="var(--c-start-stroke)" stroke-width="2"
          class="node-bg pulse-animation" />
  <text x="60" y="65" text-anchor="middle" dominant-baseline="central"
        fill="var(--c-start-stroke)" font-size="14" font-family="Inter, system-ui, sans-serif">
    Start
  </text>
</g>
```

### Pulse animation CSS:
```css
@keyframes pulse {
  0%, 100% { filter: drop-shadow(0 0 0px rgba(194, 65, 12, 0)); }
  50% { filter: drop-shadow(0 0 12px rgba(194, 65, 12, 0.4)); }
}
.pulse-animation { animation: pulse 2s ease-in-out infinite; }
```

---

## End/Success Circle

```html
<g id="node-end" aria-label="End/Success">
  <circle cx="60" cy="60" r="30"
          fill="var(--c-success-fill)" stroke="var(--c-success-stroke)" stroke-width="3"
          class="node-bg" />
  <text x="60" y="65" text-anchor="middle" dominant-baseline="central"
        fill="var(--c-success-stroke)" font-size="14" font-family="Inter, system-ui, sans-serif">
    Done
  </text>
</g>
```

---

## Animated Arrow (Flow Connection)

```html
<line x1="280" y1="145" x2="400" y2="145"
      stroke="var(--c-primary-stroke)" stroke-width="2"
      marker-end="url(#arrowhead)" class="flow-arrow" />
```

### Arrow marker definition (put in `<defs>`):
```html
<defs>
  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
    <polygon points="0 0, 10 3.5, 0 7" fill="var(--c-primary-stroke)" />
  </marker>
  <marker id="arrowhead-success" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
    <polygon points="0 0, 10 3.5, 0 7" fill="var(--c-success-stroke)" />
  </marker>
</defs>
```

### Animated dashed flow:
```html
<line x1="280" y1="145" x2="400" y2="145"
      stroke="var(--c-primary-stroke)" stroke-width="2" stroke-dasharray="8 4"
      marker-end="url(#arrowhead)" class="animated-flow" />
```

```css
@keyframes dash-flow {
  to { stroke-dashoffset: -24; }
}
.animated-flow { animation: dash-flow 2s linear infinite; }
```

---

## Curved Path Arrow

```html
<path d="M 280 145 C 340 80, 360 80, 400 145"
      fill="none" stroke="var(--c-primary-stroke)" stroke-width="2"
      marker-end="url(#arrowhead)" />
```

---

## Evidence Artifact (Code Snippet)

```html
<g id="evidence-snippet-1" class="evidence-artifact" role="button" tabindex="0"
   aria-label="Code example - click to expand" data-evidence="true">
  <rect x="100" y="300" width="280" height="80" rx="6" ry="6"
        fill="#1e293b" stroke="#334155" stroke-width="1" class="evidence-bg" />
  <text x="112" y="325" fill="#c084fc" font-size="12" font-family="'JetBrains Mono', monospace">
    const
  </text>
  <text x="150" y="325" fill="#60a5fa" font-size="12" font-family="'JetBrains Mono', monospace">
    result
  </text>
  <text x="195" y="325" fill="#f8fafc" font-size="12" font-family="'JetBrains Mono', monospace">
    = await
  </text>
  <text x="268" y="325" fill="#60a5fa" font-size="12" font-family="'JetBrains Mono', monospace">
    fetch
  </text>
  <text x="300" y="325" fill="#f8fafc" font-size="12" font-family="'JetBrains Mono', monospace">
    (url);
  </text>
  <!-- "Click to expand" hint -->
  <text x="112" y="368" fill="#64748b" font-size="10" font-family="Inter, system-ui, sans-serif">
    Click to expand...
  </text>
</g>
```

---

## Evidence Artifact (JSON Data)

```html
<g id="evidence-json-1" class="evidence-artifact" role="button" tabindex="0"
   aria-label="JSON payload - click to expand" data-evidence="true">
  <rect x="100" y="400" width="260" height="70" rx="6" ry="6"
        fill="#1e293b" stroke="#334155" stroke-width="1" class="evidence-bg" />
  <text x="112" y="425" fill="#22c55e" font-size="12" font-family="'JetBrains Mono', monospace">
    { "event": "STATE_DELTA",
  </text>
  <text x="112" y="445" fill="#22c55e" font-size="12" font-family="'JetBrains Mono', monospace">
      "payload": { ... } }
  </text>
</g>
```

---

## Tooltip (Hidden by Default)

```html
<g id="tooltip" class="tooltip" style="display:none; pointer-events:none;">
  <rect x="0" y="0" width="200" height="40" rx="4" ry="4"
        fill="#1e293b" stroke="#334155" stroke-width="1" opacity="0.95" />
  <text x="10" y="25" fill="#f1f5f9" font-size="13" font-family="Inter, system-ui, sans-serif"
        id="tooltip-text">
    Tooltip text here
  </text>
</g>
```

### Tooltip JS:
```js
function showTooltip(evt, text) {
  const tooltip = document.getElementById('tooltip');
  const tooltipText = document.getElementById('tooltip-text');
  tooltipText.textContent = text;

  const bbox = tooltipText.getBBox();
  tooltip.querySelector('rect').setAttribute('width', bbox.width + 20);

  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());

  tooltip.setAttribute('transform', `translate(${svgPt.x + 10}, ${svgPt.y - 50})`);
  tooltip.style.display = '';
}

function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}
```

---

## Free-Floating Label (Title)

```html
<text x="100" y="50" fill="#1e40af" font-size="24" font-weight="700"
      font-family="Inter, system-ui, sans-serif">
  Diagram Title
</text>
```

## Free-Floating Label (Subtitle)

```html
<text x="100" y="80" fill="#3b82f6" font-size="18" font-weight="500"
      font-family="Inter, system-ui, sans-serif">
  Section Subtitle
</text>
```

## Free-Floating Label (Body/Detail)

```html
<text x="100" y="100" fill="#64748b" font-size="14"
      font-family="Inter, system-ui, sans-serif">
  Description or annotation
</text>
```

---

## Small Marker Dot

```html
<circle cx="100" cy="100" r="6" fill="#3b82f6" stroke="#1e3a5f" stroke-width="1" />
```

---

## Structural Line (Divider)

```html
<line x1="0" y1="250" x2="800" y2="250"
      stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4 4" />
```

---

## Section Group

```html
<g id="section-name" aria-label="Section: Name">
  <!-- Background region (optional) -->
  <rect x="80" y="60" width="400" height="300" rx="12" ry="12"
        fill="#f8fafc" stroke="#e2e8f0" stroke-width="1" opacity="0.5" />
  <!-- Section title -->
  <text x="100" y="90" fill="#1e40af" font-size="18" font-weight="600"
        font-family="Inter, system-ui, sans-serif">
    Section Name
  </text>
  <!-- Section contents go here -->
</g>
```

---

## Expandable/Collapsible Group

```html
<g id="expandable-group" class="expandable" role="button" tabindex="0"
   aria-label="Click to expand" aria-expanded="false" data-interactive="true">
  <!-- Header (always visible) -->
  <rect x="100" y="100" width="200" height="40" rx="6" ry="6"
        fill="var(--c-primary-fill)" stroke="var(--c-primary-stroke)" stroke-width="2" />
  <text x="120" y="125" fill="var(--c-text-on-light)" font-size="14"
        font-family="Inter, system-ui, sans-serif">
    ▶ Module Name
  </text>
  <!-- Detail (hidden by default) -->
  <g id="expandable-group-detail" style="display:none;">
    <!-- Child elements -->
  </g>
</g>
```

### Expand/Collapse JS:
```js
document.querySelectorAll('.expandable').forEach(group => {
  group.addEventListener('click', () => {
    const detail = group.querySelector('[id$="-detail"]');
    const expanded = group.getAttribute('aria-expanded') === 'true';
    detail.style.display = expanded ? 'none' : '';
    group.setAttribute('aria-expanded', !expanded);
    const label = group.querySelector('text');
    label.textContent = label.textContent.replace(/[▶▼]/, expanded ? '▶' : '▼');
  });
});
```

---

## AI/LLM Node

```html
<g id="node-llm" class="interactive-node" role="button" tabindex="0"
   aria-label="LLM Processing" data-interactive="true">
  <rect x="100" y="100" width="200" height="100" rx="12" ry="12"
        fill="var(--c-ai-fill)" stroke="var(--c-ai-stroke)" stroke-width="2"
        class="node-bg" />
  <text x="200" y="140" text-anchor="middle" dominant-baseline="central"
        fill="var(--c-ai-stroke)" font-size="16" font-weight="600"
        font-family="Inter, system-ui, sans-serif">
    LLM
  </text>
  <text x="200" y="165" text-anchor="middle" dominant-baseline="central"
        fill="var(--c-text-body)" font-size="12"
        font-family="Inter, system-ui, sans-serif">
    Claude Opus 4.6
  </text>
</g>
```
