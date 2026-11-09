import { Show } from 'solid-js';

// A ribbon button. With no `label` it renders as a compact icon-only square
// (used in the Word-style icon rows); with a label it's the normal large or
// small (size="small") button.
//
// The label doubles as the tooltip and the accessible name when no `title` is
// given: on a narrow window the adaptive ribbon hides the text of labelled
// buttons (ribbonLayout.js), and "Pegar", "Cortar", "Copiar" and "Buscar" —
// which never had a title — would be left as four anonymous icons.
export default function RibbonButton(props) {
  const iconOnly = () => !props.label;
  return (
    <button
      class={`ribbon-btn${props.size === 'small' ? ' small' : ''}${iconOnly() ? ' icon-only' : ''}${props.active ? ' active' : ''}${props.busy ? ' busy' : ''}`}
      title={props.title || props.label}
      aria-label={props.label || props.title}
      aria-description={props.label && props.title ? props.title : undefined}
      aria-busy={props.busy ? 'true' : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class="ribbon-btn-icon" innerHTML={props.icon}></span>
      <Show when={props.label}><span class="ribbon-btn-label">{props.label}</span></Show>
    </button>
  );
}
