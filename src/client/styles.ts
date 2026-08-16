const STYLE_ID = 'dsh-seismicx-workbench'

const css = String.raw`
.sx-root {
  --sx-accent: var(--dsw-alias-brand-primary, #4f7bd9);
  --sx-accent-soft: color-mix(in srgb, var(--sx-accent) 11%, transparent);
  height: 100%;
  width: 100%;
  max-width: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  container-type: inline-size;
  color: var(--dsw-alias-label-primary, #252a33);
  background: var(--dsw-alias-bg-base, #f7f8fa);
  font-family: var(--dsw-font-family, system-ui, sans-serif);
}

.sx-root,
.sx-root * {
  box-sizing: border-box;
}

.sx-shell {
  width: 100%;
  max-width: 1460px;
  min-width: 0;
  margin: 0 auto;
  padding: 22px 26px 38px;
}

.sx-header,
.sx-heading,
.sx-conversation-state,
.sx-notice,
.sx-panel-actions,
.sx-section-heading,
.sx-status-value,
.sx-check,
.sx-running {
  display: flex;
  align-items: center;
}

.sx-header {
  justify-content: space-between;
  gap: 20px;
  padding: 3px 0 19px;
}

.sx-heading { gap: 11px; }

.sx-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid color-mix(in srgb, var(--sx-accent) 24%, transparent);
  border-radius: 11px;
  color: var(--sx-accent);
  background: var(--sx-accent-soft);
}

.sx-title {
  margin: 0;
  font-size: 20px;
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -.02em;
}

.sx-subtitle {
  margin: 3px 0 0;
  color: var(--dsw-alias-label-tertiary, #737b88);
  font-size: 12px;
}

.sx-conversation-state {
  flex: none;
  gap: 7px;
  color: var(--dsw-alias-label-secondary, #555d69);
  font-size: 12px;
}

.sx-alert,
.sx-notice {
  min-height: 38px;
  margin-bottom: 14px;
  padding: 9px 12px;
  border: 1px solid var(--dsw-alias-border-subtle, #dfe2e8);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.45;
}

.sx-alert {
  color: var(--dsw-alias-label-error, #b53a43);
  background: var(--dsw-alias-bg-error-subtle, #fff4f4);
}

.sx-notice {
  gap: 7px;
  color: var(--dsw-alias-label-success, #24764f);
  background: var(--dsw-alias-bg-success-subtle, #f1faf5);
}

.sx-layout {
  display: grid;
  grid-template-columns: 310px minmax(0, 1fr);
  gap: 17px;
  align-items: start;
  min-width: 0;
}

.sx-sidebar,
.sx-panel {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-subtle, #dfe2e8);
  border-radius: 13px;
  background: var(--dsw-alias-bg-layer-1, #fff);
}

.sx-sidebar {
  position: sticky;
  top: 16px;
}

.sx-side-section { padding: 17px; }

.sx-side-section + .sx-side-section {
  border-top: 1px solid var(--dsw-alias-border-subtle, #e3e5e9);
}

.sx-section-heading { justify-content: space-between; gap: 12px; }

.sx-section-title,
.sx-panel-title {
  margin: 0;
  font-size: 14px;
  line-height: 1.35;
  font-weight: 650;
}

.sx-field {
  display: grid;
  gap: 7px;
  margin-top: 13px;
}

.sx-field label,
.sx-label {
  color: var(--dsw-alias-label-secondary, #555d69);
  font-size: 12px;
  font-weight: 600;
}

.sx-path-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.sx-path-row > :first-child {
  flex: 1;
  min-width: 0;
}

.sx-select {
  width: 100%;
  height: 36px;
  padding: 0 32px 0 10px;
  color: var(--dsw-alias-label-primary, #252a33);
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
  border: 1px solid var(--dsw-alias-border-l2, #d5d9e0);
  border-radius: 9px;
  font: inherit;
  font-size: 13px;
  outline: none;
}

.sx-select:focus-visible {
  border-color: var(--sx-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--sx-accent) 20%, transparent);
}

.sx-phases {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.sx-actions {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 8px;
  margin-top: 16px;
}

.sx-actions button,
.sx-handoff {
  width: 100%;
  justify-content: center;
}

.sx-status-list {
  display: grid;
  gap: 9px;
  margin-top: 12px;
}

.sx-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.sx-status-value {
  gap: 7px;
  color: var(--dsw-alias-label-secondary, #555d69);
}

.sx-status-idle {
  width: 8px;
  height: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #cbd0d8);
  border-radius: 50%;
}

.sx-checks {
  display: grid;
  gap: 8px;
  margin-top: 13px;
  padding-top: 13px;
  border-top: 1px solid var(--dsw-alias-border-subtle, #e3e5e9);
}

.sx-check {
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, #737b88);
  font-size: 11px;
}

.sx-check span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sx-main {
  display: grid;
  gap: 17px;
  min-width: 0;
}

.sx-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 53px;
  padding: 0 16px;
  border-bottom: 1px solid var(--dsw-alias-border-subtle, #e3e5e9);
}

.sx-panel-actions { gap: 8px; min-width: 0; }

.sx-panel-meta {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, #737b88);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sx-table-wrap {
  width: 100%;
  max-width: 100%;
  max-height: 310px;
  overflow: auto;
}

.sx-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.sx-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 36px;
  padding: 0 13px;
  color: var(--dsw-alias-label-tertiary, #737b88);
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.sx-table td {
  height: 40px;
  max-width: 260px;
  padding: 0 13px;
  overflow: hidden;
  border-top: 1px solid var(--dsw-alias-border-subtle, #e6e8ec);
  color: var(--dsw-alias-label-secondary, #555d69);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sx-table tbody tr:hover td {
  background: var(--dsw-alias-interactive-bg-hover, #f4f5f7);
}

.sx-mono {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}

.sx-empty,
.sx-running {
  min-height: 142px;
  padding: 26px;
  color: var(--dsw-alias-label-tertiary, #737b88);
  font-size: 12px;
  text-align: center;
}

.sx-empty {
  display: grid;
  place-items: center;
}

.sx-running {
  justify-content: center;
  gap: 8px;
}

.sx-empty-error { color: var(--dsw-alias-label-error, #b53a43); }

.sx-run-error {
  max-height: 150px;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  border-top: 1px solid var(--dsw-alias-border-subtle, #e3e5e9);
  color: var(--dsw-alias-label-error, #b53a43);
  background: var(--dsw-alias-bg-error-subtle, #fff4f4);
  font: 11px/1.55 var(--dsw-font-mono, ui-monospace, monospace);
  white-space: pre-wrap;
}

.sx-waveform-preview {
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 220px;
  padding: 12px;
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
}

.sx-waveform-preview img {
  display: block;
  width: 100%;
  max-height: 520px;
  object-fit: contain;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fff);
}

.sx-map-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  min-width: 0;
  min-height: 300px;
}

.sx-map-fields {
  min-width: 0;
  padding: 4px 16px 16px;
  border-right: 1px solid var(--dsw-alias-border-subtle, #e3e5e9);
}

.sx-map-fields > button { margin-top: 14px; }

.sx-map-preview {
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 300px;
  padding: 14px;
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
}

.sx-map-preview img {
  display: block;
  width: 100%;
  max-height: 480px;
  object-fit: contain;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fff);
}

.sx-map-empty {
  gap: 5px;
  align-content: center;
}

.sx-map-empty strong {
  color: var(--dsw-alias-label-secondary, #555d69);
  font-weight: 600;
}

.sx-map-empty span {
  color: var(--dsw-alias-label-tertiary, #737b88);
}

.sx-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@container (max-width: 980px) {
  .sx-layout { grid-template-columns: 270px minmax(0, 1fr); }
  .sx-map-layout { grid-template-columns: 1fr; }
  .sx-map-fields { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-subtle, #e3e5e9); }
}

@container (max-width: 720px) {
  .sx-shell { padding: 16px 12px 30px; }
  .sx-layout { grid-template-columns: 1fr; }
  .sx-sidebar { position: static; }
  .sx-subtitle { display: none; }
  .sx-panel-header { align-items: flex-start; min-height: 0; padding: 12px 13px; }
  .sx-panel-actions { flex-wrap: wrap; justify-content: flex-end; }
}

@container (max-width: 460px) {
  .sx-header { align-items: flex-start; flex-wrap: wrap; }
  .sx-conversation-state { margin-left: 49px; }
  .sx-actions { grid-template-columns: 1fr; }
}
`

export function installStyles(): () => void {
  const prior = document.querySelector<HTMLStyleElement>(`style[data-style-id="${STYLE_ID}"]`)
  if (prior !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.styleId = STYLE_ID
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}
