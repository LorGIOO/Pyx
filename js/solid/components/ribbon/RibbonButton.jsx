import { Show } from 'solid-js';

// A ribbon button. With no `label` it renders as a compact icon-only square
// (used in the Word-style icon rows); with a label it's the normal large or
// small (size="small") button.
export default function RibbonButton(props) {
  const iconOnly = () => !props.label;
  return (
    <button
      class={`ribbon-btn${props.size === 'small' ? ' small' : ''}${iconOnly() ? ' icon-only' : ''}${props.active ? ' active' : ''}`}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class="ribbon-btn-icon" innerHTML={props.icon}></span>
      <Show when={props.label}><span class="ribbon-btn-label">{props.label}</span></Show>
    </button>
  );
}
