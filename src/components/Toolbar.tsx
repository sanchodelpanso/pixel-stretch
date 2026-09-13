import type { EditorTool } from '../types/editor';
import './Toolbar.css';

interface ToolbarProps {
  tool: EditorTool;
  onToolChange: (tool: EditorTool) => void;
  /** Selection tools need a model, and are disabled while one is loading. */
  disabled: boolean;
  layersOpen: boolean;
  onLayersClick: () => void;
}

/** Tools that don't need a segmentation model and stay live while one loads. */
const MODEL_FREE: EditorTool[] = ['move', 'stretch'];

interface ToolSpec {
  id: EditorTool;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const TOOLS: ToolSpec[] = [
  {
    id: 'move',
    label: 'Move',
    hint: 'Click a layer to select it, drag to reposition',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" />
      </svg>
    ),
  },
  {
    id: 'select-auto',
    label: 'Auto',
    hint: 'Detect the main subject of the active layer',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z" />
        <path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9L18 16z" />
      </svg>
    ),
  },
  {
    id: 'select-tap',
    label: 'Tap',
    hint: 'Click the object to select it, Alt-click to exclude',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9 11.5V5a1.8 1.8 0 013.6 0v6.5" />
        <path d="M12.6 11.5V10a1.8 1.8 0 013.6 0v1.5" />
        <path d="M16.2 11.8v-.6a1.8 1.8 0 013.6 0V16a5.5 5.5 0 01-5.5 5.5h-1.9a5 5 0 01-3.8-1.7l-3.3-3.9a1.8 1.8 0 012.6-2.4L9 15V5" />
      </svg>
    ),
  },
  {
    id: 'stretch',
    label: 'Stretch',
    hint: 'Draw a sample path; the main subject is lifted above the stretch automatically',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 3v18" />
        <path d="M10 6h10M10 12h10M10 18h10" strokeOpacity="0.55" />
        <path d="M17 3l4 3-4 3" strokeOpacity="0.55" />
      </svg>
    ),
  },
  {
    id: 'select-brush',
    label: 'Brush',
    hint: 'Paint roughly over the object, release to refine',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9.5 14.5L3 21s3.5.5 5-1 .5-4 .5-4" />
        <path d="M12 15l7.6-7.6a2.5 2.5 0 00-3.5-3.5L8.5 11.5" />
        <path d="M8.5 11.5L12 15" />
      </svg>
    ),
  },
];

export function Toolbar({ tool, onToolChange, disabled, layersOpen, onLayersClick }: ToolbarProps) {
  return (
    <nav className="toolbar">
      {TOOLS.map((spec) => {
        const isDisabled = disabled && !MODEL_FREE.includes(spec.id);
        return (
          <button
            key={spec.id}
            className={`tool-btn ${tool === spec.id && !layersOpen ? 'active' : ''}`}
            aria-pressed={tool === spec.id}
            title={`${spec.label} — ${spec.hint}`}
            disabled={isDisabled}
            onClick={() => onToolChange(spec.id)}
          >
            <span className="tool-icon">{spec.icon}</span>
            <span className="tool-label">{spec.label}</span>
          </button>
        );
      })}
      <button
        className={`tool-btn mobile-layers-button ${layersOpen ? 'active' : ''}`}
        aria-pressed={layersOpen}
        title="Layers and properties"
        onClick={onLayersClick}
      >
        <span className="tool-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 3L3 8l9 5 9-5-9-5z" />
            <path d="M3 12l9 5 9-5M3 16l9 5 9-5" />
          </svg>
        </span>
        <span className="tool-label">Layers</span>
      </button>
    </nav>
  );
}
