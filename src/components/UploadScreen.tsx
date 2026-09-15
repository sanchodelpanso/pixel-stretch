import { useCallback, useRef, useState } from 'react';
import type { RecentEntry } from '../project/recents';
import logo from '../assets/logo.png';
import './UploadScreen.css';

interface UploadScreenProps {
  onImageSelected: (file: File) => void;
  onProjectSelected: (file: File) => void;
  recents: RecentEntry[];
  showDemo: boolean;
  onOpenDemo: () => void;
  onOpenRecent: (entry: RecentEntry) => void;
  onRemoveRecent: (entry: RecentEntry) => void;
  isLoading: boolean;
  loadingStatus: string;
  loadProgress: number;
  /** Shown when the last file couldn't be opened. */
  error?: string | null;
}

/**
 * Whether a dropped file is worth handing to the decoder. HEICs often arrive
 * with an empty `type`, so an unlabelled file is judged by its extension
 * rather than rejected outright.
 */
function couldBeImage(file: File): boolean {
  if (file.type) return file.type.startsWith('image/');
  return /\.(heic|heif|jpe?g|png|webp|gif|bmp|avif|tiff?)$/i.test(file.name);
}

function couldBeProject(file: File): boolean {
  return /\.pixelstretch$/i.test(file.name);
}

function timeAgo(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString();
}

interface RecentSectionProps {
  title: string;
  entries: RecentEntry[];
  onOpen: (entry: RecentEntry) => void;
  onRemove: (entry: RecentEntry) => void;
}

function RecentSection({ title, entries, onOpen, onRemove }: RecentSectionProps) {
  if (entries.length === 0) return null;
  return (
    <section className="recent-section" aria-label={title}>
      <h2 className="recent-title">{title}</h2>
      <ul className="recent-grid">
        {entries.map((entry) => (
          <li key={entry.id} className="recent-card">
            <button className="recent-open" onClick={() => onOpen(entry)} title={`Open ${entry.name}`}>
              <img className="recent-thumb" src={entry.thumbnail} alt="" />
              <span className="recent-name">{entry.name}</span>
              <span className="recent-meta">
                {entry.kind === 'project'
                  ? `${entry.layerCount ?? 1} layer${entry.layerCount === 1 ? '' : 's'}`
                  : `${entry.width}×${entry.height}`}
                {' · '}
                {timeAgo(entry.updatedAt)}
              </span>
            </button>
            <button className="recent-remove" aria-label={`Remove ${entry.name} from recents`} title="Remove" onClick={() => onRemove(entry)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UploadScreen({
  onImageSelected, onProjectSelected, recents, showDemo, onOpenDemo, onOpenRecent, onRemoveRecent, isLoading, loadingStatus, loadProgress, error,
}: UploadScreenProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!isLoading && file) {
      if (couldBeProject(file)) onProjectSelected(file);
      else if (couldBeImage(file)) onImageSelected(file);
    }
  }, [onImageSelected, onProjectSelected, isLoading]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!isLoading && file) {
      onImageSelected(file);
    }
  }, [onImageSelected, isLoading]);

  const handleProjectChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!isLoading && file) onProjectSelected(file);
    // Allow choosing the same project again after an error.
    e.target.value = '';
  }, [isLoading, onProjectSelected]);

  return (
    <div className="upload-screen">
      <div className="upload-content">
        <img className="upload-logo" src={logo} alt="" width={76} height={76} />

        <h1 className="upload-title">PixelStretch</h1>
        <p className="upload-subtitle">
          Drop a photo. We'll find the subject —<br />
          then stretch the background behind it.
        </p>

        {isLoading ? (
          <div className="upload-loading">
            <div className="upload-progress-bar">
              <div
                className="upload-progress-fill"
                style={{ width: `${loadProgress * 100}%` }}
              />
            </div>
            <p className="upload-status">{loadingStatus}</p>
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                inputRef.current?.click();
              }
            }}
            className={`upload-dropzone ${isDragOver ? 'dragover' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => inputRef.current?.click()}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Drop an image or project here, or click to browse</span>
            <span className="upload-formats">JPEG · PNG · WebP · HEIC</span>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,.heic,.heif"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          </div>
        )}

        {error && !isLoading && <p className="upload-error">{error}</p>}

        {!isLoading && (
          <button className="upload-project-button" onClick={() => projectInputRef.current?.click()}>
            Open PixelStretch Project
          </button>
        )}
        <input
          ref={projectInputRef}
          type="file"
          accept=".pixelstretch,application/vnd.pixelstretch.project+json"
          onChange={handleProjectChange}
          hidden
        />

        {!isLoading && (
          <>
            {showDemo && (
              <button className="demo-card" onClick={onOpenDemo} aria-label="Open skate demo">
                <img src={`${import.meta.env.BASE_URL}skate_sample.webp`} alt="" width={96} height={120} />
                <span className="demo-card-copy">
                  <span className="demo-card-eyebrow">Try a demo</span>
                  <strong>Skate stretch</strong>
                  <span>Explore a ready-to-edit project.</span>
                  <span className="demo-card-action">Open demo <span aria-hidden="true">→</span></span>
                </span>
              </button>
            )}
            <RecentSection
              title="Recent projects"
              entries={recents.filter((entry) => entry.kind === 'project')}
              onOpen={onOpenRecent}
              onRemove={onRemoveRecent}
            />
            <RecentSection
              title="Recent images"
              entries={recents.filter((entry) => entry.kind === 'image')}
              onOpen={onOpenRecent}
              onRemove={onRemoveRecent}
            />
          </>
        )}
      </div>

      {/* Decorative monochrome background depth. */}
      <div className="upload-bg-orb upload-bg-orb-1" />
      <div className="upload-bg-orb upload-bg-orb-2" />
      <div className="upload-bg-orb upload-bg-orb-3" />
    </div>
  );
}
