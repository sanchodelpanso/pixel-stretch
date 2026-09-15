import { useState, useCallback } from 'react';
import type { Layer, LayerDocument } from '../types/layer';
import { Icon } from './Icon';
import './LayersPanel.css';

interface LayersPanelProps {
  doc: LayerDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Layer>) => void;
  /** Patch without an undo entry — used while a slider is being dragged. */
  onPatchTransient: (id: string, patch: Partial<Layer>) => void;
  /** Snapshot for undo once, at the start of a slider drag. */
  onBeginHistory: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** Both indices are bottom-first stack positions. */
  onReorder: (from: number, to: number) => void;
}

export function LayersPanel({
  doc,
  selectedId,
  onSelect,
  onUpdate,
  onPatchTransient,
  onBeginHistory,
  onRename,
  onRemove,
  onDuplicate,
  onReorder,
}: LayersPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // A slider drag is one undo step, not one per input event.
  const [slidingOpacity, setSlidingOpacity] = useState(false);

  // The panel lists the topmost layer first; the document stores it last.
  const count = doc.layers.length;
  const displayed = [...doc.layers].reverse();
  const selected = doc.layers.find((l) => l.id === selectedId) ?? null;

  const commitDrag = useCallback(() => {
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      onReorder(count - 1 - dragIndex, count - 1 - dropIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [dragIndex, dropIndex, count, onReorder]);

  const startRename = useCallback((layer: Layer) => {
    setEditingId(layer.id);
    setDraftName(layer.name);
  }, []);

  const finishRename = useCallback(() => {
    if (editingId) onRename(editingId, draftName);
    setEditingId(null);
  }, [editingId, draftName, onRename]);

  return (
    <>
      <section className="panel-section layers-section">
        <div className="panel-section-title">
          Layers <span className="layers-count">{count}</span>
        </div>

        <div className="layers-list">
          {displayed.map((layer, i) => {
            const isSelected = layer.id === selectedId;
            return (
              <div
                key={layer.id}
                className={[
                  'layer-row',
                  isSelected ? 'selected' : '',
                  dropIndex === i && dragIndex !== null && dragIndex !== i ? 'drop-target' : '',
                  dragIndex === i ? 'dragging' : '',
                ].join(' ').trim()}
                draggable={editingId !== layer.id}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  commitDrag();
                }}
                onDragEnd={commitDrag}
                onClick={() => onSelect(layer.id)}
              >
                <button
                  className="layer-visibility"
                  title={layer.visible ? 'Hide layer' : 'Show layer'}
                  aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdate(layer.id, { visible: !layer.visible });
                  }}
                >
                  <Icon name={layer.visible ? 'eye' : 'eye-off'} size={20} />
                </button>

                <div className="layer-thumb">
                  <img src={layer.thumbnail} alt="" draggable={false} />
                </div>

                <div className="layer-meta">
                  {editingId === layer.id ? (
                    <input
                      className="layer-name-input"
                      value={draftName}
                      autoFocus
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={finishRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finishRename();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="layer-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(layer);
                      }}
                    >
                      {layer.name}
                    </span>
                  )}
                  <span className="layer-dims">
                    {layer.stretch && <span className="layer-kind">stretch</span>}
                    {layer.protectionSourceId && <span className="layer-kind">subject</span>}
                    {layer.width} × {layer.height}
                    {layer.opacity < 1 && ` · ${Math.round(layer.opacity * 100)}%`}
                  </span>
                </div>

                <button
                  className={`layer-lock ${layer.locked ? 'active' : ''}`}
                  title={layer.locked ? 'Unlock layer' : 'Lock layer'}
                  aria-label={layer.locked ? 'Unlock layer' : 'Lock layer'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdate(layer.id, { locked: !layer.locked });
                  }}
                >
                  <Icon name={layer.locked ? 'lock' : 'unlock'} size={18} />
                </button>

                <div className="mobile-layer-order" aria-label="Layer order">
                  <button
                    aria-label={`Move ${layer.name} up`}
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReorder(count - 1 - i, count - i);
                    }}
                  >
                    <Icon name="chevron-up" size={16} />
                  </button>
                  <button
                    aria-label={`Move ${layer.name} down`}
                    disabled={i === displayed.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReorder(count - 1 - i, count - 2 - i);
                    }}
                  >
                    <Icon name="chevron-down" size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {selected && (
        <section className="panel-section properties-section">
          <div className="panel-section-title">{selected.name}</div>

          <label className="property-row">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(selected.opacity * 100)}
              onPointerDown={() => {
                onBeginHistory();
                setSlidingOpacity(true);
              }}
              onPointerUp={() => setSlidingOpacity(false)}
              onChange={(e) => {
                const opacity = Number(e.target.value) / 100;
                if (slidingOpacity) onPatchTransient(selected.id, { opacity });
                else onUpdate(selected.id, { opacity });
              }}
            />
            <span className="property-value">{Math.round(selected.opacity * 100)}%</span>
          </label>

          <div className="property-row position-row">
            <span>Position</span>
            <span className="property-value">
              {selected.x}, {selected.y}
            </span>
          </div>

          <div className="layer-actions">
            <button onClick={() => onDuplicate(selected.id)}><Icon name="duplicate" size={18} />Duplicate</button>
            <button
              className="danger"
              disabled={count <= 1}
              onClick={() => onRemove(selected.id)}
            >
              <Icon name="delete" size={18} />Delete
            </button>
          </div>
        </section>
      )}
    </>
  );
}
