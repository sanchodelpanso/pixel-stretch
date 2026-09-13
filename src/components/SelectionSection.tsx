import type { ExtractMode } from '../types/editor';

interface SelectionSectionProps {
  onExtract: (mode: ExtractMode) => void;
  onDeselect: () => void;
}

/** Shown while a selection mask exists on the active layer. */
export function SelectionSection({ onExtract, onDeselect }: SelectionSectionProps) {
  return (
    <section className="panel-section selection-section">
      <div className="panel-section-title">Selection</div>
      <div className="selection-actions">
        <button className="selection-btn primary" onClick={() => onExtract('copy')}>
          Copy to new layer
        </button>
        <button className="selection-btn" onClick={() => onExtract('cut')}>
          Cut to new layer
        </button>
      </div>
      <button className="selection-deselect" onClick={onDeselect}>
        Deselect
      </button>
    </section>
  );
}
