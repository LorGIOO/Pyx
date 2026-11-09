import { onMount, onCleanup, useContext } from 'solid-js';
import { RibbonLayoutContext } from './ribbonLayout.js';
import { createAnchoredPopup } from '../createAnchoredPopup.js';
import { icons } from './icons.js';

// One labelled group of the ribbon.
//
//   id      names the group in its tab's reduction order (ribbonLayout.js)
//   icon    what the group shows when it is collapsed to a single button
//   medium  "rows": at the medium size its big buttons become rows with the
//           text beside the icon (a group of ONLY big buttons has nothing
//           else to give)
//
// The size itself is not a prop: ribbonLayout.js writes `data-size` on the
// element while it measures, several times within one frame, and a reactive
// prop would be a frame late for that.
export default function RibbonGroup(props) {
  const layout = useContext(RibbonLayoutContext);
  let groupEl;
  let contentEl;
  let labelEl;
  let popBodyEl;

  // Collapsed, the group opens in a popover. The popover does not get a copy
  // of the buttons: it borrows the SAME node, so everything in it stays live
  // (the compile button's state, what a dropdown remembers, disabled flags)
  // without the tab having to render its group twice.
  const giveBack = () => {
    if (contentEl && groupEl && contentEl.parentNode !== groupEl) groupEl.insertBefore(contentEl, labelEl);
  };
  const pop = createAnchoredPopup({
    onOpen: () => popBodyEl.insertBefore(contentEl, popBodyEl.firstChild),
    onClose: () => {
      giveBack();
      // Whatever changed width while it was out is measured now.
      if (layout) layout.schedule();
    },
  });

  onMount(() => {
    if (!layout || !props.id) return;
    onCleanup(layout.register({
      id: props.id, el: groupEl, content: contentEl, isOpen: pop.open, close: pop.close,
    }));
  });
  // Before Solid removes the group (tab switch), the node is back where Solid
  // put it. (The popup hook closes itself on cleanup too; this covers the
  // order in which the two run.)
  onCleanup(giveBack);

  // A command was chosen: the popover has done its job. Opening a dropdown
  // inside it has not — that is a step on the way to a command.
  const onPopClick = (e) => {
    const t = e.target;
    if (!t.closest || t.closest('.ribbon-dd-caret')) return;
    // After the click's own handlers: Solid delegates those to the document,
    // which this native listener (`on:click`) runs ahead of. It has to be a
    // native one — a dropdown removes its menu while handling the pick, and a
    // delegated handler up here would never be reached from a detached item.
    if (t.closest('.ribbon-btn, .ribbon-dd-item')) {
      setTimeout(pop.close, 0);
    } else if (t.closest('.ribbon-dd-main')) {
      // The main half repeats the last pick — or, with none yet, opens the menu.
      setTimeout(() => { if (!popBodyEl.querySelector('.ribbon-dd.open')) pop.close(); }, 0);
    }
  };

  return (
    <div class="ribbon-group" ref={groupEl} data-group={props.id} data-medium={props.medium}>
      <button
        class="ribbon-btn ribbon-group-collapsed"
        classList={{ active: pop.open() }}
        ref={pop.anchor}
        title={props.label}
        aria-haspopup="true"
        aria-expanded={pop.open() ? 'true' : 'false'}
        onClick={pop.toggle}
      >
        <span class="ribbon-btn-icon" innerHTML={props.icon || icons.ellipsis}></span>
        <span class="ribbon-btn-label">{props.label || ''}</span>
        <span class="ribbon-collapsed-chevron" innerHTML={icons.chevronDown}></span>
      </button>
      <div class="ribbon-group-content" ref={contentEl}>{props.children}</div>
      <div class="ribbon-group-label" ref={labelEl}>{props.label || ''}</div>
      <div
        class="ribbon-popover"
        classList={{ open: pop.open() }}
        ref={pop.popup}
        style={pop.style()}
        on:click={onPopClick}
      >
        <div class="ribbon-popover-body" ref={popBodyEl}>
          <div class="ribbon-group-label">{props.label || ''}</div>
        </div>
      </div>
    </div>
  );
}
