import { useState, useCallback } from 'react';
import type { SourceImage } from './types/image';
import { loadImageFile } from './utils/image-utils';
import { decodeProject, type LoadedProject } from './project/project-file';
import { UploadScreen } from './components/UploadScreen';
import { EditorScreen } from './components/EditorScreen';
import './App.css';

function App() {
  const [image, setImage] = useState<SourceImage | null>(null);
  const [project, setProject] = useState<LoadedProject | null>(null);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('Opening image…');
  const [openError, setOpenError] = useState<string | null>(null);

  const handleImageSelected = useCallback(async (file: File) => {
    setIsLoadingImage(true);
    setLoadingStatus('Opening image…');
    setOpenError(null);
    try {
      setImage(await loadImageFile(file));
      setProject(null);
    } catch (err) {
      console.error('Failed to load image:', err);
      setOpenError(err instanceof Error ? err.message : 'Could not open that file.');
    } finally {
      setIsLoadingImage(false);
    }
  }, []);

  const handleProjectSelected = useCallback(async (file: File) => {
    setIsLoadingImage(true);
    setLoadingStatus('Opening project…');
    setOpenError(null);
    try {
      setProject(await decodeProject(file));
      setImage(null);
    } catch (err) {
      console.error('Failed to open project:', err);
      setOpenError(err instanceof Error ? err.message : 'Could not open that project.');
    } finally {
      setIsLoadingImage(false);
    }
  }, []);

  return (
    <div className="app">
      {image || project ? (
        <EditorScreen source={project ? { kind: 'project', ...project } : { kind: 'image', image: image! }} />
      ) : (
        <UploadScreen
          onImageSelected={handleImageSelected}
          onProjectSelected={handleProjectSelected}
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
