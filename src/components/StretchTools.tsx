import { useEffect, useRef, useState } from 'react';
import type { StretchSpec, StretchStyle } from '../types/stretch';
import { DEFAULT_GRID_SIZE, MAX_GRID_SIZE, MIN_GRID_SIZE } from '../rendering/grid-texture';
import { Icon } from './Icon';
import './StretchTools.css';

export type StretchControl = 'transform' | 'edges' | 'colors';

const STYLE_LABELS: Record<StretchStyle, string> = { smooth: 'Smooth', pixel: 'Pixels', motion: 'Motion' };
const STYLE_ICONS = { smooth: 'smooth', pixel: 'pixels', motion: 'motion' } as const;

interface StretchToolsProps {
  spec: StretchSpec | null;
  bandMode: 'straight' | 'arc';
  control: StretchControl;
  hasSubject: boolean;
  /** Whether the band sits above its lifted subject rather than behind it. */
  overSubject: boolean;
  canDelete: boolean;
  onBandModeChange: (mode: 'straight' | 'arc') => void;
  onControlChange: (control: StretchControl) => void;
  onChange: (patch: Partial<StretchSpec>, transient: boolean) => void;
  /** Snapshot for undo before a continuous edit, such as a slider drag. */
  onBeginEdit: () => void;
  onOverSubjectChange: (over: boolean) => void;
  onEditPath: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function StretchTools({ spec, bandMode, control, hasSubject, overSubject, canDelete, onBandModeChange,
  onControlChange, onChange, onBeginEdit, onOverSubjectChange, onEditPath, onDuplicate, onDelete }: StretchToolsProps) {
  const [menu, setMenu] = useState<'shape' | 'style' | 'more' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setMenu(null);
      root.current?.querySelector<HTMLButtonElement>(`[data-menu="${menu}"]`)?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape, true);
    };
  }, [menu]);

  const style: StretchStyle = spec?.style ?? 'smooth';

  const chooseShape = (shape: 'straight' | 'arc') => {
    onBandModeChange(shape);
    onControlChange('transform');
    setMenu(null);
  };

  if (!spec) {
    return (
      <div className="stretch-tools stretch-shapes" role="group" aria-label="Band shape">
        {(['straight', 'arc'] as const).map((shape) => (
          <button key={shape} className={bandMode === shape ? 'selected' : ''} aria-pressed={bandMode === shape} onClick={() => chooseShape(shape)}>
            <Icon name={shape} size={20} /><span>{shape === 'arc' ? 'Arc' : 'Straight'}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div ref={root} className="stretch-tools" role="group" aria-label="Stretch tools">
      <div className="stretch-tool-buttons">
      <button className={`stretch-tool ${menu === 'shape' ? 'selected' : ''}`} data-menu="shape"
        aria-label="Band shape" aria-expanded={menu === 'shape'} aria-controls="stretch-shapes"
        onClick={() => setMenu(menu === 'shape' ? null : 'shape')}>
        <Icon name={bandMode} size={22} />
        <span>{bandMode === 'arc' ? 'Arc' : 'Straight'}<Icon name="chevron-down" size={12} /></span>
      </button>
      <button className={`stretch-tool ${menu === 'style' ? 'selected' : ''}`} data-menu="style"
        aria-label="Stretch style" aria-expanded={menu === 'style'} aria-controls="stretch-styles"
        onClick={() => setMenu(menu === 'style' ? null : 'style')}>
        <Icon name={STYLE_ICONS[style]} size={22} />
        <span>{STYLE_LABELS[style]}<Icon name="chevron-down" size={12} /></span>
      </button>
      <span className="stretch-tools-divider" />
      {bandMode === 'straight' && (
        <button className={`stretch-tool desktop-curve ${spec.warpMode === 'curved' && control === 'transform' ? 'selected' : ''}`}
          aria-label="Curve" aria-pressed={spec.warpMode === 'curved'} title="Shape the edges with curve handles"
          onClick={() => {
            onControlChange('transform');
            onChange({ warpMode: spec.warpMode === 'curved' ? 'straight' : 'curved', bend: 0 }, false);
          }}>
          <Icon name="curve" size={22} /><span>Curve</span>
        </button>
      )}
      <button className={`stretch-tool ${control === 'edges' ? 'selected' : ''}`} aria-label="Edit edges"
        aria-pressed={control === 'edges'} title={bandMode === 'arc' ? 'Add and edit points along the arc' : 'Remove or restore an edge'}
        onClick={() => onControlChange(control === 'edges' ? 'transform' : 'edges')}>
        <Icon name="edit-edges" size={22} /><span>Edges</span>
      </button>
      <button className={`stretch-tool ${control === 'colors' ? 'selected' : ''}`} aria-label="Colors"
        aria-pressed={control === 'colors'} title="Simplify colors and soften their transitions"
        onClick={() => onControlChange(control === 'colors' ? 'transform' : 'colors')}>
        <Icon name="colors" size={22} /><span>Colors</span>
      </button>
      <span className="stretch-tools-divider" />
      <button className={`stretch-tool ${menu === 'more' ? 'selected' : ''}`} data-menu="more"
        aria-label="More stretch actions" aria-expanded={menu === 'more'} aria-controls="stretch-more"
        onClick={() => setMenu(menu === 'more' ? null : 'more')}>
        <Icon name="more" size={22} /><span>More</span>
      </button>

      </div>
      {menu === 'shape' && (
        <div id="stretch-shapes" className="stretch-tools-menu shape-menu" role="group" aria-label="Band shape">
          {(['straight', 'arc'] as const).map((shape) => (
            <button key={shape} aria-pressed={bandMode === shape} onClick={() => chooseShape(shape)}>
              <Icon name={shape} size={21} /><span>{shape === 'arc' ? 'Arc' : 'Straight'}</span>
              {bandMode === shape && <Icon name="check" size={18} />}
            </button>
          ))}
          {bandMode === 'straight' && (
            <button className="mobile-curve" aria-label="Curve" aria-pressed={spec.warpMode === 'curved'}
              onClick={() => {
                onControlChange('transform');
                onChange({ warpMode: spec.warpMode === 'curved' ? 'straight' : 'curved', bend: 0 }, false);
                setMenu(null);
              }}>
              <Icon name="curve" size={21} /><span>Curved edges</span>
              {spec.warpMode === 'curved' && <Icon name="check" size={18} />}
            </button>
          )}
        </div>
      )}
      {menu === 'style' && (
        <div id="stretch-styles" className="stretch-tools-menu shape-menu" role="group" aria-label="Stretch style">
          {(['smooth', 'pixel', 'motion'] as const).map((option) => (
            <button key={option} aria-pressed={style === option} onClick={() => {
              // Opening the colours pad right away shows how to tune the new look.
              onControlChange('colors');
              if (option !== style) onChange({ style: option === 'smooth' ? undefined : option }, false);
            }}>
              <Icon name={STYLE_ICONS[option]} size={21} /><span>{STYLE_LABELS[option]}</span>
              {style === option && <Icon name="check" size={18} />}
            </button>
          ))}
          <span className="stretch-menu-divider" />
          <MenuSlider label="Grid texture" value={spec.gridTexture ?? 0}
            onBeginEdit={onBeginEdit} onInput={(v, transient) => onChange({ gridTexture: v || undefined }, transient)} />
          {(spec.gridTexture ?? 0) > 0 && (
            <>
              <MenuSlider label="Grid size" value={spec.gridSize ?? DEFAULT_GRID_SIZE}
                min={MIN_GRID_SIZE} max={MAX_GRID_SIZE} step={1} format={(v) => `${Math.round(v)} px`}
                onBeginEdit={onBeginEdit} onInput={(v, transient) => onChange({ gridSize: v }, transient)} />
              <div className="stretch-menu-segment" role="group" aria-label="Grid mode">
                {(['cut', 'lines'] as const).map((mode) => (
                  <button key={mode} aria-pressed={(spec.gridStyle ?? 'cut') === mode}
                    onClick={() => onChange({ gridStyle: mode === 'lines' ? 'lines' : undefined }, false)}>
                    {mode === 'lines' ? 'Grid only' : 'Cut lines'}
                  </button>
                ))}
              </div>
              {/* Grid-only lines always carry the stretch's own colours. */}
              {(spec.gridStyle ?? 'cut') === 'cut' && (
                <div className="stretch-menu-color">
                  <span>Line colour</span>
                  <button className="stretch-menu-swatch-none" aria-pressed={!spec.gridColor} title="Lines are see-through"
                    onClick={() => onChange({ gridColor: undefined }, false)}>None</button>
                  <input type="color" aria-label="Line colour" value={spec.gridColor ?? '#000000'}
                    onPointerDown={onBeginEdit}
                    onInput={(e) => onChange({ gridColor: (e.target as HTMLInputElement).value }, true)}
                    onChange={(e) => onChange({ gridColor: e.target.value }, true)} />
                </div>
              )}
            </>
          )}
          {style === 'motion' && (
            <>
              <span className="stretch-menu-divider" />
              <MenuSlider label="Fade in" value={spec.motionFadeIn ?? 0}
                onBeginEdit={onBeginEdit} onInput={(v, transient) => onChange({ motionFadeIn: v || undefined }, transient)} />
            </>
          )}
          {style === 'pixel' && (
            <>
              <span className="stretch-menu-divider" />
              <MenuSlider label="Soft edges" value={spec.pixelSoftness ?? 0}
                onBeginEdit={onBeginEdit} onInput={(v, transient) => onChange({ pixelSoftness: v || undefined }, transient)} />
              <MenuSlider label="Ragged start" value={spec.pixelStartScatter ?? 0}
                onBeginEdit={onBeginEdit} onInput={(v, transient) => onChange({ pixelStartScatter: v || undefined }, transient)} />
            </>
          )}
        </div>
      )}
      {menu === 'more' && (
        <div id="stretch-more" className="stretch-tools-menu more-menu" role="group" aria-label="More stretch actions">
          <button onClick={() => { setMenu(null); onEditPath(); }}><Icon name="edit-path" size={21} /><span>Edit path</span></button>
          {hasSubject && (
            <button aria-pressed={Boolean(spec.subjectOnly)} onClick={() => onChange({ subjectOnly: !spec.subjectOnly }, false)}>
              <Icon name="subject" size={21} /><span>Subject only</span>{spec.subjectOnly && <Icon name="check" size={18} />}
            </button>
          )}
          {hasSubject && (
            <button aria-pressed={overSubject} title="Lay the stretch over the lifted subject so it can dissolve into the streaks"
              onClick={() => onOverSubjectChange(!overSubject)}>
              <Icon name="over-subject" size={21} /><span>Over subject</span>{overSubject && <Icon name="check" size={18} />}
            </button>
          )}
          {hasSubject && !overSubject && (
            <MenuSlider label="Blend into subject" value={spec.edgeBlend ?? 0}
              onBeginEdit={onBeginEdit} onInput={(v, transient) => onChange({ edgeBlend: v || undefined }, transient)} />
          )}
          <span className="stretch-menu-divider" />
          <button onClick={() => { setMenu(null); onDuplicate(); }}><Icon name="duplicate" size={21} /><span>Duplicate</span></button>
          <button disabled={!canDelete} onClick={() => { setMenu(null); onDelete(); }}><Icon name="delete" size={21} /><span>Delete</span></button>
        </div>
      )}
    </div>
  );
}

/** A slider inside a tools menu, 0–100% unless given a range and format. A drag is one undo step; a tap or arrow key is its own. */
function MenuSlider({
  label, value, min = 0, max = 1, step = 0.01, format = (v) => `${Math.round(v * 100)}%`, onBeginEdit, onInput,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  onBeginEdit: () => void;
  onInput: (value: number, transient: boolean) => void;
}) {
  const dragging = useRef(false);
  return (
    <label className="stretch-menu-slider">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onPointerDown={() => { onBeginEdit(); dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        onChange={(e) => onInput(Number(e.target.value), dragging.current)}
      />
      <output>{format(value)}</output>
    </label>
  );
}
