export default function RibbonTab(props) {
  return (
    <button
      class={`ribbon-tab${props.active ? ' active' : ''}${props.fileTab ? ' file-tab' : ''}`}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}
