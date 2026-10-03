# Color Palette & Brand Style

**This is the single source of truth for all colors and brand-specific styles.** To customize diagrams for your own brand, edit this file — everything else in the skill is universal.

All colors are defined as CSS custom properties in the HTML base template. Reference them as `var(--color-name)` in your SVG and CSS.

---

## Shape Colors (Semantic)

Colors encode meaning, not decoration. Each semantic purpose has a fill/stroke pair.

| Semantic Purpose | Fill | Stroke | CSS Variable Prefix |
|------------------|------|--------|---------------------|
| Primary/Neutral | `#3b82f6` | `#1e3a5f` | `--c-primary` |
| Secondary | `#60a5fa` | `#1e3a5f` | `--c-secondary` |
| Tertiary | `#93c5fd` | `#1e3a5f` | `--c-tertiary` |
| Start/Trigger | `#fed7aa` | `#c2410c` | `--c-start` |
| End/Success | `#a7f3d0` | `#047857` | `--c-success` |
| Warning/Reset | `#fee2e2` | `#dc2626` | `--c-warning` |
| Decision | `#fef3c7` | `#b45309` | `--c-decision` |
| AI/LLM | `#ddd6fe` | `#6d28d9` | `--c-ai` |
| Inactive/Disabled | `#dbeafe` | `#1e40af` | `--c-inactive` |
| Error | `#fecaca` | `#b91c1c` | `--c-error` |

**Rule**: Always pair a darker stroke with a lighter fill for contrast.

---

## Interactive State Colors

These colors apply when elements are hovered, clicked, or selected.

| State | Effect | CSS Property |
|-------|--------|--------------|
| Hover | Fill lightens 10%, stroke intensifies, subtle glow | `filter: brightness(1.1); drop-shadow(0 0 6px var(--glow-color))` |
| Active/Pressed | Fill darkens 5%, scale 0.98 | `filter: brightness(0.95); transform: scale(0.98)` |
| Selected/Focus | 2px ring in Primary stroke color | `outline: 2px solid #3b82f6; outline-offset: 2px` |
| Glow (connection highlight) | Soft radial glow behind element | `filter: drop-shadow(0 0 12px rgba(59,130,246,0.4))` |
| Fade (non-selected) | Opacity 0.3 | `opacity: 0.3` |
| Connected highlight | Stroke brightens, fill slightly saturates | `filter: saturate(1.3) brightness(1.05)` |

### Glow Colors by Semantic Purpose

| Semantic Purpose | Glow Color (rgba) |
|------------------|-------------------|
| Primary | `rgba(59, 130, 246, 0.4)` |
| Start/Trigger | `rgba(194, 65, 12, 0.3)` |
| Success | `rgba(4, 120, 87, 0.3)` |
| Warning | `rgba(220, 38, 38, 0.3)` |
| Decision | `rgba(180, 83, 9, 0.3)` |
| AI/LLM | `rgba(109, 40, 217, 0.4)` |

---

## Text Colors (Hierarchy)

| Level | Color | Use For |
|-------|-------|---------|
| Title | `#1e40af` | Section headings, major labels |
| Subtitle | `#3b82f6` | Subheadings, secondary labels |
| Body/Detail | `#64748b` | Descriptions, annotations, metadata |
| On light fills | `#374151` | Text inside light-colored shapes |
| On dark fills | `#ffffff` | Text inside dark-colored shapes |
| Link/Interactive | `#2563eb` | Clickable text, underlined on hover |

---

## Evidence Artifact Colors

Used for code snippets, data examples, and other concrete evidence.

| Artifact | Background | Text Color | Border |
|----------|-----------|------------|--------|
| Code snippet | `#1e293b` | Syntax-colored | `#334155` |
| JSON/data example | `#1e293b` | `#22c55e` (green) | `#334155` |
| Modal overlay | `rgba(0,0,0,0.5)` | — | — |
| Modal content | `#ffffff` | `#1e293b` | `#e2e8f0` |
| Copy button | `#334155` | `#94a3b8` | — |
| Copy button (hover) | `#475569` | `#e2e8f0` | — |

### Syntax Highlighting Colors (for code evidence)

| Token Type | Color |
|-----------|-------|
| Keyword | `#c084fc` (purple) |
| String | `#86efac` (green) |
| Number | `#fbbf24` (amber) |
| Comment | `#64748b` (slate) |
| Function | `#60a5fa` (blue) |
| Type | `#22d3ee` (cyan) |
| Operator | `#f8fafc` (white) |

---

## Animation Colors & Timing

| Animation | Duration | Easing | Color |
|-----------|----------|--------|-------|
| Flow arrow dash | `2s` | `linear` | Arrow stroke color |
| Hover transition | `0.3s` | `ease` | — |
| Modal appear | `0.2s` | `ease-out` | — |
| Pulse (start node) | `2s` | `ease-in-out` | Start fill color at 50% opacity |
| Glow pulse | `1.5s` | `ease-in-out` | Semantic glow color |
| Expand/collapse | `0.3s` | `ease` | — |

---

## Default Stroke & Line Colors

| Element | Color |
|---------|-------|
| Arrows | Source element's stroke color |
| Structural lines | Primary stroke (`#1e3a5f`) or Slate (`#64748b`) |
| Marker dots (fill + stroke) | Primary fill (`#3b82f6`) |
| Grid lines (if shown) | `#f1f5f9` |
| Divider lines | `#e2e8f0` |

---

## Dark Mode Colors

| Property | Light Mode | Dark Mode |
|----------|-----------|-----------|
| Background | `#ffffff` | `#0f172a` |
| Card background | `#ffffff` | `#1e293b` |
| Text primary | `#1e293b` | `#f1f5f9` |
| Text secondary | `#64748b` | `#94a3b8` |
| Border | `#e2e8f0` | `#334155` |
| SVG background | `#ffffff` | `#0f172a` |

---

## Background

| Property | Value |
|----------|-------|
| Canvas background (light) | `#ffffff` |
| Canvas background (dark) | `#0f172a` |
| Toolbar background | `#f8fafc` |
| Toolbar border | `#e2e8f0` |

---

## CSS Custom Properties Template

```css
:root {
  /* Semantic fills */
  --c-primary-fill: #3b82f6;
  --c-primary-stroke: #1e3a5f;
  --c-secondary-fill: #60a5fa;
  --c-tertiary-fill: #93c5fd;
  --c-start-fill: #fed7aa;
  --c-start-stroke: #c2410c;
  --c-success-fill: #a7f3d0;
  --c-success-stroke: #047857;
  --c-warning-fill: #fee2e2;
  --c-warning-stroke: #dc2626;
  --c-decision-fill: #fef3c7;
  --c-decision-stroke: #b45309;
  --c-ai-fill: #ddd6fe;
  --c-ai-stroke: #6d28d9;
  --c-error-fill: #fecaca;
  --c-error-stroke: #b91c1c;

  /* Text */
  --c-text-title: #1e40af;
  --c-text-subtitle: #3b82f6;
  --c-text-body: #64748b;
  --c-text-on-light: #374151;
  --c-text-on-dark: #ffffff;

  /* Evidence */
  --c-evidence-bg: #1e293b;
  --c-evidence-border: #334155;
  --c-evidence-text: #22c55e;

  /* Interactive */
  --c-glow-primary: rgba(59, 130, 246, 0.4);
  --c-focus-ring: #3b82f6;
  --c-fade-opacity: 0.3;

  /* Background */
  --c-bg: #ffffff;
  --c-bg-toolbar: #f8fafc;
}
```
