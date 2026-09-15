import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  name: string | null;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  exporting: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onExport: () => void;
  onExit: () => void;
  onResetView: () => void;
}

export function EditorMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  const action = (callback: () => void) => { setOpen(false); callback(); };
  return (
    <div className="editor-menu" ref={root}>
      <button ref={trigger} className={`stretch-tool ${open ? 'selected' : ''}`} aria-label="Project menu"
        aria-expanded={open} aria-controls="project-menu" onClick={() => setOpen(!open)}>
        <Icon name="menu" size={22} /><span>Menu</span>
      </button>
      {open && <div id="project-menu" className="stretch-tools-menu project-menu" role="group" aria-label="Project actions">
        {props.name && <div className="project-menu-name" title={props.name}>{props.name}</div>}
        <button disabled={!props.canUndo} onClick={props.onUndo}><Icon name="undo" /><span>Undo</span></button>
        <button disabled={!props.canRedo} onClick={props.onRedo}><Icon name="redo" /><span>Redo</span></button>
        <span className="stretch-menu-divider" />
        <button disabled={props.saving} onClick={() => action(props.onSave)}><Icon name="save" /><span>{props.saving ? 'Saving…' : 'Save project'}</span></button>
        <button disabled={props.exporting} onClick={() => action(props.onExport)}><Icon name="export" /><span>{props.exporting ? 'Exporting…' : 'Export PNG'}</span></button>
        <button onClick={() => action(props.onResetView)}><Icon name="fit" /><span>Center image</span></button>
        <span className="stretch-menu-divider" />
        <button onClick={() => action(props.onExit)}><Icon name="home" /><span>Back to home</span></button>
      </div>}
    </div>
  );
}
