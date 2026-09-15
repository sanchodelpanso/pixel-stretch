import { useState, useCallback, useEffect } from 'react';
import { loadImageFile } from './utils/image-utils';
import { decodeProject } from './project/project-file';
import {
  listRecents, loadRecentImage, loadRecentProject, projectNameFromFile, removeRecent, rememberImage,
  type RecentEntry,
} from './project/recents';
import { UploadScreen } from './components/UploadScreen';
import { EditorScreen, type EditorSource } from './components/EditorScreen';
import './App.css';

interface Session {
  source: EditorSource;
  name: string;
  recentProjectId: string | null;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [recentsReady, setRecentsReady] = useState(false);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('Opening image…');
  const [openError, setOpenError] = useState<string | null>(null);

  const refreshRecents = useCallback(() => {
    listRecents().then(setRecents, (err) => console.warn('Could not read recents:', err))
      .finally(() => setRecentsReady(true));
  }, []);

  // Re-read whenever the start screen comes back, so a save made in the editor shows up.
  useEffect(() => {
    if (!session) refreshRecents();
  }, [session, refreshRecents]);

  const openWith = useCallback(async (status: string, open: () => Promise<Session>) => {
    setIsLoadingImage(true);
    setLoadingStatus(status);
    setOpenError(null);
    try {
      setSession(await open());
    } catch (err) {
      console.error(`${status} failed:`, err);
      setOpenError(err instanceof Error ? err.message : 'Could not open that file.');
    } finally {
      setIsLoadingImage(false);
    }
  }, []);

  const openImageFile = useCallback((file: File, recentId?: string) => openWith('Opening image…', async () => {
    const image = await loadImageFile(file);
    // Only the untouched picture is remembered; edits live on until a project save.
    rememberImage(file, image, recentId).catch((err) => console.warn('Could not remember image:', err));
    return { source: { kind: 'image', image }, name: projectNameFromFile(file), recentProjectId: null };
  }), [openWith]);

  const handleProjectSelected = useCallback((file: File) => openWith('Opening project…', async () => {
    const project = await decodeProject(file);
    return { source: { kind: 'project', ...project }, name: projectNameFromFile(file), recentProjectId: null };
  }), [openWith]);

  const handleOpenDemo = useCallback(() => openWith('Opening skate demo…', async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}skate_sample.pixelstretch`);
    if (!response.ok) throw new Error('Could not load the skate demo. Please try again.');
    const project = await decodeProject(await response.blob());
    return { source: { kind: 'project', ...project }, name: 'Skate demo', recentProjectId: null };
  }), [openWith]);

  const handleOpenRecent = useCallback((entry: RecentEntry) => {
    if (entry.kind === 'image') {
      openWith('Opening image…', async () => {
        const file = await loadRecentImage(entry.id);
        const image = await loadImageFile(file);
        rememberImage(file, image, entry.id).catch((err) => console.warn('Could not remember image:', err));
        return { source: { kind: 'image', image }, name: entry.name, recentProjectId: null };
      });
    } else {
      openWith('Opening project…', async () => {
        const project = await loadRecentProject(entry.id);
        return { source: { kind: 'project', ...project }, name: entry.name, recentProjectId: entry.id };
      });
    }
  }, [openWith]);

  const handleRemoveRecent = useCallback((entry: RecentEntry) => {
    setRecents((current) => current.filter((item) => item.id !== entry.id));
    removeRecent(entry.id).catch((err) => console.warn('Could not remove recent:', err)).finally(refreshRecents);
  }, [refreshRecents]);

  return (
    <div className="app">
      {session ? (
        <EditorScreen
          source={session.source}
          name={session.name}
          recentProjectId={session.recentProjectId}
          onExit={() => setSession(null)}
        />
      ) : (
        <UploadScreen
          onImageSelected={(file) => openImageFile(file)}
          onProjectSelected={handleProjectSelected}
          recents={recents}
          showDemo={recentsReady && recents.length === 0}
          onOpenDemo={handleOpenDemo}
          onOpenRecent={handleOpenRecent}
          onRemoveRecent={handleRemoveRecent}
          isLoading={isLoadingImage}
          loadingStatus={loadingStatus}
          loadProgress={0}
          error={openError}
        />
      )}
    </div>
  );
}

export default App;
